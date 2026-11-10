// Конфигурация LLM: облачные провайдеры с выбором модели, локальная Qwen.
// Список моделей можно расширять — это просто записи в массиве.

import { t } from '@/i18n'

export type AiProvider = 'groq' | 'openai'

export interface LlmCloudModel {
  id: string
  apiModel: string
  label: string
}

export const LLM_CLOUD_MODELS: Record<AiProvider, LlmCloudModel[]> = {
  groq: [
    { id: 'gpt-oss-120b', apiModel: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
    { id: 'gpt-oss-20b', apiModel: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
    { id: 'llama-4-scout', apiModel: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout' },
    { id: 'kimi-k2', apiModel: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2' },
  ],
  openai: [
    { id: 'gpt-4o-mini', apiModel: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'gpt-4o', apiModel: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4.1', apiModel: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', apiModel: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  ],
}

const PROVIDER_LABEL: Record<AiProvider, string> = { groq: 'Groq', openai: 'OpenAI' }

export const AI_PROVIDERS: AiProvider[] = ['groq', 'openai']

export function aiProviderLabel(p: AiProvider): string {
  return PROVIDER_LABEL[p]
}

export function llmCloudModelLabel(p: AiProvider, modelId: string): string {
  const m = LLM_CLOUD_MODELS[p].find((x) => x.id === modelId) ?? LLM_CLOUD_MODELS[p][0]
  return `${PROVIDER_LABEL[p]} · ${m.label}`
}

async function readError(res: Response): Promise<never> {
  let detail = ''
  try {
    const body = await res.json()
    detail = body?.error?.message ?? JSON.stringify(body)
  } catch {
    detail = res.statusText
  }
  if (res.status === 401) throw new Error(t('err.key401'))
  if (res.status === 429) throw new Error(t('err.rate429'))
  throw new Error(t('err.service', { status: res.status, detail }))
}

/** Отправляет транскрипт в LLM через серверный прокси (прямые вызовы из браузера блокируются CORS). */
export async function runAiPrompt(
  provider: AiProvider,
  apiKey: string,
  systemPrompt: string,
  text: string,
  modelId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const model = LLM_CLOUD_MODELS[provider].find((m) => m.id === modelId) ?? LLM_CLOUD_MODELS[provider][0]
  const res = await fetch(`${import.meta.env.BASE_URL}api/proxy/ai/${provider}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ prompt: systemPrompt, text, model: model.apiModel }),
    signal,
  })
  if (!res.ok) await readError(res)
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const out = json.choices?.[0]?.message?.content?.trim()
  if (!out) throw new Error(t('err.aiEmpty'))
  return out
}
