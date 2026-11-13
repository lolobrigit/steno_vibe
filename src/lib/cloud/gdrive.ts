import { clearToken, getCredential, getToken, setCredential, setToken } from './config'
import { json, ok, xhr } from './http'
import { newState, popupFlow } from './oauth'
import { CloudError, type CloudFile, type CloudProvider, type Progress } from './types'

const API = 'https://www.googleapis.com/drive/v3'
const FOLDER_NAME = 'STENO'
const GIS = 'https://accounts.google.com/gsi/client'

interface TokenResponse {
  access_token?: string
  expires_in?: number | string
  error?: string
  error_description?: string
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: string }): void
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(c: {
            client_id: string
            scope: string
            callback: (r: TokenResponse) => void
            error_callback?: (e: { type: string }) => void
          }): TokenClient
        }
      }
    }
  }
}

let gisLoading: Promise<void> | null = null
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  gisLoading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = GIS
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      gisLoading = null
      reject(new CloudError('script'))
    }
    document.head.appendChild(s)
  })
  return gisLoading
}

function token(): string {
  const t = getToken('gdrive')
  if (!t) throw new CloudError('auth')
  return t
}
const auth = () => ({ Authorization: `Bearer ${token()}` })

/** Включён ли вход через серверные креды (заданы GOOGLE_CLIENT_ID/SECRET на сервере). */
let serverEnabled: boolean | null = null
export async function probeGoogleServer(): Promise<boolean> {
  if (serverEnabled !== null) return serverEnabled
  try {
    const res = await xhr({ method: 'GET', url: `${import.meta.env.BASE_URL}api/google/status` })
    const j = JSON.parse(String(res.body)) as { enabled?: boolean }
    serverEnabled = res.status === 200 && !!j.enabled
  } catch {
    serverEnabled = false
  }
  return serverEnabled
}

/** Вход через сервер: всплывающее окно → сервер меняет код на токен (секрет остаётся на сервере). */
async function connectViaServer() {
  const state = newState()
  const url = `${import.meta.env.BASE_URL}api/google/start?${new URLSearchParams({
    state,
    base: import.meta.env.BASE_URL,
  })}`
  const p = await popupFlow(url, state)
  const t = p.get('access_token')
  if (!t) throw new CloudError('denied', p.get('error_description') ?? '')
  setToken('gdrive', t, Number(p.get('expires_in')) || 3600)
}

async function connect() {
  if (serverEnabled === null) await probeGoogleServer()
  // свой Client ID, введённый пользователем, главнее серверного
  if (serverEnabled && !getCredential('gdrive')) return connectViaServer()
  const id = getCredential('gdrive')
  if (!id) throw new CloudError('no-credential')
  await loadGis()
  const r = await new Promise<TokenResponse>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: resolve,
      error_callback: (e) =>
        reject(new CloudError(e.type === 'popup_failed_to_open' ? 'popup-blocked' : 'closed', e.type)),
    })
    client.requestAccessToken()
  })
  if (r.error || !r.access_token) throw new CloudError('denied', r.error_description ?? r.error ?? '')
  setToken('gdrive', r.access_token, Number(r.expires_in) || 3600)
}

/** Папка STENO (drive.file видит только созданное приложением — её и создаём). */
async function folderId(create: boolean): Promise<string | null> {
  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  const res = await xhr({
    method: 'GET',
    url: `${API}/files?${new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive' })}`,
    headers: auth(),
  })
  const j = await json<{ files: { id: string }[] }>(res)
  if (j.files[0]) return j.files[0].id
  if (!create) return null
  const made = await xhr({
    method: 'POST',
    url: `${API}/files?fields=id`,
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  })
  return (await json<{ id: string }>(made)).id
}

async function upload(name: string, blob: Blob, onProgress?: Progress, signal?: AbortSignal) {
  const parent = (await folderId(true))!
  const init = await xhr({
    method: 'POST',
    url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
    headers: {
      ...auth(),
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify({ name, parents: [parent] }),
    signal,
  })
  ok(init)
  const location = init.header('Location')
  if (!location) throw new CloudError('http', 'no upload location')
  const res = await xhr({
    method: 'PUT',
    url: location,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
    onProgress,
    signal,
  })
  ok(res)
}

async function list(): Promise<CloudFile[]> {
  const parent = await folderId(false)
  if (!parent) return []
  const res = await xhr({
    method: 'GET',
    url: `${API}/files?${new URLSearchParams({
      q: `'${parent}' in parents and trashed=false`,
      fields: 'files(id,name,size,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: '200',
    })}`,
    headers: auth(),
  })
  const j = await json<{ files: { id: string; name: string; size?: string; modifiedTime?: string }[] }>(res)
  return j.files.map((f) => ({ id: f.id, name: f.name, size: Number(f.size) || 0, modified: f.modifiedTime }))
}

async function download(f: CloudFile, onProgress?: Progress, signal?: AbortSignal): Promise<Blob> {
  const res = await xhr({
    method: 'GET',
    url: `${API}/files/${encodeURIComponent(f.id)}?alt=media`,
    headers: auth(),
    responseType: 'blob',
    onProgress,
    signal,
  })
  ok(res)
  return res.body as Blob
}

export const gdrive: CloudProvider = {
  id: 'gdrive',
  label: 'Google Drive',
  credentialLabel: 'OAuth Client ID',
  consoleUrl: 'https://console.cloud.google.com/apis/credentials',
  // 'server' — маркер «ключ не нужен, вход выполняет сервер»
  credential: () => getCredential('gdrive') || (serverEnabled ? 'server' : ''),
  serverManaged: () => !!serverEnabled && !getCredential('gdrive'),
  setCredential: (v) => setCredential('gdrive', v),
  connected: () => !!getToken('gdrive'),
  connect,
  disconnect: () => clearToken('gdrive'),
  upload,
  list,
  download,
}
