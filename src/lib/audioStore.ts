// Хранилище аудиофайлов в IndexedDB — привязаны к записям истории.
// localStorage для бинарных данных не подходит (лимит ~5 МБ), поэтому
// тексты истории лежат в localStorage, а сами файлы — здесь.

const DB_NAME = 'steno-audio'
const STORE = 'files'
const MAX_STORED = 24 // держим не больше 24 файлов, старые вытесняются

export interface StoredAudioMeta {
  id: string
  name: string
  size: number
  type: string
  createdAt: number
}

interface StoredAudioRecord extends StoredAudioMeta {
  blob: Blob
  /** сконвертированный в WAV вариант (для форматов, требовавших ffmpeg) */
  wav?: Blob
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB недоступен'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB error'))
    })
  } finally {
    db.close()
  }
}

export async function saveAudio(id: string, blob: Blob, name: string): Promise<void> {
  try {
    await withStore('readwrite', (s) =>
      s.put({ id, name, size: blob.size, type: blob.type, createdAt: Date.now(), blob }),
    )
    // вытесняем самые старые сверх лимита
    const all = await listAudio()
    const excess = all.length - MAX_STORED
    if (excess > 0) {
      const oldest = [...all].sort((a, b) => a.createdAt - b.createdAt).slice(0, excess)
      for (const m of oldest) await deleteAudio(m.id)
    }
  } catch {
    // quota/приватный режим — история текста всё равно работает
  }
}

/** Докладывает сконвертированный WAV к уже сохранённому файлу (чтобы не конвертировать повторно). */
export async function saveConvertedWav(id: string, wav: Blob): Promise<void> {
  try {
    const rec = await withStore('readonly', (s) => s.get(id))
    const prev = rec as StoredAudioRecord | undefined
    if (!prev) return
    await withStore('readwrite', (s) => s.put({ ...prev, wav }))
  } catch {
    /* ignore */
  }
}

/** Сконвертированный WAV, если файл изначально требовал ffmpeg. */
export async function getConvertedWav(id: string): Promise<Blob | null> {
  try {
    const rec = await withStore('readonly', (s) => s.get(id))
    return (rec as StoredAudioRecord | undefined)?.wav ?? null
  } catch {
    return null
  }
}

export async function getAudio(id: string): Promise<Blob | null> {
  try {
    const rec = await withStore('readonly', (s) => s.get(id))
    return (rec as StoredAudioRecord | undefined)?.blob ?? null
  } catch {
    return null
  }
}

export async function deleteAudio(id: string): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(id))
  } catch {
    /* ignore */
  }
}

export async function listAudio(): Promise<StoredAudioMeta[]> {
  try {
    const recs = await withStore('readonly', (s) => s.getAll())
    return (recs as StoredAudioRecord[]).map(({ blob: _blob, ...meta }) => meta)
  } catch {
    return []
  }
}

export async function clearAudioStore(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.clear())
  } catch {
    /* ignore */
  }
}
