// Обёртка над ai.worker.ts — локальная LLM (Qwen3-1.7B) в браузере.

type WorkerEvent =
  | { type: 'status'; text: string }
  | { type: 'load-progress'; file: string; progress: number }
  | { type: 'load-total'; progress: number }
  | { type: 'gen-progress'; pct: number }
  | { type: 'ready' }
  | { type: 'result'; output: string; elapsedSec: number }
  | { type: 'error'; message: string }

export interface LocalAiCallbacks {
  onStatus?: (text: string) => void
  onLoadProgress?: (file: string, pct: number) => void
  /** агрегированный процент скачивания всех файлов модели (по байтам) */
  onLoadTotal?: (pct: number) => void
  /** процент генерации ответа (токены/лимит) */
  onProgress?: (pct: number) => void
}

let worker: Worker | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/ai.worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

/** Предзагрузка локальной AI-модели из окна настроек. */
export function preloadLocalAi(preferWebGPU: boolean, modelId: string, cb: LocalAiCallbacks = {}): Promise<void> {
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
        reject(new Error(m.message))
      }
    }
    w.addEventListener('message', onMsg)
    w.postMessage({ type: 'load', preferWebGPU, modelId })
  })
}

/** Генерирует ответ локальной модели. Модель качается один раз и кэшируется. */
export function runLocalAi(
  prompt: string,
  text: string,
  preferWebGPU: boolean,
  modelId: string,
  cb: LocalAiCallbacks = {},
): Promise<string> {
  const w = getWorker()
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<WorkerEvent>) => {
      const m = ev.data
      if (m.type === 'status') cb.onStatus?.(m.text)
      if (m.type === 'load-progress') cb.onLoadProgress?.(m.file, m.progress)
      if (m.type === 'load-total') cb.onLoadTotal?.(m.progress)
      if (m.type === 'gen-progress') cb.onProgress?.(m.pct)
      if (m.type === 'result') {
        w.removeEventListener('message', onMsg)
        resolve(m.output)
      }
      if (m.type === 'error') {
        w.removeEventListener('message', onMsg)
        reject(new Error(m.message))
      }
    }
    w.addEventListener('message', onMsg)
    w.postMessage({ type: 'generate', prompt, text, preferWebGPU, modelId })
  })
}
