// Видео с вшитыми субтитрами, целиком в браузере: ролик проигрывается в
// скрытом <video>, кадры с наложенным субтитром рисуются в canvas, звук берётся
// из того же ролика, всё пишет MediaRecorder в WebM. Это перекодирование в
// реальном времени: на экспорт уходит столько же времени, сколько длится видео.

import type { Segment } from '@/types'
import { drawSubtitle, subtitleAt } from '@/lib/player'

export function videoExportSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    typeof AudioContext !== 'undefined'
  )
}

function pickMime(): string {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

export async function exportSubtitledVideo(opts: {
  url: string
  segments: Segment[]
  nameOf: (speaker: string) => string
  onProgress: (fraction: number) => void
  signal: AbortSignal
}): Promise<Blob> {
  const video = document.createElement('video')
  video.src = opts.url
  video.playsInline = true
  video.preload = 'auto'
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('video'))
  })
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) throw new Error('video')
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  // звук — через AudioContext, не выводя его на динамики
  const ac = new AudioContext()
  const src = ac.createMediaElementSource(video)
  const dest = ac.createMediaStreamDestination()
  src.connect(dest)

  const stream = canvas.captureStream(30)
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))
  const mime = pickMime()
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)

  let raf = 0
  const draw = () => {
    ctx.drawImage(video, 0, 0, w, h)
    const seg = subtitleAt(opts.segments, video.currentTime)
    if (seg) drawSubtitle(ctx, w, h, seg, video.currentTime, seg.speaker ? opts.nameOf(seg.speaker) : undefined)
    if (video.duration > 0) opts.onProgress(Math.min(1, video.currentTime / video.duration))
    raf = requestAnimationFrame(draw)
  }

  const cleanup = () => {
    cancelAnimationFrame(raf)
    video.pause()
    video.removeAttribute('src')
    video.load()
    void ac.close()
  }

  return new Promise<Blob>((resolve, reject) => {
    const abort = () => {
      cleanup()
      if (rec.state !== 'inactive') rec.stop()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (opts.signal.aborted) return abort()
    opts.signal.addEventListener('abort', abort, { once: true })
    rec.onstop = () => {
      if (opts.signal.aborted) return
      resolve(new Blob(chunks, { type: mime || 'video/webm' }))
    }
    video.onended = () => {
      cleanup()
      if (rec.state !== 'inactive') rec.stop()
      opts.signal.removeEventListener('abort', abort)
    }
    void ac.resume()
    rec.start(1000)
    draw()
    video.play().catch((e) => {
      cleanup()
      reject(e)
    })
  })
}
