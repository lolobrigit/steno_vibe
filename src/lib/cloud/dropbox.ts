import { clearToken, getCredential, getToken, setCredential, setToken } from './config'
import { json, ok, xhr } from './http'
import { challengeOf, newState, popupFlow, randomString, redirectUri } from './oauth'
import { CloudError, type CloudFile, type CloudProvider, type Progress } from './types'

const FOLDER = '/STENO'
const CHUNK = 8 * 1024 * 1024
const SINGLE_MAX = 140 * 1024 * 1024

/** Заголовок Dropbox-API-Arg обязан быть ASCII: остальное экранируем как \uXXXX. */
function arg(o: unknown): string {
  return JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function token(): string {
  const t = getToken('dropbox')
  if (!t) throw new CloudError('auth')
  return t
}

async function connect() {
  const key = getCredential('dropbox')
  if (!key) throw new CloudError('no-credential')
  const verifier = randomString(64)
  const state = newState()
  const url =
    'https://www.dropbox.com/oauth2/authorize?' +
    new URLSearchParams({
      client_id: key,
      response_type: 'code',
      code_challenge: await challengeOf(verifier),
      code_challenge_method: 'S256',
      redirect_uri: redirectUri(),
      token_access_type: 'online',
      state,
    })
  const p = await popupFlow(url, state)
  const code = p.get('code')
  if (!code) throw new CloudError('denied')
  const res = await xhr({
    method: 'POST',
    url: 'https://api.dropboxapi.com/oauth2/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: key,
      code_verifier: verifier,
      redirect_uri: redirectUri(),
    }).toString(),
  })
  const j = await json<{ access_token: string; expires_in?: number }>(res)
  setToken('dropbox', j.access_token, j.expires_in ?? 14400)
}

async function upload(name: string, blob: Blob, onProgress?: Progress, signal?: AbortSignal) {
  const path = `${FOLDER}/${name}`
  const commit = { path, mode: 'overwrite', autorename: false, mute: true }
  const bin = { 'Content-Type': 'application/octet-stream' }
  const auth = { Authorization: `Bearer ${token()}` }

  if (blob.size <= SINGLE_MAX) {
    const res = await xhr({
      method: 'POST',
      url: 'https://content.dropboxapi.com/2/files/upload',
      headers: { ...auth, ...bin, 'Dropbox-API-Arg': arg(commit) },
      body: blob,
      onProgress,
      signal,
    })
    ok(res)
    return
  }

  // Большие файлы — сессией загрузки кусками по 8 МБ.
  const start = await xhr({
    method: 'POST',
    url: 'https://content.dropboxapi.com/2/files/upload_session/start',
    headers: { ...auth, ...bin, 'Dropbox-API-Arg': arg({ close: false }) },
    body: blob.slice(0, CHUNK),
    signal,
  })
  const { session_id } = await json<{ session_id: string }>(start)
  let offset = Math.min(CHUNK, blob.size)
  onProgress?.(offset / blob.size)
  while (blob.size - offset > CHUNK) {
    const res = await xhr({
      method: 'POST',
      url: 'https://content.dropboxapi.com/2/files/upload_session/append_v2',
      headers: { ...auth, ...bin, 'Dropbox-API-Arg': arg({ cursor: { session_id, offset }, close: false }) },
      body: blob.slice(offset, offset + CHUNK),
      signal,
    })
    ok(res)
    offset += CHUNK
    onProgress?.(offset / blob.size)
  }
  const fin = await xhr({
    method: 'POST',
    url: 'https://content.dropboxapi.com/2/files/upload_session/finish',
    headers: { ...auth, ...bin, 'Dropbox-API-Arg': arg({ cursor: { session_id, offset }, commit }) },
    body: blob.slice(offset),
    signal,
  })
  ok(fin)
  onProgress?.(1)
}

async function list(): Promise<CloudFile[]> {
  const res = await xhr({
    method: 'POST',
    url: 'https://api.dropboxapi.com/2/files/list_folder',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: FOLDER, limit: 200 }),
  })
  if (res.status === 409) return [] // папки ещё нет
  const j = await json<{
    entries: { '.tag': string; id: string; name: string; size?: number; server_modified?: string }[]
  }>(res)
  return j.entries
    .filter((e) => e['.tag'] === 'file')
    .map((e) => ({ id: e.id, name: e.name, size: e.size ?? 0, modified: e.server_modified }))
}

async function download(f: CloudFile, onProgress?: Progress, signal?: AbortSignal): Promise<Blob> {
  const res = await xhr({
    method: 'POST',
    url: 'https://content.dropboxapi.com/2/files/download',
    headers: { Authorization: `Bearer ${token()}`, 'Dropbox-API-Arg': arg({ path: f.id }) },
    responseType: 'blob',
    onProgress,
    signal,
  })
  ok(res)
  return res.body as Blob
}

export const dropbox: CloudProvider = {
  id: 'dropbox',
  label: 'Dropbox',
  credentialLabel: 'App key',
  consoleUrl: 'https://www.dropbox.com/developers/apps',
  credential: () => getCredential('dropbox'),
  setCredential: (v) => setCredential('dropbox', v),
  connected: () => !!getToken('dropbox'),
  connect,
  disconnect: () => clearToken('dropbox'),
  upload,
  list,
  download,
}
