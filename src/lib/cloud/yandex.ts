import { clearToken, getCredential, getToken, setCredential, setToken } from './config'
import { json, ok, xhr } from './http'
import { newState, popupFlow, redirectUri } from './oauth'
import { CloudError, type CloudFile, type CloudProvider, type Progress } from './types'

const API = 'https://cloud-api.yandex.net/v1/disk'
const DIR = 'disk:/STENO'

function auth() {
  const t = getToken('yandex')
  if (!t) throw new CloudError('auth')
  return { Authorization: `OAuth ${t}` }
}

async function connect() {
  const id = getCredential('yandex')
  if (!id) throw new CloudError('no-credential')
  const state = newState()
  const url =
    'https://oauth.yandex.ru/authorize?' +
    new URLSearchParams({ response_type: 'token', client_id: id, redirect_uri: redirectUri(), state })
  const p = await popupFlow(url, state)
  const t = p.get('access_token')
  if (!t) throw new CloudError('denied')
  setToken('yandex', t, Number(p.get('expires_in')) || 3600)
}

async function ensureDir() {
  const res = await xhr({ method: 'PUT', url: `${API}/resources?${new URLSearchParams({ path: DIR })}`, headers: auth() })
  if (res.status !== 409) ok(res) // 409 — папка уже есть
}

async function upload(name: string, blob: Blob, onProgress?: Progress, signal?: AbortSignal) {
  await ensureDir()
  const q = new URLSearchParams({ path: `${DIR}/${name}`, overwrite: 'true' })
  const href = (await json<{ href: string }>(await xhr({ method: 'GET', url: `${API}/resources/upload?${q}`, headers: auth() }))).href
  // Хост загрузки может не отдавать CORS — тогда это сетевая ошибка (см. docs).
  const res = await xhr({ method: 'PUT', url: href, body: blob, onProgress, signal })
  ok(res)
}

async function list(): Promise<CloudFile[]> {
  const q = new URLSearchParams({
    path: DIR,
    limit: '200',
    sort: '-modified',
    fields: '_embedded.items.name,_embedded.items.size,_embedded.items.modified,_embedded.items.type,_embedded.items.path',
  })
  const res = await xhr({ method: 'GET', url: `${API}/resources?${q}`, headers: auth() })
  if (res.status === 404) return []
  const j = await json<{
    _embedded?: { items: { name: string; size?: number; modified?: string; type: string; path: string }[] }
  }>(res)
  return (j._embedded?.items ?? [])
    .filter((i) => i.type === 'file')
    .map((i) => ({ id: i.path, name: i.name, size: i.size ?? 0, modified: i.modified }))
}

async function download(f: CloudFile, onProgress?: Progress, signal?: AbortSignal): Promise<Blob> {
  const q = new URLSearchParams({ path: f.id })
  const href = (await json<{ href: string }>(await xhr({ method: 'GET', url: `${API}/resources/download?${q}`, headers: auth() }))).href
  const res = await xhr({ method: 'GET', url: href, responseType: 'blob', onProgress, signal })
  ok(res)
  return res.body as Blob
}

export const yandex: CloudProvider = {
  id: 'yandex',
  label: 'Яндекс Диск',
  credentialLabel: 'Client ID',
  consoleUrl: 'https://oauth.yandex.ru/client/new',
  credential: () => getCredential('yandex'),
  setCredential: (v) => setCredential('yandex', v),
  connected: () => !!getToken('yandex'),
  connect,
  disconnect: () => clearToken('yandex'),
  upload,
  list,
  download,
}
