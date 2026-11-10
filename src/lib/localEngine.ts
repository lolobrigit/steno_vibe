import type { LoadProgress, Segment } from '@/types'

type WorkerEvent =
  | { type: 'status'; text: string }
  | { type: 'load-progress'; file: string; progress: number; loaded: number; total: number }
  | { type: 'load-total'; progress: number }
  | { type: 'progress'; pct: number }
  | { type: 'ready'; cached?: boolean; device?: string }
  | { type: 'result'; text: string; segments: Segment[]; elapsedSec: number }
  | { type: 'error'; stage: 'load' | 'transcribe'; message: string }

export interface LocalEngineCallbacks {
  onStatus?: (text: string) => void
  onLoadProgress?: (p: LoadProgress) => void
  /** агрегированный процент скачивания всех файлов модели (по байтам) */
  onLoadTotal?: (pct: number) => void
  /** процент самого распознавания (по обработанным чанкам), 0..99 */
  onProgress?: (pct: number) => void
}

let worker: Worker | null = null
let device: string | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

export function localDeviceLabel(): string {
  if (device === 'webgpu') return 'WebGPU'
  if (device === 'wasm') return 'CPU · WASM'
  return hasWebGPU() ? 'WebGPU' : 'CPU · WASM'
}

export function loadLocalModel(
  modelId: string,
  cb: LocalEngineCallbacks,
): Promise<void> {
  const w = getWorker()
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<WorkerEvent>) => {
      const m = ev.data
      if (m.type === 'status') cb.onStatus?.(m.text)
      if (m.type === 'load-progress') cb.onLoadProgress?.(m)
      if (m.type === 'load-total') cb.onLoadTotal?.(m.progress)
      if (m.type === 'ready') {
        device = m.device ?? null
        w.removeEventListener('message', onMsg)
        resolve()
      }
      if (m.type === 'error') {
        w.removeEventListener('message', onMsg)
        reject(new Error(m.message))
      }
    }
    w.addEventListener('message', onMsg)
    w.postMessage({ type: 'load', modelId, preferWebGPU: hasWebGPU() })
  })
}

export function transcribeLocal(
  audio: Float32Array,
  language: string | null,
  task: 'transcribe' | 'translate',
  cb: LocalEngineCallbacks,
  initialPrompt?: string,
): Promise<{ text: string; segments: Segment[]; elapsedSec: number }> {
  const w = getWorker()
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<WorkerEvent>) => {
      const m = ev.data
      if (m.type === 'status') cb.onStatus?.(m.text)
      if (m.type === 'progress') cb.onProgress?.(m.pct)
      if (m.type === 'result') {
        w.removeEventListener('message', onMsg)
        resolve({ text: m.text, segments: m.segments, elapsedSec: m.elapsedSec })
      }
      if (m.type === 'error') {
        w.removeEventListener('message', onMsg)
        reject(new Error(m.message))
      }
    }
    w.addEventListener('message', onMsg)
    const copy = new Float32Array(audio) // transferable копия
    w.postMessage({ type: 'transcribe', audio: copy, language, task, initialPrompt }, [copy.buffer])
  })
}
