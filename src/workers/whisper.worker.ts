// Web Worker: локальный Whisper через transformers.js (ONNX Runtime Web).
// Аудио не покидает устройство: модель скачивается с Hugging Face и
// исполняется локально (WebGPU, иначе WASM).

import { pipeline, env } from '@huggingface/transformers'

env.allowLocalModels = false

type Device = 'webgpu' | 'wasm'
type Dtype =
  | 'fp32'
  | 'fp16'
  | 'q8'
  | 'q4'
  | Record<string, 'auto' | 'fp16' | 'q4' | 'fp32' | 'q8' | 'int8' | 'uint8' | 'bnb4' | 'q4f16' | 'q2' | 'q2f16' | 'q1' | 'q1f16'>

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> }>

let transcriber: Transcriber | null = null
let loadedModelId: string | null = null
// параллельные 'load' (транскрипция + предзагрузка из настроек) ждут друг
// друга вместо двойного скачивания и двойной компиляции сессии
let loadInFlight: Promise<{ pipe: Transcriber; device: Device }> | null = null

interface LoadMsg {
  type: 'load'
  modelId: string
  preferWebGPU: boolean
}

interface RunMsg {
  type: 'transcribe'
  audio: Float32Array
  language: string | null
  task: 'transcribe' | 'translate'
  /** справочник терминов: подсказка словаря для декодера */
  initialPrompt?: string
}

type InMsg = LoadMsg | RunMsg

function post(msg: unknown, transfer?: Transferable[]) {
  ;(self as unknown as Worker).postMessage(msg, transfer ?? [])
}

async function createPipeline(modelId: string, preferWebGPU: boolean) {
  const attempts: Array<{ device: Device; dtype: Dtype }> = []

  if (preferWebGPU) {
    attempts.push(
      { device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } },
      { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' } },
    )
  }
  attempts.push(
    { device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
    { device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
    { device: 'wasm', dtype: 'fp32' },
  )

  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      post({ type: 'status', text: `Загрузка модели (${attempt.device === 'webgpu' ? 'WebGPU' : 'CPU/WASM'})…` })
      const pipe = await pipeline('automatic-speech-recognition', modelId, {
        device: attempt.device,
        dtype: attempt.dtype,
        progress_callback: (p: {
          status: string
          file?: string
          progress?: number
          loaded?: number
          total?: number
        }) => {
          if (p.status === 'progress_total') {
            // агрегат по байтам всех скачиваемых файлов модели
            post({ type: 'load-total', progress: Math.round(p.progress ?? 0) })
          } else if (p.status === 'progress' && p.file) {
            post({
              type: 'load-progress',
              file: p.file,
              progress: Math.round(p.progress ?? 0),
              loaded: p.loaded ?? 0,
              total: p.total ?? 0,
            })
          }
        },
      })
      return { pipe: pipe as unknown as Transcriber, device: attempt.device }
    } catch (e) {
      lastError = e
      // пробуем следующую конфигурацию
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Не удалось загрузить модель')
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data

  if (msg.type === 'load') {
    try {
      if (transcriber && loadedModelId === msg.modelId) {
        post({ type: 'ready', cached: true })
        return
      }
      // уже идёт загрузка (возможно, другой модели) — дожидаемся её конца
      if (loadInFlight) {
        try {
          await loadInFlight
        } catch {
          /* чужая ошибка — попробуем сами ниже */
        }
        if (transcriber && loadedModelId === msg.modelId) {
          post({ type: 'ready', cached: true })
          return
        }
      }
      transcriber = null
      loadedModelId = null
      loadInFlight = createPipeline(msg.modelId, msg.preferWebGPU)
      const { pipe, device } = await loadInFlight
      transcriber = pipe
      loadedModelId = msg.modelId
      post({ type: 'ready', device })
    } catch (e) {
      post({ type: 'error', stage: 'load', message: e instanceof Error ? e.message : String(e) })
    } finally {
      loadInFlight = null
    }
    return
  }

  if (msg.type === 'transcribe') {
    if (!transcriber) {
      post({ type: 'error', stage: 'transcribe', message: 'Модель не загружена' })
      return
    }
    try {
      const t0 = performance.now()
      // Процента «из коробки» в pipeline нет: оборачиваем model.generate —
      // он вызывается ровно один раз на 30-секундный чанк (см. _call_whisper
      // в transformers.js). Число чанков считаем по той же формуле:
      // window=30с, stride=5с с каждой стороны → шаг 20с.
      const total = msg.audio.length
      const WINDOW = 30 * 16000
      const JUMP = 20 * 16000
      const totalChunks = total <= WINDOW ? 1 : Math.ceil((total - WINDOW) / JUMP) + 1
      const modelRef = (
        transcriber as unknown as {
          model: { generate: (...a: unknown[]) => Promise<unknown> }
        }
      ).model
      const origGenerate = modelRef.generate.bind(modelRef)
      let chunksDone = 0
      modelRef.generate = async (...a: unknown[]) => {
        try {
          return await origGenerate(...a)
        } finally {
          chunksDone++
          post({
            type: 'progress',
            pct: Math.min(99, Math.round((chunksDone / totalChunks) * 100)),
          })
        }
      }
      let out: { text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> }
      try {
        out = await transcriber(msg.audio, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: true,
          language: msg.language,
          task: msg.task,
          // справочник терминов: Whisper использует как словарную подсказку
          ...(msg.initialPrompt ? { initial_prompt: msg.initialPrompt } : {}),
        })
      } finally {
        modelRef.generate = origGenerate
      }
      const segments = (out.chunks ?? [])
        .map((c) => ({
          start: c.timestamp[0] ?? 0,
          end: c.timestamp[1] ?? c.timestamp[0] ?? 0,
          text: (c.text ?? '').trim(),
        }))
        .filter((s) => s.text.length > 0)
      post({
        type: 'result',
        text: out.text.trim(),
        segments,
        elapsedSec: (performance.now() - t0) / 1000,
      })
    } catch (e) {
      post({ type: 'error', stage: 'transcribe', message: e instanceof Error ? e.message : String(e) })
    }
  }
}
