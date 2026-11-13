// Произвольные сервисы с API формата OpenAI: свой адрес + токен, список
// моделей берётся с GET {base}/models, выбранные модели появляются в «Движке»
// (распознавание, /audio/transcriptions) и в AI-панели (/chat/completions).
//
// Подходит всё OpenAI-совместимое: OpenRouter, Together, Mistral, Ollama,
// LM Studio, vLLM, LocalAI, faster-whisper-server, speaches и т.п.
//
// Запросы по умолчанию идут из браузера напрямую — так доступны и сервисы на
// localhost/в локальной сети, до которых серверу приложения не дотянуться.
// Если сервис не отдаёт CORS-заголовки, включается «через прокси сервера»
// (маршруты /api/proxy/custom/*, на сервере выключены, пока не задан
// CUSTOM_ENDPOINT_PROXY=1).

import { t } from '@/i18n'
import { encodeWavPcm16 } from '@/lib/audio'
import type { Segment } from '@/types'

export type EndpointModelKind = 'asr' | 'llm'

export interface EndpointModel {
  id: string
  kind: EndpointModelKind
}

export interface CustomEndpoint {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  viaProxy: boolean
  /** перед отправкой на распознавание превращать файл в WAV 16 кГц моно (сервис принимает только аудио) */
  convertAudio?: boolean
  /** свой путь распознавания, если не /audio/transcriptions (только прямой режим, без прокси) */
  asrPath?: string
  /** выбранные пользователем модели */
  models: EndpointModel[]
  /** последний полученный список моделей сервиса */
  available: string[]
}

const KEY = 'steno.endpoints.v1'

export function loadEndpoints(): CustomEndpoint[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as CustomEndpoint[]
  } catch {
    /* ignore */
  }
  return []
}

export function saveEndpoints(list: CustomEndpoint[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

/** «https://host/v1/», «…/v1/models», «…/chat/completions» → «https://host/v1». */
export function normalizeBaseUrl(input: string): string {
  let u = input.trim()
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`
  return u
    .replace(/\/+$/, '')
    .replace(/\/(models|chat\/completions|audio\/(transcriptions|translations))$/i, '')
    .replace(/\/+$/, '')
}

/** Грубая догадка по имени: модель распознавания речи или текстовая. */
export function guessModelKind(id: string): EndpointModelKind {
  return /whisper|transcri|speech|stt|asr|voxtral|parakeet|canary|scribe/i.test(id) ? 'asr' : 'llm'
}

/** Значение настройки cloudModel для модели своего сервиса. */
export function customModelRef(endpointId: string, modelId: string): string {
  return `custom:${endpointId}:${modelId}`
}

export function parseCustomRef(
  ref: string,
  endpoints: CustomEndpoint[],
): { endpoint: CustomEndpoint; modelId: string } | null {
  if (!ref.startsWith('custom:')) return null
  const rest = ref.slice(7)
  const i = rest.indexOf(':')
  if (i < 0) return null
  const endpoint = endpoints.find((e) => e.id === rest.slice(0, i))
  return endpoint ? { endpoint, modelId: rest.slice(i + 1) } : null
}

type Op = 'models' | 'chat' | 'transcribe' | 'translate'

const OP_PATH: Record<Op, string> = {
  models: '/models',
  chat: '/chat/completions',
  transcribe: '/audio/transcriptions',
  translate: '/audio/translations',
}

async function call(
  ep: Pick<CustomEndpoint, 'baseUrl' | 'apiKey' | 'viaProxy' | 'asrPath'>,
  op: Op,
  init: { method: 'GET' | 'POST'; body?: BodyInit; json?: boolean; signal?: AbortSignal },
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (init.json) headers['Content-Type'] = 'application/json'
  let url: string
  if (ep.viaProxy) {
    url = `${import.meta.env.BASE_URL}api/proxy/custom/${op}`
    headers['x-base-url'] = ep.baseUrl
    if (ep.apiKey) headers['x-api-key'] = ep.apiKey
  } else {
    const custom = op === 'transcribe' ? ep.asrPath?.trim() : ''
    url = `${ep.baseUrl}${custom ? (custom.startsWith('/') ? custom : `/${custom}`) : OP_PATH[op]}`
    if (ep.apiKey) headers['Authorization'] = `Bearer ${ep.apiKey}`
  }
  let res: Response
  try {
    res = await fetch(url, { method: init.method, headers, body: init.body, signal: init.signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    // fetch не различает «сеть недоступна» и «CORS запретил» — подсказываем оба
    throw new Error(t(ep.viaProxy ? 'ep.err.proxyNetwork' : 'ep.err.network'))
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      detail = body?.error?.message ?? (typeof body?.error === 'string' ? body.error : JSON.stringify(body))
    } catch {
      detail = res.statusText
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(t('ep.err.auth', { status: res.status, detail }))
    }
    if (res.status === 404 || res.status === 405) {
      // путь не тот: показываем адрес, на который реально ушёл запрос
      throw new Error(t('ep.err.path', { status: res.status, url: ep.viaProxy ? `${ep.baseUrl}${OP_PATH[op]}` : url, detail }))
    }
    throw new Error(t('ep.err.http', { status: res.status, detail }))
  }
  return res
}

/** Список моделей сервиса: GET {base}/models → data[].id. */
export async function fetchEndpointModels(
  ep: Pick<CustomEndpoint, 'baseUrl' | 'apiKey' | 'viaProxy'>,
): Promise<string[]> {
  const res = await call(ep, 'models', { method: 'GET' })
  const json = (await res.json()) as
    | { data?: Array<{ id?: string }>; models?: Array<{ id?: string; name?: string }> }
    | Array<{ id?: string }>
  const items = Array.isArray(json) ? json : (json.data ?? json.models ?? [])
  const ids = items
    .map((m) => m.id ?? (m as { name?: string }).name)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) throw new Error(t('ep.err.noModels'))
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

export async function customChat(
  ep: CustomEndpoint,
  model: string,
  systemPrompt: string,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await call(ep, 'chat', {
    method: 'POST',
    json: true,
    signal,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
    }),
  })
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const out = json.choices?.[0]?.message?.content?.trim()
  if (!out) throw new Error(t('err.aiEmpty'))
  return out
}

interface VerboseJson {
  text?: string
  language?: string
  duration?: number
  segments?: Array<{ start: number; end: number; text: string; words?: RawWord[] }>
  words?: RawWord[]
}

/** Слово в ответах разных сервисов: OpenAI — `word`, whisper.cpp — `word` или `text`. */
interface RawWord {
  word?: string
  text?: string
  start: number
  end: number
}

/** Нет сегментов (формат json без таймкодов): режем текст на предложения, время — пропорционально длине. */
export function sentencesToSegments(text: string, durationSec: number): Segment[] {
  const parts = text.match(/[^.!?…。！？]+[.!?…。！？]*\s*/g)?.map((x) => x.trim()).filter(Boolean) ?? []
  if (parts.length === 0 || !(durationSec > 0)) return text ? [{ start: 0, end: Math.max(durationSec, 0), text }] : []
  const total = parts.reduce((a, x) => a + x.length, 0)
  let at = 0
  return parts.map((x) => {
    const start = at
    at += (x.length / total) * durationSec
    return { start, end: at, text: x }
  })
}

export async function customTranscribe(
  ep: CustomEndpoint,
  model: string,
  o: {
    file: Blob
    fileName: string
    language: string | null
    translate: boolean
    prompt?: string
    /** просить пословные метки (timestamp_granularities[]=word) */
    wordTimestamps?: boolean
    /** длительность файла: нужна, чтобы разбить ответ без таймкодов */
    durationSec?: number
    signal?: AbortSignal
  },
): Promise<{ text: string; segments: Segment[]; language?: string }> {
  const form = (format: string) => {
    const f = new FormData()
    if (o.wordTimestamps && format === 'verbose_json') {
      f.append('timestamp_granularities[]', 'word')
      f.append('timestamp_granularities[]', 'segment')
    }
    f.append('file', o.file, o.fileName)
    f.append('model', model)
    f.append('response_format', format)
    if (o.language && !o.translate) f.append('language', o.language)
    if (o.prompt) f.append('prompt', o.prompt.slice(0, 896))
    return f
  }
  const op: Op = o.translate ? 'translate' : 'transcribe'
  let res: Response
  try {
    res = await call(ep, op, { method: 'POST', body: form('verbose_json'), signal: o.signal })
  } catch (e) {
    if (o.signal?.aborted) throw e
    // не все совместимые сервисы знают verbose_json — повторяем с простым json
    res = await call(ep, op, { method: 'POST', body: form('json'), signal: o.signal }).catch(() => {
      throw e
    })
  }
  const json = (await res.json()) as VerboseJson
  const toWord = (w: RawWord) => ({ text: (w.word ?? w.text ?? '').trim(), start: w.start, end: w.end })
  const allWords = [...(json.words ?? []), ...(json.segments ?? []).flatMap((s) => s.words ?? [])]
    .map(toWord)
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end))
  let segments: Segment[] = (json.segments ?? [])
    .map((s) => ({ start: s.start, end: s.end, text: (s.text ?? '').trim() }))
    .filter((s) => s.text.length > 0)
  if (o.wordTimestamps && allWords.length > 0) {
    // слова раскладываем по репликам по времени (середина слова внутри реплики)
    segments = segments.map((seg) => {
      const words = allWords.filter((w) => (w.start + w.end) / 2 >= seg.start && (w.start + w.end) / 2 < seg.end + 0.001)
      return words.length ? { ...seg, words } : seg
    })
  }
  if (segments.length === 0 && (json.text ?? '').trim()) {
    segments = sentencesToSegments((json.text ?? '').trim(), o.durationSec ?? json.duration ?? 0)
  }
  return { text: (json.text ?? '').trim(), segments, language: json.language }
}

/** Проверка распознавания: отправляет секунду тишины (WAV 16 кГц) и показывает ошибку сервиса, если она есть. */
export async function probeTranscribe(ep: CustomEndpoint, model: string): Promise<void> {
  await customTranscribe(ep, model || 'whisper-1', {
    file: encodeWavPcm16(new Float32Array(16000)),
    fileName: 'probe.wav',
    language: null,
    translate: false,
  })
}
