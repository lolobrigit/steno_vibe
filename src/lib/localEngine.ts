import type { Segment } from '@/types'
import { t } from '@/i18n'
import { abortError, detectGpu, hasWebGPU } from './gpu'
import { prepareModel, whisperVariants, type Variant } from './modelPlan'

export { hasWebGPU }

type WorkerEvent =
  | { type: 'progress'; pct: number }
  | { type: 'ready'; device?: string }
  | { type: 'result'; text: string; segments: Segment[]; elapsedSec: number }
  | { type: 'cancelled' }
  | { type: 'error'; stage: 'load' | 'transcribe'; message: string }

export interface LocalEngineCallbacks {
  /** этап подготовки: скачивание файлов или инициализация (с устройством) */
  onStage?: (stage: 'storage' | 'download' | 'init', device: 'webgpu' | 'wasm') => void
  /** процент самого распознавания (по обработанным чанкам), 0..99 */
  onProgress?: (pct: number) => void
}

let worker: Worker | null = null
let device: string | null = null
/** отклонить промисы, ждущие ответа воркера, который мы убили */
const pendingRejects = new Set<(e: unknown) => void>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

/** Жёстко остановить воркер (отмена, зависший рантайм). Модель поднимется заново из кэша. */
export function resetWhisperWorker(): void {
  try {
    worker?.terminate()
  } catch {
    /* ignore */
  }
  worker = null
  for (const reject of [...pendingRejects]) reject(abortError())
  pendingRejects.clear()
}

export function deviceLabel(d: string | null): string {
  return d === 'wasm' ? 'CPU · WASM' : 'WebGPU'
}

export function localDeviceLabel(): string {
  return deviceLabel(device ?? (hasWebGPU() ? 'webgpu' : 'wasm'))
}

/** id задачи менеджера загрузок для модели — общий с окном настроек. */
export function modelJobId(repo: string): string {
  return `model:${repo}`
}

function workerLoad(repo: string, variant: Variant): Promise<void> {
  const w = getWorker()
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      w.removeEventListener('message', onMsg)
      pendingRejects.delete(reject)
    }
    const onMsg = (ev: MessageEvent<WorkerEvent>) => {
      const m = ev.data
      if (m.type === 'ready') {
        device = m.device ?? variant.device
        done()
        resolve()
      } else if (m.type === 'error' && m.stage === 'load') {
        done()
        reject(new Error(m.message))
      }
    }
    pendingRejects.add(reject)
    w.addEventListener('message', onMsg)
    w.postMessage({ type: 'load', modelId: repo, device: variant.device, dtype: variant.dtype })
  })
}

/**
 * Подготовить модель: докачать файлы подходящего варианта (с докачкой и
 * паузой — см. lib/downloads.ts) и поднять её в воркере. Прогресс скачивания
 * виден через менеджер загрузок по modelJobId(repo).
 */
export async function loadLocalModel(
  model: { hfId: string; label: string; needsWebGPU?: boolean },
  cb: LocalEngineCallbacks = {},
  signal?: AbortSignal,
): Promise<void> {
  const gpu = await detectGpu()
  const onAbort = () => resetWhisperWorker()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await prepareModel({
      jobId: modelJobId(model.hfId),
      label: model.label,
      repo: model.hfId,
      variants: whisperVariants(!!model.needsWebGPU, gpu),
      signal,
      onStage: (stage, v) => cb.onStage?.(stage, v.device),
      load: (v) => workerLoad(model.hfId, v),
    })
  } catch (e) {
    if (signal?.aborted) throw abortError()
    throw e instanceof Error && e.message
      ? new Error(t('err.modelLoad', { detail: e.message }))
      : new Error(t('err.modelLoad', { detail: '' }))
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Сколько ждём, пока воркер сам остановится между чанками, прежде чем убить его. */
const SOFT_CANCEL_MS = 4000

export function transcribeLocal(
  audio: Float32Array,
  language: string | null,
  task: 'transcribe' | 'translate',
  cb: LocalEngineCallbacks,
  initialPrompt?: string,
  signal?: AbortSignal,
): Promise<{ text: string; segments: Segment[]; elapsedSec: number }> {
  const w = getWorker()
  return new Promise((resolve, reject) => {
    let killTimer = 0
    const done = () => {
      w.removeEventListener('message', onMsg)
      signal?.removeEventListener('abort', onAbort)
      pendingRejects.delete(rejectAll)
      window.clearTimeout(killTimer)
    }
    const rejectAll = (e: unknown) => {
      done()
      reject(e)
    }
    const onAbort = () => {
      // мягкая отмена: воркер остановится на границе 30-секундного чанка и
      // сохранит загруженную модель; не успел — убиваем воркер целиком
      w.postMessage({ type: 'cancel' })
      killTimer = window.setTimeout(() => resetWhisperWorker(), SOFT_CANCEL_MS)
    }
    const onMsg = (ev: MessageEvent<WorkerEvent>) => {
      const m = ev.data
      if (m.type === 'progress') cb.onProgress?.(m.pct)
      else if (m.type === 'result') {
        done()
        resolve({ text: m.text, segments: m.segments, elapsedSec: m.elapsedSec })
      } else if (m.type === 'cancelled') {
        done()
        reject(abortError())
      } else if (m.type === 'error' && m.stage === 'transcribe') {
        done()
        reject(new Error(m.message))
      }
    }
    pendingRejects.add(rejectAll)
    w.addEventListener('message', onMsg)
    if (signal?.aborted) {
      done()
      reject(abortError())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const copy = new Float32Array(audio) // transferable копия
    w.postMessage({ type: 'transcribe', audio: copy, language, task, initialPrompt }, [copy.buffer])
  })
}
