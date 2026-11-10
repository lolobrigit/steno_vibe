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
let loadedKey: string | null = null
// параллельные 'load'/'generate' делят один процесс инициализации
let genLoading: Promise<Generator> | null = null

interface VariantMsg {
  modelId?: string
  device: 'webgpu' | 'wasm'
  dtype: string
}

/**
 * Поднять модель из кэша. Файлы варианта уже скачаны менеджером загрузок в
 * главном потоке (lib/modelPlan.ts) — здесь только инициализация сессии.
 */
async function ensureGenerator(v: VariantMsg): Promise<Generator> {
  const modelId = v.modelId || DEFAULT_MODEL_ID
  const key = `${modelId}|${v.device}|${v.dtype}`
  if (genLoading) await genLoading.catch(() => undefined)
  if (generator && loadedKey === key) return generator
  generator = null
  loadedKey = null
  genLoading = pipeline('text-generation', modelId, {
    device: v.device,
    dtype: v.dtype as never,
  }) as unknown as Promise<Generator>
  try {
    generator = await genLoading
    loadedKey = key
    return generator
  } finally {
    genLoading = null
  }
}

function post(msg: unknown) {
  ;(self as unknown as Worker).postMessage(msg)
}

/** Qwen3 — reasoning-модель: вырезаем блок размышлений из ответа. */
function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .trim()
}

self.onmessage = async (
  ev: MessageEvent<
    | ({ type: 'load' } & VariantMsg)
    | ({ type: 'generate'; prompt: string; text: string } & VariantMsg)
  >,
) => {
  const msg = ev.data
  try {
    const gen = await ensureGenerator(msg)
    if (msg.type === 'load') {
      post({ type: 'ready' })
      return
    }
    const input =
      msg.text.length > MAX_INPUT_CHARS
        ? msg.text.slice(0, MAX_INPUT_CHARS) +
          '\n\n[…text truncated: the local model only receives the beginning of the transcript…]'
        : msg.text
    const t0 = performance.now()
    post({ type: 'generating' })
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
    if (!result) throw new Error('empty')
    post({ type: 'result', output: result, elapsedSec: (performance.now() - t0) / 1000 })
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
