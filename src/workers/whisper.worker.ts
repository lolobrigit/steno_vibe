// Web Worker: локальный Whisper через transformers.js (ONNX Runtime Web).
// Аудио не покидает устройство. Файлы модели к моменту 'load' уже лежат в
// кэше (их скачивает менеджер загрузок в главном потоке), а вариант
// «устройство + квантизация» приходит в сообщении — см. lib/modelPlan.ts.
// Воркер не формирует текстов для интерфейса: наружу уходят только коды.

import { segmentsFromWords } from '../lib/transcript'
import type { Segment } from '../types'
import { pipeline, env } from '@huggingface/transformers'

env.allowLocalModels = false

type Device = 'webgpu' | 'wasm'

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> }>

let transcriber: Transcriber | null = null
let loadedKey: string | null = null
// параллельные 'load' ждут друг друга вместо двойной компиляции сессии
let loadInFlight: Promise<Transcriber> | null = null
let cancelRequested = false

const CANCELLED = '__cancelled__'

interface LoadMsg {
  type: 'load'
  modelId: string
  device: Device
  dtype: string | Record<string, string>
}

interface RunMsg {
  type: 'transcribe'
  audio: Float32Array
  language: string | null
  task: 'transcribe' | 'translate'
  /** справочник терминов: подсказка словаря для декодера */
  initialPrompt?: string
  /** пословные метки: реплики собираются из слов; при ошибке — обычный режим */
  wordTimestamps?: boolean
}

type InMsg = LoadMsg | RunMsg | { type: 'cancel' }

function post(msg: unknown) {
  ;(self as unknown as Worker).postMessage(msg)
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data

  if (msg.type === 'cancel') {
    cancelRequested = true
    return
  }

  if (msg.type === 'load') {
    const key = `${msg.modelId}|${msg.device}|${JSON.stringify(msg.dtype)}`
    try {
      if (loadInFlight) await loadInFlight.catch(() => undefined)
      if (transcriber && loadedKey === key) {
        post({ type: 'ready', device: msg.device })
        return
      }
      transcriber = null
      loadedKey = null
      loadInFlight = pipeline('automatic-speech-recognition', msg.modelId, {
        device: msg.device,
        dtype: msg.dtype as never,
      }) as unknown as Promise<Transcriber>
      transcriber = await loadInFlight
      loadedKey = key
      post({ type: 'ready', device: msg.device })
    } catch (e) {
      post({ type: 'error', stage: 'load', message: e instanceof Error ? e.message : String(e) })
    } finally {
      loadInFlight = null
    }
    return
  }

  if (msg.type === 'transcribe') {
    if (!transcriber) {
      post({ type: 'error', stage: 'transcribe', message: 'model not loaded' })
      return
    }
    cancelRequested = false
    try {
      const t0 = performance.now()
      // Процента «из коробки» в pipeline нет: оборачиваем model.generate —
      // он вызывается ровно один раз на 30-секундный чанк. Число чанков
      // считаем по той же формуле: window=30с, stride=5с с каждой стороны
      // → шаг 20с. Здесь же точка отмены: между чанками проверяем флаг.
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
        if (cancelRequested) throw new Error(CANCELLED)
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
      let wordSegments: Segment[] | null = null
      const run = (ts: true | 'word') =>
        transcriber!(msg.audio, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: ts,
          language: msg.language,
          task: msg.task,
          // справочник терминов: Whisper использует как словарную подсказку
          ...(msg.initialPrompt ? { initial_prompt: msg.initialPrompt } : {}),
        }) as Promise<typeof out>
      try {
        if (msg.wordTimestamps) {
          try {
            out = await run('word')
            const words = (out.chunks ?? [])
              .map((c) => ({
                text: (c.text ?? '').trim(),
                start: c.timestamp[0] ?? 0,
                end: c.timestamp[1] ?? c.timestamp[0] ?? 0,
              }))
              .filter((w) => w.text.length > 0)
            if (words.length) wordSegments = segmentsFromWords(words)
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e)
            if (cancelRequested || m === CANCELLED) throw e
            // модель без выравнивания слов — обычный режим
            chunksDone = 0
            out = await run(true)
          }
        } else {
          out = await run(true)
        }
      } finally {
        modelRef.generate = origGenerate
      }
      if (cancelRequested) throw new Error(CANCELLED)
      const segments = wordSegments ?? (out.chunks ?? [])
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
      const message = e instanceof Error ? e.message : String(e)
      if (cancelRequested || message === CANCELLED) post({ type: 'cancelled' })
      else post({ type: 'error', stage: 'transcribe', message })
    }
  }
}
