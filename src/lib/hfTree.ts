// Дерево файлов репозитория Hugging Face с хэшами. Модуль без зависимостей от
// UI и i18n — его импортируют и воркеры.
//   LFS-файлы   → SHA-256 содержимого (lfs.oid)
//   обычные     → git blob SHA-1 ("blob <size>\\0" + content) (oid)

export const HF_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']

export interface TreeEntry {
  path: string
  size: number
  /** SHA-256 содержимого (LFS) */
  sha256?: string
  /** git blob SHA-1 (обычные файлы) */
  sha1?: string
}

function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', data))
}

/** git blob hash: sha1("blob <len>\0" + content) — так HF считает oid мелких файлов. */
export async function gitBlobSha1Hex(data: ArrayBuffer): Promise<string> {
  const head = new TextEncoder().encode(`blob ${data.byteLength}\0`)
  const joined = new Uint8Array(head.length + data.byteLength)
  joined.set(head, 0)
  joined.set(new Uint8Array(data), head.length)
  return toHex(await crypto.subtle.digest('SHA-1', joined.buffer))
}

interface TreeApiItem {
  type: string
  path: string
  size?: number
  oid?: string
  lfs?: { oid?: string; size?: number }
}

/** Дерево файлов репозитория с хэшами. HF → зеркало, если основной недоступен. */
export async function fetchRepoTree(
  repoId: string,
  revision = 'main',
): Promise<Map<string, TreeEntry>> {
  let lastErr: unknown = null
  for (const host of HF_HOSTS) {
    try {
      const url = `${host}/api/models/${repoId}/tree/${revision}?recursive=true`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const items = (await res.json()) as TreeApiItem[]
      const map = new Map<string, TreeEntry>()
      for (const it of items) {
        if (it.type !== 'file') continue
        map.set(it.path, {
          path: it.path,
          size: it.lfs?.size ?? it.size ?? 0,
          sha256: it.lfs?.oid,
          sha1: it.lfs?.oid ? undefined : it.oid,
        })
      }
      return map
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Failed to fetch the repository file list')
}

