/** Декодирование аудиофайла в моно Float32Array 16 кГц (формат Whisper). */

import { t } from '@/i18n'

export interface DecodedAudio {
  samples: Float32Array
  durationSec: number
  peaks: number[] // нормированные пики для отрисовки волны
}

export async function decodeAudio(blob: Blob): Promise<DecodedAudio> {
  const arrayBuffer = await blob.arrayBuffer()
  const ctx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer)
  } finally {
    void ctx.close()
  }

  // Ресемплинг + сведение в моно через OfflineAudioContext
  const targetRate = 16000
  const frames = Math.ceil(decoded.duration * targetRate)
  const offline = new OfflineAudioContext(1, frames, targetRate)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start(0)
  const rendered = await offline.startRendering()
  const samples = rendered.getChannelData(0)

  return {
    samples,
    durationSec: decoded.duration,
    peaks: computePeaks(samples, 240),
  }
}

export function computePeaks(samples: Float32Array, buckets: number): number[] {
  const peaks = new Array<number>(buckets).fill(0)
  const step = Math.max(1, Math.floor(samples.length / buckets))
  for (let i = 0; i < buckets; i++) {
    const start = i * step
    let max = 0
    for (let j = start; j < Math.min(start + step, samples.length); j += 4) {
      const v = Math.abs(samples[j])
      if (v > max) max = v
    }
    peaks[i] = max
  }
  const maxPeak = Math.max(...peaks, 1e-4)
  return peaks.map((p) => p / maxPeak)
}

/**
 * PCM16 mono WAV из Float32-сэмплов. Используется, чтобы сохранить результат
 * ffmpeg-конвертации: при повторном открытии из истории WAV декодируется
 * браузером нативно — без повторного прогона ffmpeg.wasm.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate = 16000): Blob {
  const dataLen = samples.length * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const v = new DataView(buf)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true) // размер fmt-чанка
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // моно
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // байт/сек
  v.setUint16(32, 2, true) // выравнивание блока
  v.setUint16(34, 16, true) // бит/сэмпл
  writeStr(36, 'data')
  v.setUint32(40, dataLen, true)
  let off = 44
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatTimecode(sec: number, withMs = false): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.floor((s % 1) * 1000)
  const base = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${ss
    .toString()
    .padStart(2, '0')}`
  return withMs ? `${base}.${ms.toString().padStart(3, '0')}` : base
}

/** «42 s», «5 min 03 s» — единицы на языке интерфейса. */
export function formatDurationShort(sec: number): string {
  const total = Math.round(sec)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s} ${t('u.sec')}`
  return `${m} ${t('u.min')} ${s.toString().padStart(2, '0')} ${t('u.sec')}`
}
