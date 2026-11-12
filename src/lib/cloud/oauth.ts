import { CloudError } from './types'

const STATE_PREFIX = 'steno-'

/** Куда провайдер вернёт пользователя: адрес приложения (с учётом префикса /whisper/). */
export function redirectUri(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}`
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

export function randomString(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

export function newState(): string {
  return STATE_PREFIX + randomString(24)
}

function b64url(bytes: ArrayBuffer): string {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** PKCE: S256-образ верификатора. */
export async function challengeOf(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
}

/**
 * Окно входа: открывает провайдера во всплывающем окне и ждёт, пока страница
 * приложения внутри него (handleOAuthRedirect) пришлёт параметры ответа.
 */
export function popupFlow(url: string, state: string): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const w = window.open(url, 'steno-oauth', 'width=520,height=700,menubar=no,toolbar=no')
    if (!w) return reject(new CloudError('popup-blocked'))
    const finish = (fn: () => void) => {
      window.removeEventListener('message', onMsg)
      window.clearInterval(poll)
      window.clearTimeout(timeout)
      fn()
    }
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; state?: string; params?: Record<string, string> } | null
      if (e.origin !== window.location.origin || d?.type !== 'steno-oauth' || d.state !== state) return
      finish(() => {
        w.close()
        const p = new URLSearchParams(d.params)
        const err = p.get('error')
        if (err) reject(new CloudError('denied', p.get('error_description') ?? err))
        else resolve(p)
      })
    }
    window.addEventListener('message', onMsg)
    const poll = window.setInterval(() => {
      if (w.closed) finish(() => reject(new CloudError('closed')))
    }, 600)
    const timeout = window.setTimeout(
      () => finish(() => reject(new CloudError('closed'))),
      5 * 60_000,
    )
  })
}

/**
 * Вызывается при старте приложения. Если страница открыта во всплывающем окне
 * входа (в адресе — state нашего приложения), передаёт ответ провайдера
 * главному окну и закрывает это. Возвращает true — рендерить приложение не надо.
 */
export function handleOAuthRedirect(): boolean {
  if (!window.opener || window.opener === window) return false
  const params: Record<string, string> = {}
  for (const src of [window.location.search, window.location.hash.replace(/^#/, '')]) {
    new URLSearchParams(src).forEach((v, k) => (params[k] = v))
  }
  if (!params.state?.startsWith(STATE_PREFIX)) return false
  try {
    window.opener.postMessage({ type: 'steno-oauth', state: params.state, params }, window.location.origin)
  } catch {
    return false
  }
  document.body.textContent = 'You can close this window.'
  window.close()
  return true
}
