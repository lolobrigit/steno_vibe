import type { Segment } from '@/types'

export interface DiarizedSegment {
  start: number
  end: number
  speaker: string
}

type WorkerEvent =
  | { type: 'status'; text: string }
  | { type: 'load-progress'; file: string; progress: number }
  | { type: 'load-total'; progress: number }
  | { type: 'progress'; pct: number }
  | { type: 'ready' }
  | { type: 'result'; segments: DiarizedSegment[] }
  | { type: 'error'; message: string }

export interface DiarizeCallbacks {
  onStatus?: (text: string) => void
  onLoadProgress?: (file: string, pct: number) => void
  /** агрегированный процент скачивания всех файлов (pyannote; WeSpeaker) */
  onLoadTotal?: (pct: number) => void
  /** процент самой диаризации (анализ окон → отпечатки → кластеризация) */
  onProgress?: (pct: number) => void
}

let worker: Worker | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/diarize.worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

/**
 * Локальная диаризация: pyannote segmentation + WeSpeaker-эмбеддинги +
 * кластеризация. Всё в браузере, аудио никуда не отправляется.
 */
export function diarizeLocal(
  audio: Float32Array,
  cb: DiarizeCallbacks = {},
): Promise<DiarizedSegment[]> {
  const w = getWorker()
  activeCount++
  return new Promise<DiarizedSegment[]>((resolve, reject) => {
    const onMsg = (ev: MessageEvent<WorkerEvent>) => {
      const m = ev.data
      if (m.type === 'status') cb.onStatus?.(m.text)
      if (m.type === 'load-progress') cb.onLoadProgress?.(m.file, m.progress)
      if (m.type === 'load-total') cb.onLoadTotal?.(m.progress)
      if (m.type === 'progress') cb.onProgress?.(m.pct)
      if (m.type === 'result') {
        w.removeEventListener('message', onMsg)
        resolve(m.segments)
      }
      if (m.type === 'error') {
        w.removeEventListener('message', onMsg)
        // wedged worker не переиспользуем — следующий вызов создаст свежий
        resetDiarizeWorker()
        reject(new Error(m.message))
      }
    }
    w.addEventListener('message', onMsg)
    const copy = new Float32Array(audio)
    w.postMessage({ type: 'diarize', audio: copy }, [copy.buffer])
  }).finally(() => {
    activeCount = Math.max(0, activeCount - 1)
  })
}

/** Принудительно убить worker (после ошибки/таймаута WASM-рантайм может быть сломан). */
export function resetDiarizeWorker(): void {
  try {
    worker?.terminate()
  } catch {
    /* ignore */
  }
  worker = null
}

/** Пометка загруженности: нужна Home, чтобы не показывать «ГОТОВ», пока диаризация ещё идёт. */
export function isDiarizeBusy(): boolean {
  return activeCount > 0
}

let activeCount = 0

/** Предзагрузка моделей диаризации (pyannote + WeSpeaker) из окна настроек. */
export function preloadDiarizeModels(cb: DiarizeCallbacks = {}): Promise<void> {
  const w = getWorker()
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<WorkerEvent>) => {
      const m = ev.data
      if (m.type === 'status') cb.onStatus?.(m.text)
      if (m.type === 'load-progress') cb.onLoadProgress?.(m.file, m.progress)
      if (m.type === 'load-total') cb.onLoadTotal?.(m.progress)
      if (m.type === 'ready') {
        w.removeEventListener('message', onMsg)
        resolve()
      }
      if (m.type === 'error') {
        w.removeEventListener('message', onMsg)
        resetDiarizeWorker()
        reject(new Error(m.message))
      }
    }
    w.addEventListener('message', onMsg)
    w.postMessage({ type: 'load' })
  })
}

/**
 * Приклеивает спикеров к сегментам транскрипта по максимальному временному
 * пересечению с диаризованной дорожкой. Без пересечения — наследуем
 * предыдущего спикера (паузы/мусор между репликами).
 */
export function assignSpeakers(segments: Segment[], dia: DiarizedSegment[]): Segment[] {
  if (dia.length === 0) return segments
  let prev: string | undefined
  return segments.map((s) => {
    let best: string | undefined
    let bestOverlap = 0
    for (const d of dia) {
      if (d.start >= s.end) break
      if (d.end <= s.start) continue
      const overlap = Math.min(s.end, d.end) - Math.max(s.start, d.start)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = d.speaker
      }
    }
    const speaker = best ?? prev
    prev = speaker
    return speaker ? { ...s, speaker } : { ...s }
  })
}
