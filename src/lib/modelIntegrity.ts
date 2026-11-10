// Проверка целостности скачанных файлов моделей по хэшам с Hugging Face.
//
// Идея: у HF API есть дерево файлов репозитория с хэшами —
//   LFS-файлы   → SHA-256 содержимого (lfs.oid)
//   обычные     → git blob SHA-1 ("blob <size>\0" + content) (oid)
// Мы хэшируем то, что лежит в Cache API браузера, и сравниваем с эталоном.
// Несовпадающие файлы удаляем и докачиваем напрямую — остальные не трогаем.

import { startDownload, type FileSpec } from './downloads'
import { sha256Blob } from './sha256'

import { fetchRepoTree, gitBlobSha1Hex, HF_HOSTS, type TreeEntry } from './hfTree'

export { fetchRepoTree, HF_HOSTS, type TreeEntry }
export const TRANSFORMERS_CACHE = 'transformers-cache'

/** Описание файла репозитория для менеджера загрузок (ключ кэша = URL resolve/main). */
export function hfFileSpec(repoId: string, entry: TreeEntry, cacheName = TRANSFORMERS_CACHE): FileSpec {
  return {
    url: `${HF_HOSTS[0]}/${repoId}/resolve/main/${entry.path}`,
    mirror: `${HF_HOSTS[1]}/${repoId}/resolve/main/${entry.path}`,
    cacheName,
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256,
  }
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
      // большие LFS-файлы хэшируем потоково — без загрузки 1+ ГБ в память вкладки
      const blob = await res.blob()
      if (expected.size > 0 && blob.size !== expected.size) {
        report.corrupt.push({ file: e.file, url: e.url, cacheName: e.cacheName, reason: 'size-mismatch' })
      } else {
        const hex = expected.sha256
          ? await sha256Blob(blob)
          : await gitBlobSha1Hex(await blob.arrayBuffer())
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
 * Перекачивает ТОЛЬКО переданные (битые) файлы через менеджер загрузок:
 * запись удаляется из кэша и скачивается заново с проверкой хэша.
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
      await (await caches.open(issue.cacheName)).delete(issue.url)
      const spec: FileSpec = {
        url: issue.url,
        cacheName: issue.cacheName,
        path: issue.file,
        size: expected?.size ?? 0,
        sha256: expected?.sha256,
      }
      await startDownload(`repair:${issue.url}`, issue.file, [spec], { immediate: true })
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

/** Вытаскивает repoId из ссылки: huggingface.co/owner/repo, hf-mirror, /tree/…, /resolve/… */
export function parseRepoUrl(input: string): string | null {
  const m = input
    .trim()
    .match(/^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf-mirror\.com)\/([\w.-]+\/[\w.-]+)/)
  return m ? m[1] : null
}

/** Все файлы репозитория как набор для менеджера загрузок («своя модель по ссылке»). */
export async function repoFileSpecs(repoId: string): Promise<FileSpec[]> {
  const tree = await fetchRepoTree(repoId)
  return [...tree.values()].filter((f) => !f.path.startsWith('.')).map((f) => hfFileSpec(repoId, f))
}
