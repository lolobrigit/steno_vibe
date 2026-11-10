import type { CloudProvider, Segment } from '@/types'
import { t } from '@/i18n'

interface CloudResult {
  text: string
  segments: Segment[]
  language?: string
}

interface CloudOptions {
  provider: CloudProvider
  apiModel: string
  apiKey: string
  file: Blob
  fileName: string
  language: string | null // ISO-639-1 или null = авто
  translate: boolean // перевод на английский (OpenAI/Groq)
  diarize?: boolean // разделение спикеров (Deepgram)
  /** справочник терминов → prompt (OpenAI/Groq) / keyterm (Deepgram) */
  prompt?: string
  /** отмена запроса */
  signal?: AbortSignal
}

/**
 * Запросы идут через серверный прокси /api/proxy: прямые обращения из браузера
 * к OpenAI и Groq блокируются CORS. Ключ передаётся заголовком и нигде не сохраняется.
 */
export function cloudSizeLimit(provider: CloudProvider): number {
  // у OpenAI/Groq лимит 25 МБ; у Deepgram — упираемся в лимит прокси
  return provider === 'deepgram' ? 100 * 1024 * 1024 : 25 * 1024 * 1024
}

async function readError(res: Response): Promise<never> {
  let detail = ''
  try {
    const body = await res.json()
    detail =
      body?.error?.message ??
      (typeof body?.error === 'string' ? body.error : null) ??
      body?.err ??
      JSON.stringify(body)
  } catch {
    detail = res.statusText
  }
  if (res.status === 401) throw new Error(t('err.key401'))
  if (res.status === 429) throw new Error(t('err.rate429'))
  if (res.status === 413) throw new Error(t('err.tooLarge413'))
  throw new Error(t('err.service', { status: res.status, detail }))
}

interface VerboseJson {
  text?: string
  language?: string
  segments?: Array<{ start: number; end: number; text: string }>
}

function normalizeVerbose(json: VerboseJson): CloudResult {
  const segments = (json.segments ?? [])
    .map((s) => ({ start: s.start, end: s.end, text: (s.text ?? '').trim() }))
    .filter((s) => s.text.length > 0)
  return { text: (json.text ?? '').trim(), segments, language: json.language }
}

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      detected_language?: string
      alternatives?: Array<{
        transcript?: string
        paragraphs?: {
          paragraphs?: Array<{
            speaker?: number
            sentences?: Array<{ start: number; end: number; text: string }>
          }>
        }
      }>
    }>
  }
}

function normalizeDeepgram(json: DeepgramResponse): CloudResult {
  const alt = json.results?.channels?.[0]?.alternatives?.[0]
  const paragraphs = alt?.paragraphs?.paragraphs ?? []
  const segments: Segment[] = paragraphs
    .flatMap((p) =>
      (p.sentences ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text.trim(),
        speaker: typeof p.speaker === 'number' ? `S${p.speaker + 1}` : undefined,
      })),
    )
    .filter((s) => s.text.length > 0)
  return {
    text: (alt?.transcript ?? '').trim(),
    segments,
    language: json.results?.channels?.[0]?.detected_language,
  }
}

export async function transcribeCloud(opts: CloudOptions): Promise<CloudResult> {
  if (opts.file.size > cloudSizeLimit(opts.provider)) {
    throw new Error(
      t('err.sizeLimit', { mb: Math.round(cloudSizeLimit(opts.provider) / 1024 / 1024) }),
    )
  }

  const params = new URLSearchParams({ model: opts.apiModel })
  if (opts.language) params.set('language', opts.language)
  if (opts.translate) params.set('translate', 'true')
  if (opts.diarize) params.set('diarize', 'true')
  if (opts.prompt) params.set('prompt', opts.prompt)

  const res = await fetch(
    `${import.meta.env.BASE_URL}api/proxy/transcribe/${opts.provider}?${params}`,
    {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'x-file-name': encodeURIComponent(opts.fileName),
        'Content-Type': opts.file.type || 'application/octet-stream',
      },
      body: opts.file,
      signal: opts.signal,
    },
  )
  if (!res.ok) await readError(res)
  const json = await res.json()
  return opts.provider === 'deepgram'
    ? normalizeDeepgram(json as DeepgramResponse)
    : normalizeVerbose(json as VerboseJson)
}
