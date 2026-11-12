// Обёртка над ai.worker.ts — локальная LLM (Qwen3) в браузере.

import { t } from '@/i18n'
import { abortError, detectGpu } from './gpu'
import { llmVariants, prepareModel, type Variant } from './modelPlan'

type WorkerEvent =
  | { type: 'generating' }
  | { type: 'gen-progress'; pct: number }
  | { type: 'ready' }
  | { type: 'result'; output: string; elapsedSec: number }
  | { type: 'error'; message: string }

export interface LocalAiCallbacks {
  /** этап: скачивание файлов, инициализация модели, генерация */
  onStage?: (stage: 'storage' | 'download' | 'init' | 'generate', device?: 'webgpu' | 'wasm') => void
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

function resetAiWorker() {
  try {
    worker?.terminate()
  } catch {
    /* ignore */
  }
  worker = null
}

/** id задачи менеджера загрузок для LLM — общий с окном настроек. */
export function llmJobId(modelId: string): string {
  return `model:${modelId}`
}

function workerLoad(modelId: string, v: Variant): Promise<void> {
  const w = getWorker()
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<WorkerEvent>) => {
      const m = ev.data
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
    w.postMessage({ type: 'load', modelId, device: v.device, dtype: v.dtype })
  })
}

/**
 * Генерирует ответ локальной модели. Файлы докачиваются менеджером загрузок,
 * отмена (signal) убивает воркер — модель поднимется заново из кэша.
 */
export async function runLocalAi(
  prompt: string,
  text: string,
  model: { id: string; label: string },
  cb: LocalAiCallbacks = {},
  signal?: AbortSignal,
): Promise<string> {
  const gpu = await detectGpu()
  const onAbort = () => resetAiWorker()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const variant = await prepareModel({
      jobId: llmJobId(model.id),
      label: model.label,
      repo: model.id,
      variants: llmVariants(gpu),
      signal,
      onStage: (stage, v) => cb.onStage?.(stage, v.device),
      load: (v) => workerLoad(model.id, v),
    })
    const w = getWorker()
    return await new Promise<string>((resolve, reject) => {
      const done = () => {
        w.removeEventListener('message', onMsg)
        signal?.removeEventListener('abort', onGenAbort)
      }
      const onGenAbort = () => {
        done()
        reject(abortError())
      }
      const onMsg = (ev: MessageEvent<WorkerEvent>) => {
        const m = ev.data
        if (m.type === 'generating') cb.onStage?.('generate', variant.device)
        if (m.type === 'gen-progress') cb.onProgress?.(m.pct)
        if (m.type === 'result') {
          done()
          resolve(m.output)
        }
        if (m.type === 'error') {
          done()
          reject(new Error(m.message === 'empty' ? t('err.aiEmpty') : m.message))
        }
      }
      w.addEventListener('message', onMsg)
      signal?.addEventListener('abort', onGenAbort, { once: true })
      w.postMessage({
        type: 'generate',
        prompt,
        text,
        modelId: model.id,
        device: variant.device,
        dtype: variant.dtype,
      })
    })
  } catch (e) {
    if (signal?.aborted) throw abortError()
    throw e
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
