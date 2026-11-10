import type { CloudProvider, HistoryItem } from '@/types'

const KEYS = 'steno.keys.v1'
const HISTORY = 'steno.history.v1'
const SETTINGS = 'steno.settings.v1'
const HISTORY_LIMIT = 12

export type ApiKeys = Record<CloudProvider, string>

export function loadKeys(): ApiKeys {
  try {
    const raw = localStorage.getItem(KEYS)
    if (raw) return { openai: '', groq: '', deepgram: '', ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { openai: '', groq: '', deepgram: '' }
}

export function saveKeys(keys: ApiKeys) {
  localStorage.setItem(KEYS, JSON.stringify(keys))
}

export type ThemeName = 'dark' | 'light' | 'neutral'

export interface AppSettings {
  mode: 'local' | 'cloud'
  localModel: string
  cloudModel: string
  language: string
  translate: boolean
  diarize: boolean
  silenceStop: boolean
  theme: ThemeName
  /** справочники (id), чьи термины улетают в Whisper (initial_prompt) и LLM */
  glossaryIds: string[]
}

/** Справочник терминов: одна строка = один термин (можно «слово = расшифровка»). */
export interface Glossary {
  id: string
  name: string
  terms: string[]
}

/** Пользовательская LLM-кнопка (промпт). */
export interface LlmButton {
  id: string
  label: string
  prompt: string
  /** id справочника, чьи термины подмешиваются в промпт */
  glossaryId?: string | null
}

/** Локальная LLM, доступная для выбора в настройках. */
export interface LlmModelOption {
  id: string
  label: string
  size: string
}

/** Проверенные ONNX-сборки text-generation под transformers.js. */
export const LLM_MODELS: LlmModelOption[] = [
  { id: 'onnx-community/Qwen3-0.6B-ONNX', label: 'Qwen3 0.6B · быстрая', size: '~400 МБ' },
  { id: 'onnx-community/Qwen3-1.7B-ONNX', label: 'Qwen3 1.7B · точнее', size: '~1.1 ГБ' },
  { id: 'onnx-community/Qwen3-4B-ONNX', label: 'Qwen3 4B · максимум (WebGPU)', size: '~2.3 ГБ' },
]

const DEFAULTS: AppSettings = {
  mode: 'local',
  localModel: 'small',
  cloudModel: 'groq-turbo',
  language: 'auto',
  translate: false,
  diarize: true,
  silenceStop: true,
  theme: 'dark',
  glossaryIds: [],
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return DEFAULTS
}

export function saveSettings(s: AppSettings) {
  localStorage.setItem(SETTINGS, JSON.stringify(s))
}

export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY)
    if (raw) return JSON.parse(raw) as HistoryItem[]
  } catch {
    /* ignore */
  }
  return []
}

export function addHistory(item: HistoryItem): HistoryItem[] {
  const list = [item, ...loadHistory()].slice(0, HISTORY_LIMIT)
  try {
    localStorage.setItem(HISTORY, JSON.stringify(list))
  } catch {
    // хранилище переполнено — выкидываем половину и пробуем ещё раз
    const trimmed = list.slice(0, Math.ceil(HISTORY_LIMIT / 2))
    localStorage.setItem(HISTORY, JSON.stringify(trimmed))
    return trimmed
  }
  return list
}

export function removeHistory(id: string): HistoryItem[] {
  const list = loadHistory().filter((i) => i.id !== id)
  localStorage.setItem(HISTORY, JSON.stringify(list))
  return list
}

export function updateHistory(id: string, patch: Partial<HistoryItem>): HistoryItem[] {
  const list = loadHistory().map((i) => (i.id === id ? { ...i, ...patch } : i))
  try {
    localStorage.setItem(HISTORY, JSON.stringify(list))
  } catch {
    /* переполнение — текст уже отображён, просто не сохраняем */
  }
  return list
}

// ── Справочники терминов ─────────────────────────────────────────

const GLOSSARIES = 'steno.glossaries.v1'
const LLM_BUTTONS = 'steno.llm-buttons.v1'
const LLM_MODEL = 'steno.llm-model.v1'

export function loadGlossaries(): Glossary[] {
  try {
    const raw = localStorage.getItem(GLOSSARIES)
    if (raw) return JSON.parse(raw) as Glossary[]
  } catch {
    /* ignore */
  }
  return []
}

export function saveGlossaries(list: Glossary[]) {
  localStorage.setItem(GLOSSARIES, JSON.stringify(list))
}

export function loadLlmButtons(): LlmButton[] | null {
  try {
    const raw = localStorage.getItem(LLM_BUTTONS)
    if (raw) return JSON.parse(raw) as LlmButton[]
  } catch {
    /* ignore */
  }
  return null // null = не настроено, использовать встроенный набор
}

export function saveLlmButtons(list: LlmButton[]) {
  localStorage.setItem(LLM_BUTTONS, JSON.stringify(list))
}

export function loadLlmModel(): string {
  try {
    return localStorage.getItem(LLM_MODEL) || LLM_MODELS[0].id
  } catch {
    return LLM_MODELS[0].id
  }
}

export function saveLlmModel(id: string) {
  localStorage.setItem(LLM_MODEL, id)
}

/** Термины выбранных справочников одной строкой — для initial_prompt Whisper. */
export function glossaryPromptText(glossaries: Glossary[], ids: string[]): string {
  const terms = glossaries.filter((g) => ids.includes(g.id)).flatMap((g) => g.terms)
  const uniq = [...new Set(terms.map((t) => t.trim()).filter(Boolean))]
  return uniq.join(', ')
}
