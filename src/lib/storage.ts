import type { CloudProvider, HistoryItem } from '@/types'
import { deleteAudio } from './audioStore'
import { deleteVersions } from './versionStore'

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

/** aurora — «жидкое стекло», тема по умолчанию; остальные — прежние */
export type ThemeName = 'aurora' | 'aurora-light' | 'dark' | 'light' | 'neutral'

export const DEFAULT_THEME: ThemeName = 'aurora'

export interface AppSettings {
  mode: 'local' | 'cloud'
  localModel: string
  cloudModel: string
  language: string
  translate: boolean
  diarize: boolean
  silenceStop: boolean
  theme: ThemeName
  /** пользователь сам выбрал тему (иначе действует тема по умолчанию) */
  themeChosen?: boolean
  /** язык интерфейса (ISO-639-1), по умолчанию английский */
  uiLang: string
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
  /** свободный ответ (краткое содержание, задачи): результат — не расшифровка */
  free?: boolean
}

/** Локальная LLM, доступная для выбора в настройках. */
export interface LlmModelOption {
  id: string
  label: string
  size: string
  /** ключ i18n с пояснением («быстрая», «точнее»…) */
  hintKey: string
}

/** Проверенные ONNX-сборки text-generation под transformers.js. */
export const LLM_MODELS: LlmModelOption[] = [
  { id: 'onnx-community/Qwen3-0.6B-ONNX', label: 'Qwen3 0.6B', size: '~400 MB', hintKey: 'llm.hint.fast' },
  { id: 'onnx-community/Qwen3-1.7B-ONNX', label: 'Qwen3 1.7B', size: '~1.1 GB', hintKey: 'llm.hint.better' },
  { id: 'onnx-community/Qwen3-4B-ONNX', label: 'Qwen3 4B', size: '~2.3 GB', hintKey: 'llm.hint.max' },
]

const DEFAULTS: AppSettings = {
  mode: 'local',
  localModel: 'small',
  cloudModel: 'groq-turbo',
  language: 'auto',
  translate: false,
  diarize: true,
  silenceStop: true,
  theme: DEFAULT_THEME,
  uiLang: 'en',
  glossaryIds: [],
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS)
    if (raw) {
      const saved = { ...DEFAULTS, ...JSON.parse(raw) } as AppSettings
      // прежняя тема по умолчанию («dark») не была осознанным выбором — переводим на новую
      if (!saved.themeChosen) saved.theme = DEFAULT_THEME
      return saved
    }
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

/** Аудио вытесненных из истории записей удаляем — иначе оно копится в IndexedDB без владельца. */
function dropEvicted(before: HistoryItem[], after: HistoryItem[]) {
  const kept = new Set(after.map((i) => i.id))
  for (const i of before) {
    if (kept.has(i.id)) continue
    if (i.hasAudio) void deleteAudio(i.id)
    void deleteVersions(i.id)
  }
}

export function addHistory(item: HistoryItem): HistoryItem[] {
  const all = [item, ...loadHistory()]
  let list = all.slice(0, HISTORY_LIMIT)
  try {
    localStorage.setItem(HISTORY, JSON.stringify(list))
  } catch {
    // хранилище переполнено — выкидываем половину и пробуем ещё раз
    list = list.slice(0, Math.ceil(HISTORY_LIMIT / 2))
    try {
      localStorage.setItem(HISTORY, JSON.stringify(list))
    } catch {
      /* совсем нет места — запись останется только в памяти вкладки */
    }
  }
  dropEvicted(all, list)
  return list
}

/** Импорт проектов: добавляет записи в начало списка, не вытесняя существующие (до IMPORT_LIMIT). */
const IMPORT_LIMIT = 60
export function addHistoryMany(items: HistoryItem[]): HistoryItem[] {
  const all = [...items, ...loadHistory()]
  const list = all.slice(0, IMPORT_LIMIT)
  try {
    localStorage.setItem(HISTORY, JSON.stringify(list))
  } catch {
    return loadHistory()
  }
  dropEvicted(all, list)
  return list
}

export function removeHistory(id: string): HistoryItem[] {
  void deleteVersions(id)
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
