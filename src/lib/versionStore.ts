// Версии расшифровки лежат в IndexedDB, а не в localStorage: у записи их до
// MAX_VERSIONS, каждая с полным списком реплик — вместе они быстро
// переполнили бы квоту localStorage (~5 МБ), общую с историей и настройками.
// Ключ — id записи истории.

import type { TranscriptVersion } from '../types'

const DB_NAME = 'steno-versions'
const STORE = 'docs'

export interface StoredVersions {
  id: string
  versions: TranscriptVersion[]
  activeVersionId: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'))
  })
}

async function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB error'))
    })
  } finally {
    db.close()
  }
}

export async function saveVersions(rec: StoredVersions): Promise<void> {
  try {
    await run('readwrite', (s) => s.put(rec))
  } catch {
    /* хранилище недоступно или переполнено — активная версия есть в истории */
  }
}

export async function loadVersions(id: string): Promise<StoredVersions | null> {
  try {
    return ((await run('readonly', (s) => s.get(id))) as StoredVersions | undefined) ?? null
  } catch {
    return null
  }
}

export async function deleteVersions(id: string): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(id))
  } catch {
    /* ignore */
  }
}

export async function clearVersions(): Promise<void> {
  try {
    await run('readwrite', (s) => s.clear())
  } catch {
    /* ignore */
  }
}
