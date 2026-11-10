// Web Worker: локальная LLM (Qwen3-1.7B через transformers.js) для
// пост-обработки транскриптов: грамматика, саммари, задачи, корректура
// терминов, свои промпты. Текст не покидает устройство.

import { pipeline, env, TextStreamer } from '@huggingface/transformers'

env.allowLocalModels = false

// Открытая официальная ONNX-сборка (onnx-community); workers-ai/Qwen3-1.7B
// закрыт на HF (401), поэтому используем эту. Модель выбирается в настройках.
const DEFAULT_MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX'
const MAX_INPUT_CHARS = 6000 // ~1.5-2k токенов: у модели контекст 32k, но CPU тянет ограниченно

type ChatMessage = { role: 'system' | 'user'; content: string }

type Generator = (
  messages: ChatMessage[],
  options: Record<string, unknown>,
) => Promise<Array<{ generated_text: ChatMessage[] | string }>>

let generator: Generator | null = null
let loadedModelId: string | null = null
// параллельные 'load'/'generate' (AI-панель + предзагрузка из настроек)
// разделяют один процесс загрузки, а не запускают два
let genLoading: Promise<Generator> | null = null

async function ensureGenerator(preferWebGPU: boolean, modelId: string): Promise<Generator> {
  if (generator && loadedModelId === modelId) return generator
  if (!genLoading) {
    genLoading = createGenerator(preferWebGPU, modelId).then(({ pipe }) => pipe)
  }
  try {
    const pipe = await genLoading
    generator = pipe
    loadedModelId = modelId
    return pipe
  } finally {
    genLoading = null
  }
}

function post(msg: unknown) {
  ;(self as unknown as Worker).postMessage(msg)
}

async function createGenerator(preferWebGPU: boolean, modelId: string) {
  const attempts: Array<{ device: 'webgpu' | 'wasm'; dtype: 'q4f16' | 'q4' | 'q8' }> = []
  if (preferWebGPU) attempts.push({ device: 'webgpu', dtype: 'q4f16' })
  attempts.push({ device: 'wasm', dtype: 'q4' }, { device: 'wasm', dtype: 'q8' })

  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      post({
        type: 'status',
        text: `Загрузка локальной AI-модели (${attempt.device === 'webgpu' ? 'WebGPU' : 'CPU/WASM'})…`,
      })
      const pipe = await pipeline('text-generation', modelId, {
        device: attempt.device,
        dtype: attempt.dtype,
        progress_callback: (p: { status: string; file?: string; progress?: number }) => {
          if (p.status === 'progress_total') {
            // агрегат по байтам всех файлов модели
            post({ type: 'load-total', progress: Math.round(p.progress ?? 0) })
          } else if (p.status === 'progress' && p.file) {
            post({
              type: 'load-progress',
              file: `ai:${p.file}`,
              progress: Math.round(p.progress ?? 0),
            })
          }
        },
      })
      return { pipe: pipe as unknown as Generator, device: attempt.device }
    } catch (e) {
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Не удалось загрузить AI-модель')
}

/** Qwen3 — reasoning-модель: вырезаем блок размышлений из ответа. */
function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .trim()
}

self.onmessage = async (
  ev: MessageEvent<
    | { type: 'load'; preferWebGPU: boolean; modelId?: string }
    | { type: 'generate'; prompt: string; text: string; preferWebGPU: boolean; modelId?: string }
  >,
) => {
  const msg = ev.data
  const modelId = msg.modelId || DEFAULT_MODEL_ID
  try {
    const gen = await ensureGenerator(msg.preferWebGPU, modelId)
    if (msg.type === 'load') {
      post({ type: 'ready' })
      return
    }
    const input =
      msg.text.length > MAX_INPUT_CHARS
        ? msg.text.slice(0, MAX_INPUT_CHARS) +
          '\n\n[…текст обрезан: для локальной модели берётся начало транскрипта…]'
        : msg.text
    const t0 = performance.now()
    post({ type: 'status', text: 'Локальная модель обрабатывает текст…' })
    const MAX_NEW = 1024
    // Процент генерации: TextStreamer с token_callback считает токены.
    // Модель почти всегда останавливается раньше лимита, поэтому шкала
    // ориентировочная — но равномерно ползёт и доходит до 100 на result.
    let generatedTokens = 0
    const tokenizer = (gen as unknown as { tokenizer: unknown }).tokenizer
    const streamer = new TextStreamer(tokenizer as never, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: () => {}, // глушим вывод; считаем только токены
      token_callback_function: (tokens: unknown[]) => {
        generatedTokens += tokens.length
        if (generatedTokens % 4 === 0) {
          post({
            type: 'gen-progress',
            pct: Math.min(99, Math.round((generatedTokens / MAX_NEW) * 100)),
          })
        }
      },
    })
    const out = await gen(
      [
        { role: 'system', content: msg.prompt },
        { role: 'user', content: input },
      ],
      {
        max_new_tokens: MAX_NEW,
        do_sample: false,
        repetition_penalty: 1.05,
        streamer,
      },
    )
    const generated = out[0]?.generated_text
    const raw = Array.isArray(generated)
      ? (generated[generated.length - 1]?.content ?? '')
      : (generated ?? '')
    const result = stripThinking(raw)
    if (!result) throw new Error('Модель вернула пустой ответ')
    post({ type: 'result', output: result, elapsedSec: (performance.now() - t0) / 1000 })
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
