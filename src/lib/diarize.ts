import type { Segment } from '@/types'
import { startDownload } from './downloads'
import { abortError } from './gpu'
import { DIARIZE_JOB_ID, diarizeFiles } from './modelPlan'

export interface DiarizedSegment {
  start: number
  end: number
  speaker: string
}

type WorkerEvent =
  | { type: 'status'; code: string }
  | { type: 'progress'; pct: number }
  | { type: 'ready' }
  | { type: 'result'; segments: DiarizedSegment[] }
  | { type: 'error'; message: string }

export interface DiarizeCallbacks {
  /** этап: скачивание моделей или анализ аудио */
  onStage?: (stage: 'download' | 'analyze') => void
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
 * Докачать модели диаризации (pyannote + WeSpeaker, ~45 МБ) менеджером
 * загрузок. Без сети и без сохранённого списка файлов молча выходим: воркер
 * возьмёт модели из кэша или скачает сам.
 */
export async function ensureDiarizeModels(signal?: AbortSignal): Promise<void> {
  let files
  try {
    files = await diarizeFiles()
  } catch {
    return
  }
  await startDownload(DIARIZE_JOB_ID, 'pyannote + WeSpeaker', files, { immediate: true, signal })
}

/**
 * Локальная диаризация: pyannote segmentation + WeSpeaker-эмбеддинги +
 * кластеризация. Всё в браузере, аудио никуда не отправляется.
 * Отмена (signal) убивает воркер: прервать WASM-инференс иначе нельзя.
 */
export async function diarizeLocal(
  audio: Float32Array,
  cb: DiarizeCallbacks = {},
  signal?: AbortSignal,
): Promise<DiarizedSegment[]> {
  cb.onStage?.('download')
  await ensureDiarizeModels(signal)
  if (signal?.aborted) throw abortError()
  cb.onStage?.('analyze')
  const w = getWorker()
  return new Promise<DiarizedSegment[]>((resolve, reject) => {
    const done = () => {
      w.removeEventListener('message', onMsg)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      done()
      resetDiarizeWorker()
      reject(abortError())
    }
    const onMsg = (ev: MessageEvent<WorkerEvent>) => {
      const m = ev.data
      if (m.type === 'progress') cb.onProgress?.(m.pct)
      if (m.type === 'result') {
        done()
        resolve(m.segments)
      }
      if (m.type === 'error') {
        done()
        // wedged worker не переиспользуем — следующий вызов создаст свежий
        resetDiarizeWorker()
        reject(new Error(m.message))
      }
    }
    w.addEventListener('message', onMsg)
    signal?.addEventListener('abort', onAbort, { once: true })
    const copy = new Float32Array(audio)
    w.postMessage({ type: 'diarize', audio: copy }, [copy.buffer])
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
