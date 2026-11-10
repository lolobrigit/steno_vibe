// Менеджер загрузок файлов моделей: пауза, продолжение, докачка после обрыва.
//
// Зачем свой загрузчик. Раньше модели скачивал сам transformers.js внутри
// pipeline(): один fetch на файл, без таймаута и без докачки. Если соединение
// с CDN замирало (а на файлах в сотни мегабайт это случается регулярно),
// промис не завершался никогда — процент навсегда останавливался там, где
// оборвался поток («Whisper Small на 54%», «Large на 35%»). К тому же файл
// целиком копился в памяти вкладки.
//
// Теперь:
//   • поток пишется на диск кусками (IndexedDB), память вкладки не растёт;
//   • тишина дольше STALL_MS считается обрывом: запрос отменяется и
//     повторяется с заголовком Range с уже сохранённого байта;
//   • недокачанное переживает паузу, перезагрузку страницы и падение вкладки;
//   • готовый файл проверяется по размеру и SHA-256 и кладётся в Cache API
//     под тем ключом, по которому его ищет transformers.js, — движок потом
//     поднимает модель из кэша вообще без сети.

import { t } from '@/i18n'
import { abortError, isAbort } from './gpu'
import { sha256Blob } from './sha256'

export interface FileSpec {
  /** основной URL; он же ключ записи в Cache API */
  url: string
  /** зеркало с тем же содержимым (hf-mirror) */
  mirror?: string
  cacheName: string
  /** путь файла в репозитории — подпись в интерфейсе */
  path: string
  /** ожидаемый размер, 0 — неизвестен */
  size: number
  sha256?: string
}

export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'error'

export interface JobState {
  id: string
  label: string
  status: JobStatus
  loaded: number
  total: number
  /** текущий файл */
  file: string
  /** verify — идёт проверка хэша; retry — переподключение после обрыва */
  phase: 'download' | 'verify' | 'retry'
  error?: string
}

interface Job {
  state: JobState
  files: FileSpec[]
  controller: AbortController | null
  /** промис идущего runJob — отмена ждёт его, прежде чем чистить куски */
  task: Promise<void> | null
  waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }>
}

const CHUNK_BYTES = 4 * 1024 * 1024
const STALL_MS = 45_000
const CONNECT_MS = 30_000
const MAX_RETRIES = 8

// ── IndexedDB: недокачанные куски ────────────────────────────────

const DB_NAME = 'steno-downloads'
const STORE = 'chunks'
let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: ['url', 'seq'] })
        store.createIndex('url', 'url')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB'))
    })
    dbPromise.catch(() => {
      dbPromise = null
    })
  }
  return dbPromise
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB'))
  })
}

interface ChunkRec {
  url: string
  seq: number
  blob: Blob
}

async function listChunks(url: string): Promise<ChunkRec[]> {
  const d = await db()
  const recs = (await reqDone(
    d.transaction(STORE, 'readonly').objectStore(STORE).index('url').getAll(IDBKeyRange.only(url)),
  )) as ChunkRec[]
  return recs.sort((a, b) => a.seq - b.seq)
}

async function putChunk(url: string, seq: number, blob: Blob): Promise<void> {
  const d = await db()
  const tx = d.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).put({ url, seq, blob })
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB'))
  })
}

async function clearChunks(url: string): Promise<void> {
  try {
    const d = await db()
    await reqDone(
      d
        .transaction(STORE, 'readwrite')
        .objectStore(STORE)
        .delete(IDBKeyRange.bound([url, 0], [url, Number.MAX_SAFE_INTEGER])),
    )
  } catch {
    /* ignore */
  }
}

function isQuota(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Промис с дедлайном: по истечении вызывает onTimeout и отклоняется. */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error('stalled'))
    }, ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// ── Реестр задач ─────────────────────────────────────────────────

const jobs = new Map<string, Job>()
const listeners = new Set<() => void>()
let snapshot: Record<string, JobState> = {}
let emitTimer: ReturnType<typeof setTimeout> | null = null

function emitNow() {
  emitTimer = null
  const next: Record<string, JobState> = {}
  for (const [id, j] of jobs) next[id] = { ...j.state }
  snapshot = next
  listeners.forEach((l) => l())
}

/** Прогресс сыплется на каждый сетевой пакет — отдаём в UI не чаще 5 раз/с. */
function emit(immediate = false) {
  if (immediate) {
    if (emitTimer) clearTimeout(emitTimer)
    emitNow()
  } else if (!emitTimer) {
    emitTimer = setTimeout(emitNow, 200)
  }
}

export function subscribeDownloads(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function downloadsSnapshot(): Record<string, JobState> {
  return snapshot
}

// ── Скачивание одного файла ──────────────────────────────────────

async function cachedSize(spec: FileSpec): Promise<number | null> {
  const cache = await caches.open(spec.cacheName)
  const hit = await cache.match(spec.url)
  if (!hit) return null
  const size = (await hit.blob()).size
  if (spec.size > 0 && size !== spec.size) {
    await cache.delete(spec.url) // обрезанная запись от старого загрузчика
    return null
  }
  return size
}

async function downloadFile(
  spec: FileSpec,
  signal: AbortSignal,
  onBytes: (loaded: number) => void,
  onPhase: (phase: JobState['phase']) => void,
): Promise<number> {
  const ready = await cachedSize(spec)
  if (ready !== null) return ready

  let offset = 0
  let seq = 0
  const sync = async () => {
    const parts = await listChunks(spec.url)
    offset = parts.reduce((a, p) => a + p.blob.size, 0)
    seq = parts.length ? parts[parts.length - 1].seq + 1 : 0
    // куски обязаны идти подряд с нуля; дыра или лишние байты — начинаем файл заново
    const contiguous = parts.every((p, i) => p.seq === i)
    if (!contiguous || (spec.size > 0 && offset > spec.size)) {
      await clearChunks(spec.url)
      offset = 0
      seq = 0
    }
  }
  await sync()
  onBytes(offset)

  let attempt = 0
  let useMirror = false
  let complete = spec.size > 0 && offset === spec.size

  while (!complete) {
    if (signal.aborted) throw abortError()
    const ctl = new AbortController()
    const onAbort = () => ctl.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const url = useMirror && spec.mirror ? spec.mirror : spec.url
      const res = await withDeadline(
        fetch(url, {
          signal: ctl.signal,
          cache: 'no-store',
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined,
        }),
        CONNECT_MS,
        () => ctl.abort(),
      )
      if (res.status === 416) {
        // сервер не признал диапазон — сохранённое не годится, начинаем файл заново
        await clearChunks(spec.url)
        offset = 0
        seq = 0
        throw new Error('range rejected')
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      if (offset > 0 && res.status !== 206) {
        // Range проигнорирован: пришёл файл целиком с нуля
        await clearChunks(spec.url)
        offset = 0
        seq = 0
      }
      onPhase('download')
      const reader = res.body.getReader()
      let pending: Uint8Array[] = []
      let pendingBytes = 0
      const flush = async () => {
        if (pendingBytes === 0) return
        const blob = new Blob(pending as BlobPart[])
        pending = []
        pendingBytes = 0
        await putChunk(spec.url, seq++, blob)
      }
      try {
        for (;;) {
          const { done, value } = await withDeadline(reader.read(), STALL_MS, () => ctl.abort())
          if (done) break
          pending.push(value)
          pendingBytes += value.length
          offset += value.length
          onBytes(offset)
          if (pendingBytes >= CHUNK_BYTES) await flush()
        }
      } finally {
        // что успело прийти — сохраняем даже при обрыве и при паузе
        await flush().catch((e: unknown) => {
          if (isQuota(e)) throw e
        })
      }
      if (spec.size > 0 && offset < spec.size) throw new Error('truncated')
      complete = true
    } catch (e) {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) throw abortError()
      if (isQuota(e)) throw new Error(t('dl.err.quota'))
      attempt++
      if (attempt > MAX_RETRIES) {
        throw new Error(t('dl.err.network', { file: spec.path }))
      }
      if (attempt % 2 === 0 && spec.mirror) useMirror = !useMirror
      onPhase('retry')
      await sync()
      onBytes(offset)
      await sleep(Math.min(15_000, 500 * 2 ** attempt), signal)
      continue
    }
    signal.removeEventListener('abort', onAbort)
  }

  // сборка: куски остаются на диске, Blob — лишь ссылка на них
  const parts = await listChunks(spec.url)
  const blob = new Blob(
    parts.map((p) => p.blob),
    { type: 'application/octet-stream' },
  )
  if (spec.size > 0 && blob.size !== spec.size) {
    await clearChunks(spec.url)
    throw new Error(t('dl.err.hash', { file: spec.path }))
  }
  if (spec.sha256) {
    onPhase('verify')
    const hex = await sha256Blob(blob, signal)
    if (hex !== spec.sha256.toLowerCase()) {
      await clearChunks(spec.url)
      throw new Error(t('dl.err.hash', { file: spec.path }))
    }
  }
  try {
    const cache = await caches.open(spec.cacheName)
    await cache.put(
      spec.url,
      new Response(blob, {
        headers: {
          'Content-Length': String(blob.size),
          'Content-Type': 'application/octet-stream',
        },
      }),
    )
  } catch (e) {
    if (isQuota(e)) throw new Error(t('dl.err.quota'))
    throw e
  }
  await clearChunks(spec.url)
  return blob.size
}

// ── Задача = набор файлов одной модели ───────────────────────────

const lastRun = new Map<string, Promise<void>>()

/**
 * Запуск задачи. Прогоны одной модели идут строго друг за другом: после
 * паузы прерванный поток ещё дописывает последний кусок, и новый прогон
 * обязан дождаться его, иначе куски перемешаются.
 */
function runJob(job: Job): Promise<void> {
  job.state = { ...job.state, status: 'running', phase: 'download', error: undefined }
  emit(true)
  const prev = lastRun.get(job.state.id) ?? Promise.resolve()
  const run = prev.then(() => runJobInner(job))
  lastRun.set(job.state.id, run)
  return run
}

async function runJobInner(job: Job): Promise<void> {
  if (job.state.status !== 'running') {
    // успели поставить на паузу или отменить до фактического старта
    emit(true)
    job.waiters.splice(0).forEach((w) => w.reject(abortError()))
    pump()
    return
  }
  const ctl = new AbortController()
  job.controller = ctl
  try {
    let doneBytes = 0
    for (const spec of job.files) {
      job.state.file = spec.path
      const size = await downloadFile(
        spec,
        ctl.signal,
        (loaded) => {
          job.state.loaded = doneBytes + loaded
          if (job.state.total < job.state.loaded) job.state.total = job.state.loaded
          emit()
        },
        (phase) => {
          job.state.phase = phase
          emit()
        },
      )
      doneBytes += size
      job.state.loaded = doneBytes
      emit()
    }
    job.state = { ...job.state, status: 'done', loaded: doneBytes, total: doneBytes, phase: 'download' }
    job.controller = null
    emit(true)
    job.waiters.splice(0).forEach((w) => w.resolve())
  } catch (e) {
    job.controller = null
    if (isAbort(e)) {
      // пауза/отмена: статус уже выставил вызвавший (pause/cancel)
      if (job.state.status === 'running') job.state.status = 'paused'
      emit(true)
      job.waiters.splice(0).forEach((w) => w.reject(abortError()))
    } else {
      job.state = {
        ...job.state,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      }
      emit(true)
      job.waiters.splice(0).forEach((w) => w.reject(e))
    }
  } finally {
    pump()
  }
}

/** Очередь из настроек: следующая модель стартует, когда освободился слот. */
function pump() {
  for (const j of jobs.values()) if (j.state.status === 'running') return
  for (const j of jobs.values()) {
    if (j.state.status === 'queued') {
      j.task = runJob(j)
      return
    }
  }
}

function makeJob(id: string, label: string, files: FileSpec[]): Job {
  const job: Job = {
    state: {
      id,
      label,
      status: 'queued',
      loaded: 0,
      total: files.reduce((a, f) => a + f.size, 0),
      file: '',
      phase: 'download',
    },
    files,
    controller: null,
    task: null,
    waiters: [],
  }
  jobs.set(id, job)
  return job
}

/**
 * Поставить модель на скачивание. immediate=false — в общую очередь (кнопка
 * в настройках), immediate=true — стартует сразу (модель ждёт распознавание).
 * Повторный вызов для уже идущей задачи просто присоединяется к ней.
 */
export function startDownload(
  id: string,
  label: string,
  files: FileSpec[],
  opts: { immediate?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  let job = jobs.get(id)
  if (!job || job.state.status === 'done' || job.state.status === 'error' || job.state.status === 'paused') {
    const prevWaiters = job?.waiters ?? []
    job = makeJob(id, label, files)
    job.waiters = prevWaiters
  }
  const j = job
  const promise = new Promise<void>((resolve, reject) => {
    j.waiters.push({ resolve, reject })
  })
  if (opts.signal) {
    const signal = opts.signal
    if (signal.aborted) {
      pauseDownload(id)
    } else {
      const onAbort = () => pauseDownload(id)
      signal.addEventListener('abort', onAbort, { once: true })
      void promise.catch(() => undefined).finally(() => signal.removeEventListener('abort', onAbort))
    }
  }
  if (j.state.status === 'queued') {
    if (opts.immediate) j.task = runJob(j)
    else {
      emit(true)
      pump()
    }
  }
  return promise
}

/** Пауза: соединение рвём, скачанное остаётся на диске. */
export function pauseDownload(id: string) {
  const job = jobs.get(id)
  if (!job) return
  if (job.state.status === 'running') {
    job.state.status = 'paused'
    job.controller?.abort()
  } else if (job.state.status === 'queued') {
    job.state.status = 'paused'
    emit(true)
    job.waiters.splice(0).forEach((w) => w.reject(abortError()))
  }
}

export function resumeDownload(id: string) {
  const job = jobs.get(id)
  if (!job || (job.state.status !== 'paused' && job.state.status !== 'error')) return
  void startDownload(id, job.state.label, job.files).catch(() => undefined)
}

/** Отмена: рвём соединение и удаляем недокачанное. */
export async function cancelDownload(id: string, files?: FileSpec[]): Promise<void> {
  const job = jobs.get(id)
  const list = job?.files ?? files ?? []
  if (job) {
    if (job.state.status === 'running') {
      job.state.status = 'paused'
      job.controller?.abort()
    }
    job.waiters.splice(0).forEach((w) => w.reject(abortError()))
    jobs.delete(id)
    // дожидаемся, пока прерванный поток допишет последний кусок, иначе он
    // появится уже после очистки и испортит следующую докачку
    await job.task?.catch(() => undefined)
  }
  for (const f of list) await clearChunks(f.url)
  emit(true)
  pump()
}

/** Убрать завершённую/упавшую задачу из списка (после удаления модели). */
export function forgetDownload(id: string) {
  const job = jobs.get(id)
  if (job && job.state.status !== 'running' && job.state.status !== 'queued') {
    jobs.delete(id)
    emit(true)
  }
}

/** Сколько байт набора уже в кэше и сколько лежит недокачанным. */
export async function inspectFiles(
  files: FileSpec[],
): Promise<{ cached: number; partial: number; total: number; complete: boolean }> {
  let cached = 0
  let partial = 0
  let total = 0
  let complete = true
  for (const f of files) {
    total += f.size
    let size: number | null = null
    try {
      const hit = await (await caches.open(f.cacheName)).match(f.url)
      if (hit) size = (await hit.blob()).size
    } catch {
      size = null
    }
    if (size !== null && (f.size === 0 || size === f.size)) {
      cached += size
      continue
    }
    complete = false
    try {
      partial += (await listChunks(f.url)).reduce((a, p) => a + p.blob.size, 0)
    } catch {
      /* ignore */
    }
  }
  return { cached, partial, total, complete }
}

/** Удалить недокачанные куски, чей URL содержит подстроку (при удалении модели). */
export async function clearPartialsMatching(substring: string): Promise<void> {
  try {
    const d = await db()
    const needle = substring.toLowerCase()
    const keys = (await reqDone(
      d.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys(),
    )) as Array<[string, number]>
    const urls = new Set(keys.map((k) => k[0]).filter((u) => u.toLowerCase().includes(needle)))
    for (const u of urls) await clearChunks(u)
  } catch {
    /* ignore */
  }
}
