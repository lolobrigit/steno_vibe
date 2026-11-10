// Конфигурация LLM: облачные провайдеры с выбором модели, локальная Qwen.
// Список моделей можно расширять — это просто записи в массиве.

export type AiProvider = 'groq' | 'openai'

export interface LlmCloudModel {
  id: string
  apiModel: string
  label: string
}

export const LLM_CLOUD_MODELS: Record<AiProvider, LlmCloudModel[]> = {
  groq: [
    { id: 'gpt-oss-120b', apiModel: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B · флагман' },
    { id: 'gpt-oss-20b', apiModel: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B · быстрая' },
    { id: 'llama-4-scout', apiModel: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout' },
    { id: 'kimi-k2', apiModel: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2' },
  ],
  openai: [
    { id: 'gpt-4o-mini', apiModel: 'gpt-4o-mini', label: 'GPT-4o mini · быстрая' },
    { id: 'gpt-4o', apiModel: 'gpt-4o', label: 'GPT-4o · флагман' },
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
  if (res.status === 401) throw new Error('Неверный API-ключ (401). Проверьте ключ в панели движка.')
  if (res.status === 429) throw new Error('Лимит запросов AI-сервиса исчерпан (429). Подождите.')
  throw new Error(`Ошибка AI-сервиса (${res.status}): ${detail}`)
}

/** Отправляет транскрипт в LLM через серверный прокси (прямые вызовы из браузера блокируются CORS). */
export async function runAiPrompt(
  provider: AiProvider,
  apiKey: string,
  systemPrompt: string,
  text: string,
  modelId?: string,
): Promise<string> {
  const model = LLM_CLOUD_MODELS[provider].find((m) => m.id === modelId) ?? LLM_CLOUD_MODELS[provider][0]
  const res = await fetch(`${import.meta.env.BASE_URL}api/proxy/ai/${provider}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ prompt: systemPrompt, text, model: model.apiModel }),
  })
  if (!res.ok) await readError(res)
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const out = json.choices?.[0]?.message?.content?.trim()
  if (!out) throw new Error('AI-сервис вернул пустой ответ')
  return out
}
