// Учёт локальных данных: скачанные модели (Cache API) и сохранённые
// аудиофайлы (IndexedDB). Используется панелью «Хранилище».

export interface CacheEntry {
  url: string
  name: string
  size: number
}

export interface CacheInfo {
  cacheName: string
  entries: CacheEntry[]
  bytes: number
}

function shortName(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    // huggingface: /owner/model/resolve/rev/file — берём модель + файл
    if (u.hostname.includes('huggingface') || u.hostname.includes('hf-mirror')) {
      const file = parts[parts.length - 1] ?? u.hostname
      const model = parts[1] ?? parts[0] ?? ''
      return `${model} / ${file}`
    }
    return parts[parts.length - 1] ?? u.hostname
  } catch {
    return url.slice(-80)
  }
}

/** Все записи всех кэшей браузера с размерами (через blob().size). */
export async function listModelCaches(): Promise<CacheInfo[]> {
  if (typeof caches === 'undefined') return []
  const out: CacheInfo[] = []
  try {
    const names = await caches.keys()
    for (const cacheName of names) {
      const cache = await caches.open(cacheName)
      const requests = await cache.keys()
      const entries: CacheEntry[] = []
      let bytes = 0
      for (const req of requests) {
        try {
          const res = await cache.match(req)
          const size = res ? (await res.blob()).size : 0
          bytes += size
          entries.push({ url: req.url, name: shortName(req.url), size })
        } catch {
          entries.push({ url: req.url, name: shortName(req.url), size: 0 })
        }
      }
      entries.sort((a, b) => b.size - a.size)
      out.push({ cacheName, entries, bytes })
    }
  } catch {
    /* ignore */
  }
  return out
}

export async function deleteCacheEntry(cacheName: string, url: string): Promise<void> {
  try {
    const cache = await caches.open(cacheName)
    await cache.delete(url)
  } catch {
    /* ignore */
  }
}

export async function deleteCache(cacheName: string): Promise<void> {
  try {
    await caches.delete(cacheName)
  } catch {
    /* ignore */
  }
}

/** Сколько байт занимают записи кэша, чей URL содержит подстроку (модель). */
export async function cacheSizeFor(substring: string): Promise<number> {
  const infos = await listModelCaches()
  let bytes = 0
  for (const c of infos)
    for (const e of c.entries) if (e.url.toLowerCase().includes(substring.toLowerCase())) bytes += e.size
  return bytes
}

/** Удалить из всех кэшей записи, чей URL содержит подстроку. Возвращает число удалённых. */
export async function deleteCacheEntriesMatching(substring: string): Promise<number> {
  if (typeof caches === 'undefined') return 0
  let removed = 0
  try {
    const names = await caches.keys()
    const needle = substring.toLowerCase()
    for (const cacheName of names) {
      const cache = await caches.open(cacheName)
      const requests = await cache.keys()
      for (const req of requests) {
        if (req.url.toLowerCase().includes(needle)) {
          if (await cache.delete(req)) removed++
        }
      }
    }
  } catch {
    /* ignore */
  }
  return removed
}

export interface StorageQuota {
  /** сколько уже занято (Cache API + IndexedDB и пр.) */
  usage: number
  /** общий лимит браузера для этого источника */
  quota: number
  /** можно ли доверять цифрам (Chrome — да, Firefox занижает quota) */
  reliable: boolean
}

/** navigator.storage.estimate() — null, если API нет. */
export async function storageQuota(): Promise<StorageQuota | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
    const est = await navigator.storage.estimate()
    if (typeof est.usage !== 'number' || typeof est.quota !== 'number' || est.quota <= 0) return null
    // Firefox отдаёт фиктивную quota ровно 2 ГиБ (групповой лимит) — там warn бессмыслен
    const reliable = est.quota !== 2147483648
    return { usage: est.usage, quota: est.quota, reliable }
  } catch {
    return null
  }
}
