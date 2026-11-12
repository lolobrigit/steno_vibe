import type { CloudId } from './types'

const KEY = 'steno.cloud.v1'

interface Entry {
  credential?: string
  token?: string
  /** unix-мс, когда токен перестаёт действовать */
  expires?: number
}

type Config = Partial<Record<CloudId, Entry>>

/** Ключи приложений, зашитые при сборке (см. .env.example). */
const ENV: Record<CloudId, string> = {
  gdrive: (import.meta.env.VITE_GDRIVE_CLIENT_ID as string | undefined) ?? '',
  yandex: (import.meta.env.VITE_YANDEX_CLIENT_ID as string | undefined) ?? '',
  dropbox: (import.meta.env.VITE_DROPBOX_APP_KEY as string | undefined) ?? '',
}

function read(): Config {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Config
  } catch {
    return {}
  }
}

function write(c: Config) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    /* ignore */
  }
}

export function getCredential(id: CloudId): string {
  return ENV[id] || read()[id]?.credential || ''
}

export function setCredential(id: CloudId, value: string) {
  const c = read()
  c[id] = { ...c[id], credential: value.trim() }
  write(c)
}

/** Токен, пока не истёк (с запасом в минуту). */
export function getToken(id: CloudId): string | null {
  const e = read()[id]
  if (!e?.token) return null
  if (e.expires && e.expires - 60_000 < Date.now()) return null
  return e.token
}

export function setToken(id: CloudId, token: string, expiresInSec: number) {
  const c = read()
  c[id] = { ...c[id], token, expires: Date.now() + expiresInSec * 1000 }
  write(c)
}

export function clearToken(id: CloudId) {
  const c = read()
  if (c[id]) {
    delete c[id]!.token
    delete c[id]!.expires
    write(c)
  }
}
