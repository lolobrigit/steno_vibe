// Web Worker: локальная диаризация спикеров (кто когда говорил).
// Пайплайн полностью в браузере, аудио не покидает устройство:
//   1. pyannote/segmentation-3.0 (transformers.js, ONNX) — границы реплик,
//      локальные классы спикеров по окнам 10 с;
//   2. WeSpeaker ResNet34 (ONNX Runtime Web) — голосовой отпечаток 256-d
//      на каждую реплику (fbank 80 mel, kaldi-стиль);
//   3. агломеративная кластеризация по косинусной близости отпечатков —
//      глобальные «Спикер N» на весь файл.

import { AutoProcessor, AutoModelForAudioFrameClassification, env } from '@huggingface/transformers'
import * as ort from 'onnxruntime-web'
import { fbank, l2Normalize, clusterEmbeddings } from '../lib/dsp'
import { fetchRepoTree, sha256Hex } from '../lib/modelIntegrity'

env.allowLocalModels = false
ort.env.wasm.numThreads = 1

const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0'
// WeSpeaker ResNet34 (CC-BY-4.0, Wespeaker project) — 26.5 МБ
const EMB_URLS = [
  'https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main/voxceleb_resnet34_LM.onnx',
  'https://hf-mirror.com/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main/voxceleb_resnet34_LM.onnx',
  'https://huggingface.co/hbredin/wespeaker-voxceleb-resnet34-LM/resolve/main/voxceleb_resnet34_LM.onnx',
]
const SAMPLE_RATE = 16000
const WINDOW_SAMPLES = 10 * SAMPLE_RATE
const MIN_UNIT_SEC = 0.35
const MIN_CONFIDENCE = 0.45
const CLUSTER_THRESHOLD = 0.7
const MAX_UNITS = 400

type SegProcessor = {
  (audio: Float32Array): Promise<Record<string, unknown>>
  post_process_speaker_diarization(
    logits: { tolist: () => number[][][] },
    numSamples: number,
  ): Array<Array<{ id: number; start: number; end: number; confidence: number }>>
}

type SegModel = (inputs: Record<string, unknown>) => Promise<{ logits: { tolist: () => number[][][] } }>

interface DiarizedSegment {
  start: number
  end: number
  speaker: string
}

let segProcessor: SegProcessor | null = null
let segModel: SegModel | null = null
let embSession: ort.InferenceSession | null = null

function post(msg: unknown) {
  ;(self as unknown as Worker).postMessage(msg)
}

function status(text: string) {
  post({ type: 'status', text })
}

function progress(pct: number) {
  post({ type: 'progress', pct: Math.min(99, Math.max(0, Math.round(pct))) })
}

// параллельные вызовы (диаризация + предзагрузка из настроек) ждут один
// и тот же процесс загрузки, а не запускают два
let segLoading: Promise<void> | null = null

async function loadSegmentation() {
  if (segProcessor && segModel) return
  if (!segLoading) {
    segLoading = (async () => {
      status('Загрузка модели диаризации (pyannote)…')
      const progress = (p: { status: string; file?: string; progress?: number }) => {
        if (p.status === 'progress_total') {
          // агрегат по байтам всех файлов pyannote
          post({ type: 'load-total', progress: Math.round(p.progress ?? 0) })
        } else if (p.status === 'progress' && p.file) {
          post({
            type: 'load-progress',
            file: `diarize:${p.file}`,
            progress: Math.round(p.progress ?? 0),
          })
        }
      }
      const [proc, model] = await Promise.all([
        AutoProcessor.from_pretrained(SEG_MODEL, { progress_callback: progress }),
        AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, {
          device: 'wasm',
          progress_callback: progress,
        }),
      ])
      segProcessor = proc as unknown as SegProcessor
      segModel = model as unknown as SegModel
    })()
  }
  try {
    await segLoading
  } finally {
    segLoading = null
  }
}

async function fetchWithProgress(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} для ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    if (total > 0) {
      post({
        type: 'load-progress',
        file: 'diarize:speaker-embedding.onnx',
        progress: Math.round((loaded / total) * 100),
      })
      // файл один — его процент и есть общий
      post({ type: 'load-total', progress: Math.round((loaded / total) * 100) })
    }
  }
  const buf = new Uint8Array(loaded)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.length
  }
  return buf.buffer
}

let embLoading: Promise<void> | null = null

async function loadEmbedding() {
  if (embSession) return
  if (!embLoading) embLoading = loadEmbeddingInner()
  try {
    await embLoading
  } finally {
    embLoading = null
  }
}

const EMB_REPO = 'Wespeaker/wespeaker-voxceleb-resnet34-LM'
const EMB_FILE = 'voxceleb_resnet34_LM.onnx'

/** Эталонный SHA-256 onnx-файла с HF (LFS). null — справочник недоступен, качаем вслепую. */
async function embExpectedSha(): Promise<string | null> {
  try {
    const tree = await fetchRepoTree(EMB_REPO)
    return tree.get(EMB_FILE)?.sha256 ?? null
  } catch {
    return null
  }
}

/** Проверка кэшированной копии: хэш из записи «url.sha256» (или эталона HF). */
async function cachedEmbBytes(cache: Cache): Promise<ArrayBuffer | null> {
  const hit = await cache.match(EMB_URLS[0])
  if (!hit) return null
  const bytes = await hit.arrayBuffer()
  // рядом храним посчитанный при скачивании хэш — проверка без сети
  const hashHit = await cache.match(EMB_URLS[0] + '.sha256')
  const stored = hashHit ? (await hashHit.text()).trim() : null
  if (stored) {
    if ((await sha256Hex(bytes)) === stored) return bytes
    // кэш повреждён — выбрасываем и качаем заново
    await cache.delete(EMB_URLS[0])
    await cache.delete(EMB_URLS[0] + '.sha256')
    return null
  }
  // старый кэш без хэша: сверяем с HF, если справочник доступен
  const expected = await embExpectedSha()
  const actual = await sha256Hex(bytes)
  if (expected && actual !== expected) {
    await cache.delete(EMB_URLS[0])
    return null
  }
  await cache.put(EMB_URLS[0] + '.sha256', new Response(actual))
  return bytes
}

async function loadEmbeddingInner() {
  status('Загрузка модели голосовых отпечатков…')

  let bytes: ArrayBuffer | null = null
  try {
    const cache = await caches.open('steno-models')
    bytes = await cachedEmbBytes(cache)
    if (!bytes) {
      let lastErr: unknown = null
      const expected = await embExpectedSha()
      for (const url of EMB_URLS) {
        try {
          const buf = await fetchWithProgress(url)
          // сверяем хэш с HF: битый/обрезанный файл не кладём в кэш
          if (expected) {
            const actual = await sha256Hex(buf)
            if (actual !== expected) {
              throw new Error(`хэш ${EMB_FILE} не сошёлся (${actual.slice(0, 8)}…)`)
            }
          }
          bytes = buf
          if (url === EMB_URLS[0]) {
            await cache.put(url, new Response(buf.slice(0)))
            const hashToStore = expected ?? (await sha256Hex(buf))
            await cache.put(url + '.sha256', new Response(hashToStore))
          }
          break
        } catch (e) {
          lastErr = e
          bytes = null
        }
      }
      if (!bytes) throw lastErr instanceof Error ? lastErr : new Error('download failed')
    }
  } catch (e) {
    // Cache API недоступен (приватный режим и т.п.) — просто качаем
    let lastErr: unknown = e
    for (const url of EMB_URLS) {
      try {
        bytes = await fetchWithProgress(url)
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (!bytes) throw lastErr instanceof Error ? lastErr : new Error('download failed')
  }

  embSession = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
  })
}

interface Unit {
  start: number
  end: number
  cls: number
}

async function segmentAudio(audio: Float32Array): Promise<Unit[]> {
  if (!segProcessor || !segModel) throw new Error('segmentation not loaded')
  const units: Unit[] = []
  const total = audio.length
  let failures = 0
  for (let off = 0; off < total; off += WINDOW_SAMPLES) {
    let chunk = audio.subarray(off, Math.min(off + WINDOW_SAMPLES, total))
    // хвост короче 50 мс — пропускаем: квантованный sincnet-conv падает на
    // почти пустом входе ("Invalid input shape"), а там всё равно нет речи
    if (chunk.length < SAMPLE_RATE / 20) break
    // короткий хвост паддим тишиной до 1 с — минимальная безопасная длина
    if (chunk.length < SAMPLE_RATE) {
      const padded = new Float32Array(SAMPLE_RATE)
      padded.set(chunk)
      chunk = padded
    }
    let result: Array<Array<{ id: number; start: number; end: number; confidence: number }>>
    try {
      const inputs = await segProcessor(chunk)
      const { logits } = await segModel(inputs)
      result = segProcessor.post_process_speaker_diarization(logits, chunk.length)
      failures = 0
    } catch (e) {
      // одно битое окно не должно ронять всю диаризацию; но если падает
      // подряд — рантайм сломан, выходим с ошибкой быстро, а не висим
      failures++
      if (failures >= 3) throw e instanceof Error ? e : new Error(String(e))
      continue
    }
    const base = off / SAMPLE_RATE
    for (const seg of result[0] ?? []) {
      if (seg.confidence < MIN_CONFIDENCE) continue
      if (seg.end - seg.start < 0.05) continue
      units.push({ start: seg.start + base, end: seg.end + base, cls: seg.id })
    }
    status(`Диаризация: анализ ${Math.round(Math.min(off + WINDOW_SAMPLES, total) / SAMPLE_RATE)} с…`)
    // фаза сегментации занимает львиную долю времени — шкала 0..70%
    progress((Math.min(off + WINDOW_SAMPLES, total) / total) * 70)
  }
  // склеиваем подряд идущие реплики одного локального класса
  const merged: Unit[] = []
  for (const u of units) {
    const last = merged[merged.length - 1]
    if (last && last.cls === u.cls && u.start - last.end < 0.3) last.end = u.end
    else merged.push({ ...u })
  }
  return merged
}

async function embed(audio: Float32Array, start: number, end: number): Promise<Float32Array> {
  if (!embSession) throw new Error('embedding not loaded')
  const from = Math.max(0, Math.floor(start * SAMPLE_RATE))
  const to = Math.min(audio.length, Math.ceil(end * SAMPLE_RATE))
  const slice = audio.subarray(from, to)
  const { features, numFrames, numMelBins } = fbank(slice, SAMPLE_RATE, 80)
  const inputName = embSession.inputNames[0]
  const tensor = new ort.Tensor('float32', features, [1, numFrames, numMelBins])
  const out = await embSession.run({ [inputName]: tensor })
  const emb = out[embSession.outputNames[0]]
  return l2Normalize(new Float32Array(emb.data as Float32Array))
}

async function diarize(audio: Float32Array): Promise<DiarizedSegment[]> {
  await loadSegmentation()
  await loadEmbedding()

  const all = await segmentAudio(audio)
  // эмбеддинги считаем только по одиночным классам (0..2) и достаточно длинным репликам
  let units = all.filter((u) => u.cls <= 2 && u.end - u.start >= MIN_UNIT_SEC)
  if (units.length > MAX_UNITS) {
    units = [...units].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, MAX_UNITS)
    units.sort((a, b) => a.start - b.start)
  }
  if (units.length === 0) return []

  status('Диаризация: голосовые отпечатки…')
  const embeddings: Float32Array[] = []
  for (let i = 0; i < units.length; i++) {
    embeddings.push(await embed(audio, units[i].start, units[i].end))
    if (i % 8 === 7) status(`Диаризация: отпечатки ${i + 1}/${units.length}…`)
    progress(70 + ((i + 1) / units.length) * 25)
  }

  status('Диаризация: группировка спикеров…')
  progress(97)
  const labels = clusterEmbeddings(embeddings, CLUSTER_THRESHOLD)

  // нумеруем спикеров по суммарной длительности речи (самый говорливый — №1)
  const durations = new Map<number, number>()
  units.forEach((u, i) => {
    durations.set(labels[i], (durations.get(labels[i]) ?? 0) + (u.end - u.start))
  })
  const order = [...durations.entries()].sort((a, b) => b[1] - a[1])
  const nameOf = new Map(order.map(([cluster], i) => [cluster, `Спикер ${i + 1}`]))

  const out: DiarizedSegment[] = []
  for (let i = 0; i < units.length; i++) {
    const speaker = nameOf.get(labels[i]) ?? 'Спикер ?'
    const last = out[out.length - 1]
    if (last && last.speaker === speaker && units[i].start - last.end < 0.8) last.end = units[i].end
    else out.push({ start: units[i].start, end: units[i].end, speaker })
  }
  return out
}

self.onmessage = async (
  ev: MessageEvent<{ type: 'diarize'; audio: Float32Array } | { type: 'load' }>,
) => {
  const msg = ev.data
  try {
    if (msg.type === 'load') {
      await loadSegmentation()
      await loadEmbedding()
      post({ type: 'ready' })
      return
    }
    if (msg.type !== 'diarize') return
    if (msg.audio.length < SAMPLE_RATE) {
      post({ type: 'result', segments: [] })
      return
    }
    const segments = await diarize(msg.audio)
    post({ type: 'result', segments })
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
