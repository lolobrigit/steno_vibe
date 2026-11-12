// План загрузки локальной модели: какие варианты (устройство + квантизация)
// пробовать и какие именно файлы нужны каждому варианту.
//
// Раньше воркер сам перебирал варианты внутри pipeline(): если WebGPU-сборка
// не поднималась, он молча начинал качать другой набор файлов (для Large —
// fp32 на 2,5+ ГБ), и прогресс прыгал или зависал. Теперь список вариантов
// один на главный поток и воркер, файлы каждого варианта известны заранее и
// скачиваются менеджером загрузок, а воркеру остаётся поднять модель из кэша.

import { inspectFiles, startDownload, type FileSpec } from './downloads'
import { detectGpu, isAbort, type GpuCaps } from './gpu'
import { fetchRepoTree, hfFileSpec, HF_HOSTS } from './modelIntegrity'

export type Device = 'webgpu' | 'wasm'

export interface Variant {
  /** стабильный идентификатор варианта (для запоминания удачного) */
  key: string
  device: Device
  /** dtype для transformers.js: строка или карта по именам onnx-файлов */
  dtype: string | Record<string, string>
  /** onnx-файлы без расширения, относительно onnx/ */
  onnx: string[]
}

const SUFFIX: Record<string, string> = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  int8: '_int8',
  uint8: '_uint8',
  q4: '_q4',
  q4f16: '_q4f16',
  bnb4: '_bnb4',
}

function whisper(device: Device, enc: string, dec: string): Variant {
  return {
    key: `${device}:${enc}/${dec}`,
    device,
    dtype: { encoder_model: enc, decoder_model_merged: dec },
    onnx: [`encoder_model${SUFFIX[enc]}`, `decoder_model_merged${SUFFIX[dec]}`],
  }
}

/**
 * Варианты Whisper от лучшего к запасному. heavy — большие модели (Large):
 * им fp32 не предлагаем вовсе — энкодер весит 2,5 ГБ и не помещается ни в
 * память вкладки, ни в лимит WASM.
 */
export function whisperVariants(heavy: boolean, gpu: GpuCaps): Variant[] {
  const out: Variant[] = []
  if (gpu.webgpu) {
    if (gpu.f16) out.push(whisper('webgpu', 'fp16', 'q4'))
    if (heavy) out.push(whisper('webgpu', 'q4', 'q4'))
    else out.push(whisper('webgpu', 'fp32', 'q4'), whisper('webgpu', 'fp32', 'fp32'))
  }
  if (!heavy) out.push(whisper('wasm', 'fp32', 'q8'))
  out.push(whisper('wasm', 'q8', 'q8'))
  return out
}

function single(device: Device, dtype: string): Variant {
  return { key: `${device}:${dtype}`, device, dtype, onnx: [`model${SUFFIX[dtype]}`] }
}

/** Варианты локальной LLM (text-generation, один model*.onnx). */
export function llmVariants(gpu: GpuCaps): Variant[] {
  const out: Variant[] = []
  if (gpu.webgpu) {
    if (gpu.f16) out.push(single('webgpu', 'q4f16'))
    out.push(single('webgpu', 'q4'))
  }
  out.push(single('wasm', 'q4'), single('wasm', 'q8'))
  return out
}

/** pyannote-сегментация: transformers.js на WASM берёт q8, если он есть, иначе fp32. */
export function segmentationVariants(): Variant[] {
  return [single('wasm', 'q8'), single('wasm', 'fp32')]
}

// мелкие файлы конфигурации, которые читает transformers.js (берём те, что есть в репозитории)
const BASE_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'chat_template.jinja',
]

const PLAN_KEY = 'steno.modelfiles.v1'
const VARIANT_KEY = 'steno.variant.v1'
const PLAN_TTL_MS = 7 * 24 * 3600 * 1000

interface StoredPlan {
  at: number
  /** null — такого варианта в репозитории нет */
  files: FileSpec[] | null
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw) as T
  } catch {
    /* ignore */
  }
  return fallback
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

/** Сохранённый список файлов варианта (работает офлайн). undefined — ещё не запрашивали. */
export function storedPlan(repo: string, variant: Variant): FileSpec[] | null | undefined {
  const all = readJson<Record<string, StoredPlan>>(PLAN_KEY, {})
  const hit = all[`${repo}|${variant.key}`]
  return hit ? hit.files : undefined
}

/**
 * Файлы варианта по дереву репозитория. null — нужного onnx в репозитории нет
 * (вариант пропускаем). Бросает, если нет сети и нет сохранённого списка.
 */
export async function resolveFiles(repo: string, variant: Variant): Promise<FileSpec[] | null> {
  const all = readJson<Record<string, StoredPlan>>(PLAN_KEY, {})
  const id = `${repo}|${variant.key}`
  const hit = all[id]
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.files
  let tree
  try {
    tree = await fetchRepoTree(repo)
  } catch (e) {
    if (hit) return hit.files // офлайн: устаревший список лучше никакого
    throw e
  }
  let files: FileSpec[] | null = []
  for (const name of variant.onnx) {
    const path = `onnx/${name}.onnx`
    const entry = tree.get(path)
    if (!entry) {
      files = null
      break
    }
    files.push(hfFileSpec(repo, entry))
    // внешние данные весов: model.onnx_data, model.onnx_data_1…
    for (const [p, e] of tree) if (p.startsWith(`${path}_data`)) files.push(hfFileSpec(repo, e))
  }
  if (files) {
    const base = BASE_FILES.map((p) => tree.get(p)).filter((e) => !!e)
    files = [...base.map((e) => hfFileSpec(repo, e)), ...files]
  }
  all[id] = { at: Date.now(), files }
  writeJson(PLAN_KEY, all)
  return files
}

/** Удачный вариант запоминаем: в следующий раз начинаем с него. */
export function rememberVariant(repo: string, key: string) {
  const all = readJson<Record<string, string>>(VARIANT_KEY, {})
  all[repo] = key
  writeJson(VARIANT_KEY, all)
}

export function orderVariants(repo: string, variants: Variant[]): Variant[] {
  const key = readJson<Record<string, string>>(VARIANT_KEY, {})[repo]
  const first = variants.find((v) => v.key === key)
  return first ? [first, ...variants.filter((v) => v !== first)] : variants
}

/** Первый вариант, который есть в репозитории, и его файлы — для кнопки «Скачать». */
export async function planDownload(
  repo: string,
  variants: Variant[],
): Promise<{ variant: Variant; files: FileSpec[] } | null> {
  for (const variant of orderVariants(repo, variants)) {
    const files = await resolveFiles(repo, variant)
    if (files) return { variant, files }
  }
  return null
}

export interface PrepareOptions {
  /** id задачи в менеджере загрузок (строка модели в настройках) */
  jobId: string
  label: string
  repo: string
  variants: Variant[]
  /** поднять модель в воркере из кэша; бросает, если вариант не завёлся */
  load: (variant: Variant) => Promise<void>
  signal?: AbortSignal
  /**
   * этап: storage — все файлы уже в кэше браузера, сети не нужно; download —
   * докачка файлов варианта; init — запуск модели в воркере
   */
  onStage?: (stage: 'storage' | 'download' | 'init', variant: Variant) => void
}

/**
 * Общий цикл для Whisper и LLM: по очереди для каждого варианта — докачать
 * его файлы менеджером, затем поднять модель. Первый заработавший вариант
 * запоминается.
 */
export async function prepareModel(o: PrepareOptions): Promise<Variant> {
  let lastErr: unknown = null
  for (const variant of orderVariants(o.repo, o.variants)) {
    if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    let files: FileSpec[] | null | undefined
    try {
      files = await resolveFiles(o.repo, variant)
    } catch {
      files = undefined // нет сети и списка — пусть воркер попробует из кэша
    }
    if (files === null) continue
    // всё уже в кэше (или списка файлов нет, а сети тоже) — модель поднимается
    // из хранилища браузера; пользователю так и говорим, а не «скачиваю»
    const have = files ? await inspectFiles(files).catch(() => null) : null
    if (files && !have?.complete) {
      // ошибка сети при скачивании от варианта не зависит — перебирать дальше бессмысленно
      o.onStage?.('download', variant)
      await startDownload(o.jobId, o.label, files, { immediate: true, signal: o.signal })
    } else {
      o.onStage?.('storage', variant)
    }
    try {
      o.onStage?.('init', variant)
      await o.load(variant)
      rememberVariant(o.repo, variant.key)
      return variant
    } catch (e) {
      if (isAbort(e) || o.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('No compatible model build found')
}

// ── Диаризация: pyannote (transformers-cache) + WeSpeaker (steno-models) ──

export const SEG_REPO = 'onnx-community/pyannote-segmentation-3.0'
export const EMB_REPO = 'Wespeaker/wespeaker-voxceleb-resnet34-LM'
const EMB_FILE = 'voxceleb_resnet34_LM.onnx'

/** Файлы пакета диаризации. Ключи кэша совпадают с теми, что читает diarize.worker. */
export async function diarizeFiles(): Promise<FileSpec[]> {
  const seg = await planDownload(SEG_REPO, segmentationVariants())
  const cached = readJson<Record<string, StoredPlan>>(PLAN_KEY, {})[`${EMB_REPO}|emb`]
  let emb: FileSpec[] | null = cached && Date.now() - cached.at < PLAN_TTL_MS ? cached.files : null
  if (!emb) {
    const entry = (await fetchRepoTree(EMB_REPO)).get(EMB_FILE)
    emb = [
      {
        url: `${HF_HOSTS[0]}/${EMB_REPO}/resolve/main/${EMB_FILE}`,
        mirror: `${HF_HOSTS[1]}/${EMB_REPO}/resolve/main/${EMB_FILE}`,
        cacheName: 'steno-models',
        path: EMB_FILE,
        size: entry?.size ?? 0,
        sha256: entry?.sha256,
      },
    ]
    const all = readJson<Record<string, StoredPlan>>(PLAN_KEY, {})
    all[`${EMB_REPO}|emb`] = { at: Date.now(), files: emb }
    writeJson(PLAN_KEY, all)
  }
  return [...(seg?.files ?? []), ...emb]
}

export const DIARIZE_JOB_ID = 'diarize-pack'

export { detectGpu }

/** Сохранённый (без сети) список файлов предпочтительного варианта модели. */
export function storedDownloadPlan(repo: string, variants: Variant[]): FileSpec[] | undefined {
  for (const v of orderVariants(repo, variants)) {
    const files = storedPlan(repo, v)
    if (Array.isArray(files)) return files
  }
  return undefined
}
