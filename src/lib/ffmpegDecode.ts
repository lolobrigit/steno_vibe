// Fallback-декодирование форматов, которые браузер не читает нативно
// (m4a/aac в Safari и старых Edge, wma и т.п.): ffmpeg.wasm с CDN.
// Конвертирует в моно PCM f32le 16 кГц — сразу формат Whisper.

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import { computePeaks, encodeWavPcm16, type DecodedAudio } from './audio'

const CORE_VERSION = '0.12.10'
const CORE_SOURCES = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
]

let ffmpeg: FFmpeg | null = null
let loading: Promise<FFmpeg> | null = null

async function loadFfmpeg(onStatus?: (t: string) => void): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg
  if (loading) return loading
  loading = (async () => {
    const ff = new FFmpeg()
    let lastErr: unknown = null
    for (const base of CORE_SOURCES) {
      try {
        onStatus?.('Загрузка конвертера аудио (ffmpeg.wasm, ~25 МБ)…')
        const [coreURL, wasmURL] = await Promise.all([
          toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
          toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
        ])
        await ff.load({ coreURL, wasmURL })
        ffmpeg = ff
        return ff
      } catch (e) {
        lastErr = e
      }
    }
    loading = null
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Не удалось загрузить ffmpeg.wasm — нужен доступ к CDN (jsdelivr/unpkg)')
  })()
  return loading
}

/** ffmpeg.wasm → DecodedAudio (моно 16 кГц + пики для волны) + готовый WAV для кэша. */
export async function decodeWithFfmpeg(
  blob: Blob,
  name: string,
  onStatus?: (t: string) => void,
  onProgress?: (pct: number | null) => void,
): Promise<{ decoded: DecodedAudio; wav: Blob }> {
  onProgress?.(null) // загрузка ядра — индетерминированная фаза
  const ff = await loadFfmpeg(onStatus)
  const inName = `in-${Date.now()}${name.replace(/.*(\.[^.]+)$/, '$1') || '.bin'}`
  const outName = `out-${Date.now()}.f32`
  const onFfProgress = ({ progress }: { progress: number; time: number }) => {
    // progress — доля обработанной длительности (0..1), изредка >1 на хвосте
    onProgress?.(Math.min(99, Math.max(0, Math.round(progress * 100))))
  }
  try {
    await ff.writeFile(inName, new Uint8Array(await blob.arrayBuffer()))
    onStatus?.('Конвертация в WAV-совместимый PCM…')
    ff.on('progress', onFfProgress)
    const code = await ff.exec([
      '-i', inName,
      '-ac', '1',
      '-ar', '16000',
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      outName,
    ])
    if (code !== 0) throw new Error('ffmpeg не смог прочитать файл')
    const data = await ff.readFile(outName)
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string)
    // выравниваем под Float32 (byteOffset может быть не кратен 4)
    const aligned = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(aligned).set(bytes)
    const samples = new Float32Array(aligned)
    return {
      decoded: {
        samples,
        durationSec: samples.length / 16000,
        peaks: computePeaks(samples, 240),
      },
      wav: encodeWavPcm16(samples),
    }
  } finally {
    ff.off('progress', onFfProgress)
    try {
      await ff.deleteFile(inName)
      await ff.deleteFile(outName)
    } catch {
      /* ignore */
    }
  }
}
