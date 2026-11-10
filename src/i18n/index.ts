// Локализация интерфейса. Английский — язык по умолчанию и источник ключей;
// остальные словари подгружаются лениво отдельными чанками.
//
// t() доступна и вне React (библиотеки, тексты ошибок). Воркеры строк не
// формируют: они шлют коды статусов, а главный поток переводит их здесь.

import { useMemo, useSyncExternalStore } from 'react'
import en from './locales/en'

export type Dict = Record<string, string>
export type Params = Record<string, string | number>
export type TFn = (key: string, params?: Params) => string

export const DEFAULT_LANGUAGE = 'en'

/** Языки интерфейса: код ISO-639-1 и самоназвание. */
export const UI_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ja', name: '日本語' },
  { code: 'fr', name: 'Français' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'it', name: 'Italiano' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'zh', name: '中文' },
]

const LOADERS: Record<string, () => Promise<{ default: Dict }>> = {
  es: () => import('./locales/es'),
  de: () => import('./locales/de'),
  ja: () => import('./locales/ja'),
  fr: () => import('./locales/fr'),
  pt: () => import('./locales/pt'),
  ru: () => import('./locales/ru'),
  it: () => import('./locales/it'),
  nl: () => import('./locales/nl'),
  pl: () => import('./locales/pl'),
  tr: () => import('./locales/tr'),
  id: () => import('./locales/id'),
  zh: () => import('./locales/zh'),
}

let current = DEFAULT_LANGUAGE
let dict: Dict = en
const listeners = new Set<() => void>()

export function isSupportedLanguage(code: string | null | undefined): code is string {
  return !!code && UI_LANGUAGES.some((l) => l.code === code)
}

export function getLanguage(): string {
  return current
}

export function t(key: string, params?: Params): string {
  const s = dict[key] ?? en[key] ?? key
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

/** Заголовок, описание и lang страницы — на языке интерфейса (SEO + a11y). */
function syncDocument() {
  if (typeof document === 'undefined') return
  document.documentElement.lang = current
  document.title = t('seo.title')
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute('content', t('seo.description'))
}

export async function setLanguage(code: string): Promise<void> {
  const next = isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE
  if (next === current) return
  let nextDict: Dict = en
  if (next !== DEFAULT_LANGUAGE) {
    try {
      nextDict = (await LOADERS[next]()).default
    } catch {
      return // чанк не загрузился (офлайн) — остаёмся на текущем языке
    }
  }
  current = next
  dict = nextDict
  syncDocument()
  listeners.forEach((l) => l())
}

/**
 * Стартовый язык: ?lang=xx в адресе (ссылки hreflang) → сохранённая настройка
 * → английский. Язык браузера намеренно не учитывается.
 */
export function initialLanguage(saved: string | undefined): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('lang')
    if (isSupportedLanguage(fromUrl)) return fromUrl
  } catch {
    /* ignore */
  }
  return isSupportedLanguage(saved) ? saved : DEFAULT_LANGUAGE
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Хук: компонент перерисовывается при смене языка; ссылка на t меняется вместе с языком. */
export function useT(): TFn {
  const lang = useSyncExternalStore(subscribe, getLanguage, getLanguage)
  return useMemo<TFn>(() => {
    void lang
    return (key, params) => t(key, params)
  }, [lang])
}

/** Название языка речи на языке интерфейса (Intl.DisplayNames). */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([current], { type: 'language' }).of(code)
    if (name && name !== code) return name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    /* ignore */
  }
  return code.toUpperCase()
}

const SPEAKER_RE = /^(?:S|Спикер\s|Speaker\s)(\d+|\?)$/

/** «S1» (и старое «Спикер 1» из истории) → «Speaker 1» на языке интерфейса. */
export function speakerLabel(id: string): string {
  const m = id.match(SPEAKER_RE)
  return m ? t('speaker.n', { n: m[1] }) : id
}
