import type { CloudProvider } from '@/types'

// Тексты (описания, подсказки) живут в словарях i18n: здесь только ключи.

export interface LocalModel {
  id: string
  hfId: string
  label: string
  params: string
  size: string
  quality: 1 | 2 | 3 | 4 | 5
  needsWebGPU?: boolean
}

export interface CloudModel {
  id: string
  provider: CloudProvider
  apiModel: string
  label: string
  quality: 1 | 2 | 3 | 4 | 5
  price: string
}

/**
 * Локальные модели Whisper, запускаемые прямо в браузере через
 * transformers.js (ONNX, WebGPU/WASM). Порядок = от быстрой к точной.
 * Описание: i18n-ключи `lm.<id>.q` (уровень качества) и `lm.<id>.best`.
 */
export const LOCAL_MODELS: LocalModel[] = [
  { id: 'tiny', hfId: 'onnx-community/whisper-tiny', label: 'Whisper Tiny', params: '39M', size: '~40 MB', quality: 1 },
  { id: 'base', hfId: 'onnx-community/whisper-base', label: 'Whisper Base', params: '74M', size: '~75 MB', quality: 2 },
  { id: 'small', hfId: 'onnx-community/whisper-small', label: 'Whisper Small', params: '244M', size: '~250 MB', quality: 3 },
  {
    id: 'large-v3-turbo',
    hfId: 'onnx-community/whisper-large-v3-turbo',
    label: 'Whisper Large v3 Turbo',
    params: '809M',
    size: '~800 MB',
    quality: 4,
    needsWebGPU: true,
  },
]

/** Облачные модели. Пояснение: i18n-ключ `cm.<id>`. */
export const CLOUD_MODELS: CloudModel[] = [
  { id: 'groq-turbo', provider: 'groq', apiModel: 'whisper-large-v3-turbo', label: 'Groq · Large v3 Turbo', quality: 4, price: '~$0.04/h' },
  { id: 'groq-v3', provider: 'groq', apiModel: 'whisper-large-v3', label: 'Groq · Large v3', quality: 5, price: '~$0.111/h' },
  { id: 'openai-whisper', provider: 'openai', apiModel: 'whisper-1', label: 'OpenAI · Whisper v2', quality: 4, price: '$0.36/h' },
  { id: 'openai-4o', provider: 'openai', apiModel: 'gpt-4o-transcribe', label: 'OpenAI · GPT-4o Transcribe', quality: 5, price: '$0.36/h' },
  { id: 'openai-4o-mini', provider: 'openai', apiModel: 'gpt-4o-mini-transcribe', label: 'OpenAI · GPT-4o mini', quality: 3, price: '$0.18/h' },
  { id: 'deepgram-nova3', provider: 'deepgram', apiModel: 'nova-3', label: 'Deepgram · Nova-3', quality: 5, price: '~$0.26/h' },
]

export const PROVIDER_INFO: Record<
  CloudProvider,
  { label: string; keyUrl: string; keyPlaceholder: string }
> = {
  openai: { label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', keyPlaceholder: 'sk-...' },
  groq: { label: 'Groq', keyUrl: 'https://console.groq.com/keys', keyPlaceholder: 'gsk_...' },
  deepgram: { label: 'Deepgram', keyUrl: 'https://console.deepgram.com/', keyPlaceholder: 'Deepgram key' },
}

/** Языки речи (ISO-639-1). Названия даёт Intl.DisplayNames на языке интерфейса. */
export const SPEECH_LANGUAGES = [
  'en', 'es', 'de', 'ja', 'fr', 'pt', 'ru', 'it', 'nl', 'pl', 'tr', 'id', 'zh',
  'uk', 'ko', 'ar', 'hi', 'sv', 'cs', 'el', 'he', 'vi', 'th',
]

export interface AiAction {
  id: string
  /** i18n-ключ названия кнопки */
  labelKey: string
  prompt: string
  /** свободный ответ (краткое содержание, задачи): результат — не расшифровка */
  free?: boolean
}

// Промпты встроенных кнопок — на английском и без привязки к языку: модель
// отвечает на языке транскрипта. Пользователь может переписать их в настройках.
export const AI_ACTIONS: AiAction[] = [
  {
    id: 'grammar',
    labelKey: 'ai.act.grammar',
    prompt:
      'You are a strict editor. Fix spelling, grammar and punctuation in this speech transcript. Keep the style, the order of ideas and all of the meaning; add nothing and cut nothing. Answer in the language of the transcript. Return only the corrected text, with no comments.',
  },
  {
    id: 'cleanup',
    labelKey: 'ai.act.cleanup',
    prompt:
      'Remove filler words, hesitations, interjections and repetitions from this transcript. Make it readable while keeping every fact and the order of presentation. Answer in the language of the transcript. Return only the text, with no comments.',
  },
  {
    id: 'summary',
    labelKey: 'ai.act.summary',
    prompt:
      'Write a short summary of this transcript: 3–7 bullet points with the main ideas. Answer in the language of the transcript. Return only the list.',
    free: true,
  },
  {
    id: 'fixup',
    labelKey: 'ai.act.fixup',
    prompt:
      'This transcript contains terms, names and abbreviations that speech recognition distorted by sound (for example “K-Clock-Ice” → “Keycloak”, “GVT” → “JWT”). Restore them from meaning and context. Fix only obvious distortions of terms and names, leave the rest of the text untouched, shorten nothing and add nothing. Answer in the language of the transcript. Return only the full corrected text, with no comments and no list of edits.',
  },
  {
    id: 'tasks',
    labelKey: 'ai.act.tasks',
    prompt:
      'Extract all assignments and agreements from this transcript. Format of each item: who — what to do — deadline (if mentioned). If there are none, say so in one line. Answer in the language of the transcript. Return only the list.',
    free: true,
  },
]

/** Гайд «модель → качество»: i18n-ключи `guide.<n>.tier` и `guide.<n>.text`. */
export const QUALITY_GUIDE: Array<{ n: number; model: string }> = [
  { n: 1, model: 'Whisper Tiny / Base' },
  { n: 2, model: 'Whisper Small' },
  { n: 3, model: 'Whisper Large v3 Turbo · WebGPU' },
  { n: 4, model: 'Groq Large v3 Turbo' },
  { n: 5, model: 'Groq Large v3 · OpenAI GPT-4o · Deepgram Nova-3' },
]
