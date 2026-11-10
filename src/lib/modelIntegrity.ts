// Проверка целостности скачанных файлов моделей по хэшам с Hugging Face.
//
// Идея: у HF API есть дерево файлов репозитория с хэшами —
//   LFS-файлы   → SHA-256 содержимого (lfs.oid)
//   обычные     → git blob SHA-1 ("blob <size>\0" + content) (oid)
// Мы хэшируем то, что лежит в Cache API браузера, и сравниваем с эталоном.
// Несовпадающие файлы удаляем и докачиваем напрямую — остальные не трогаем.

const HF_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']

export interface TreeEntry {
  path: string
  size: number
  /** SHA-256 содержимого (LFS) */
  sha256?: string
  /** git blob SHA-1 (обычные файлы) */
  sha1?: string
}

export interface VerifyIssue {
  /** путь файла в репозитории (onnx/encoder_model.onnx и т.п.) */
  file: string
  /** URL записи в кэше (ключ Cache API) */
  url: string
  cacheName: string
  reason: 'corrupt' | 'size-mismatch'
}

export interface VerifyReport {
  repo: string
  checked: number
  ok: number
  corrupt: VerifyIssue[]
  /** файлы, которых нет в дереве HF (другая ревизия/переименованы) — пропускаем */
  unknown: string[]
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
  throw lastErr instanceof Error ? lastErr : new Error('Не удалось получить дерево файлов')
}

/** Все записи всех кэшей, относящиеся к репозиторию: url + путь файла в репо. */
async function repoCacheEntries(
  repoId: string,
): Promise<Array<{ url: string; file: string; cacheName: string }>> {
  if (typeof caches === 'undefined') return []
  const needle = repoId.toLowerCase()
  const out: Array<{ url: string; file: string; cacheName: string }> = []
  const names = await caches.keys()
  for (const cacheName of names) {
    const cache = await caches.open(cacheName)
    const reqs = await cache.keys()
    for (const req of reqs) {
      const u = req.url.toLowerCase()
      if (!u.includes(needle)) continue
      const m = req.url.match(/\/resolve\/[^/]+\/(.+)$/)
      if (!m) continue
      out.push({ url: req.url, file: m[1], cacheName })
    }
  }
  return out
}

/**
 * Хэширует все кэшированные файлы репозитория и сверяет с эталоном HF.
 * Файлы, которых нет в кэше, не считаются проблемой — их докачает
 * обычная загрузка модели при следующем запуске.
 */
export async function verifyRepoCache(
  repoId: string,
  onProgress?: (file: string, done: number, total: number) => void,
): Promise<VerifyReport> {
  const tree = await fetchRepoTree(repoId)
  const entries = await repoCacheEntries(repoId)
  const report: VerifyReport = { repo: repoId, checked: 0, ok: 0, corrupt: [], unknown: [] }
  let done = 0
  for (const e of entries) {
    onProgress?.(e.file, done, entries.length)
    const expected = tree.get(e.file)
    if (!expected || (!expected.sha256 && !expected.sha1)) {
      report.unknown.push(e.file)
      done++
      continue
    }
    try {
      const cache = await caches.open(e.cacheName)
      const res = await cache.match(e.url)
      if (!res) {
        report.unknown.push(e.file)
        done++
        continue
      }
      const buf = await res.arrayBuffer()
      if (expected.size > 0 && buf.byteLength !== expected.size) {
        report.corrupt.push({ file: e.file, url: e.url, cacheName: e.cacheName, reason: 'size-mismatch' })
      } else {
        const hex = expected.sha256 ? await sha256Hex(buf) : await gitBlobSha1Hex(buf)
        const want = (expected.sha256 ?? expected.sha1)!.toLowerCase()
        if (hex === want) report.ok++
        else report.corrupt.push({ file: e.file, url: e.url, cacheName: e.cacheName, reason: 'corrupt' })
      }
    } catch {
      report.unknown.push(e.file)
    }
    report.checked++
    done++
    onProgress?.(e.file, done, entries.length)
  }
  return report
}

/**
 * Докачивает ТОЛЬКО переданные (битые) файлы: скачивает заново,
 * проверяет хэш и кладёт в кэш под тем же URL. Возвращает число исправленных.
 */
export async function repairFiles(
  repoId: string,
  issues: VerifyIssue[],
  onProgress?: (file: string, done: number, total: number) => void,
): Promise<{ fixed: number; failed: string[] }> {
  if (issues.length === 0) return { fixed: 0, failed: [] }
  const tree = await fetchRepoTree(repoId)
  let fixed = 0
  const failed: string[] = []
  let done = 0
  for (const issue of issues) {
    onProgress?.(issue.file, done, issues.length)
    const expected = tree.get(issue.file)
    try {
      // cache:'reload' — не отдавать тот же битый ответ из HTTP-кэша браузера
      const res = await fetch(issue.url, { cache: 'reload' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      if (expected) {
        const hex = expected.sha256 ? await sha256Hex(buf) : await gitBlobSha1Hex(buf)
        const want = (expected.sha256 ?? expected.sha1 ?? '').toLowerCase()
        if (want && hex !== want) throw new Error('хэш не сошёлся после повторной загрузки')
      }
      const cache = await caches.open(issue.cacheName)
      await cache.put(
        issue.url,
        new Response(buf, { headers: { 'Content-Length': String(buf.byteLength) } }),
      )
      fixed++
    } catch {
      failed.push(issue.file)
    }
    done++
    onProgress?.(issue.file, done, issues.length)
  }
  return { fixed, failed }
}

/** Полный цикл: проверить репозиторий и починить битые файлы. */
export async function verifyAndRepairRepo(
  repoId: string,
  onProgress?: (file: string, done: number, total: number) => void,
): Promise<{ checked: number; ok: number; fixed: number; failed: string[] }> {
  const report = await verifyRepoCache(repoId, onProgress)
  if (report.corrupt.length === 0) {
    return { checked: report.checked, ok: report.ok, fixed: 0, failed: [] }
  }
  const rep = await repairFiles(repoId, report.corrupt, onProgress)
  return { checked: report.checked, ok: report.ok, fixed: rep.fixed, failed: rep.failed }
}

const DOWNLOAD_CACHE = 'transformers-cache'

/** Вытаскивает repoId из ссылки: huggingface.co/owner/repo, hf-mirror, /tree/…, /resolve/… */
export function parseRepoUrl(input: string): string | null {
  const m = input
    .trim()
    .match(/^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf-mirror\.com)\/([\w.-]+\/[\w.-]+)/)
  return m ? m[1] : null
}

/**
 * Скачивает ВСЕ файлы репозитория в кэш transformers.js (URL-ключи resolve/main).
 * Каждый файл проверяется по эталонному хэшу HF — битый не попадёт в кэш.
 * Уже скачанные целые файлы пропускаются (докачка после обрыва).
 */
export async function downloadRepo(
  repoId: string,
  onProgress?: (file: string, pct: number) => void,
): Promise<{ downloaded: number; skipped: number; failed: string[] }> {
  const tree = await fetchRepoTree(repoId)
  const files = [...tree.values()].filter((f) => !f.path.startsWith('.'))
  const totalBytes = files.reduce((a, f) => a + f.size, 0)
  let doneBytes = 0
  let downloaded = 0
  let skipped = 0
  const failed: string[] = []
  const cache = await caches.open(DOWNLOAD_CACHE)

  for (const f of files) {
    onProgress?.(f.path, totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0)
    const url = `${HF_HOSTS[0]}/${repoId}/resolve/main/${f.path}`
    try {
      const existing = await cache.match(url)
      if (existing) {
        const buf = await existing.arrayBuffer()
        const hex = f.sha256 ? await sha256Hex(buf) : await gitBlobSha1Hex(buf)
        if (hex === (f.sha256 ?? f.sha1 ?? '').toLowerCase()) {
          skipped++
          doneBytes += f.size
          continue
        }
        await cache.delete(url) // битый — перекачаем
      }
      let buf: ArrayBuffer | null = null
      for (const host of HF_HOSTS) {
        try {
          const res = await fetch(`${host}/${repoId}/resolve/main/${f.path}`, { cache: 'reload' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          buf = await res.arrayBuffer()
          break
        } catch {
          buf = null
        }
      }
      if (!buf) throw new Error('не скачался')
      const hex = f.sha256 ? await sha256Hex(buf) : await gitBlobSha1Hex(buf)
      const want = (f.sha256 ?? f.sha1 ?? '').toLowerCase()
      if (want && hex !== want) throw new Error('хэш не сошёлся')
      await cache.put(
        url,
        new Response(buf, { headers: { 'Content-Length': String(buf.byteLength) } }),
      )
      downloaded++
    } catch {
      failed.push(f.path)
    }
    doneBytes += f.size
    onProgress?.(f.path, totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 100)
  }
  return { downloaded, skipped, failed }
}
