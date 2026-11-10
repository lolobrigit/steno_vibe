import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'

/**
 * Источники записи:
 *   mic    — микрофон (аудио);
 *   tab    — звук вкладки/экрана + микрофон (аудио);
 *   screen — видео экрана/вкладки со звуком + микрофон;
 *   camera — видео с камеры + микрофон.
 */
export type RecordSource = 'mic' | 'tab' | 'screen' | 'camera'

export const isVideoSource = (s: RecordSource | null): boolean => s === 'screen' || s === 'camera'

export interface RecorderState {
  recording: boolean
  source: RecordSource | null
  elapsed: number
  error: string | null
  /** массив уровней 0..1 для живой волны */
  levels: number[]
  /** при записи вкладки/экрана: микрофон подмешан в запись */
  micMixed: boolean
  /** видеопоток для живого превью (только видеозапись) */
  preview: MediaStream | null
}

const LEVELS_LEN = 96
const SILENCE_RMS = 0.012
const SILENCE_LIMIT_MS = 10000
const IDLE_LEVELS = new Array(LEVELS_LEN).fill(0.04)

const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
const VIDEO_MIMES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
]

export function useRecorder(
  onStop: (blob: Blob, durationSec: number, source: RecordSource) => void,
  opts: { silenceStop: boolean },
) {
  const [state, setState] = useState<RecorderState>({
    recording: false,
    source: null,
    elapsed: 0,
    error: null,
    levels: IDLE_LEVELS,
    micMixed: false,
    preview: null,
  })

  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const streams = useRef<MediaStream[]>([])
  const audioCtx = useRef<AudioContext | null>(null)
  const raf = useRef<number>(0)
  const timer = useRef<number>(0)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef(0)
  const levelsBuf = useRef<number[]>(IDLE_LEVELS)
  const silenceMs = useRef(0)
  const lastFrame = useRef(0)
  const optsRef = useRef(opts)
  optsRef.current = opts
  const onStopRef = useRef(onStop)
  onStopRef.current = onStop

  const cleanup = useCallback(() => {
    cancelAnimationFrame(raf.current)
    window.clearInterval(timer.current)
    streams.current.forEach((s) => s.getTracks().forEach((tr) => tr.stop()))
    streams.current = []
    void audioCtx.current?.close().catch(() => undefined)
    audioCtx.current = null
    mediaRecorder.current = null
  }, [])

  useEffect(() => cleanup, [cleanup])

  const idle = useCallback(
    () =>
      setState((s) => ({
        ...s,
        recording: false,
        source: null,
        micMixed: false,
        preview: null,
        levels: IDLE_LEVELS,
      })),
    [],
  )

  const stop = useCallback(() => {
    if (mediaRecorder.current && mediaRecorder.current.state !== 'inactive') {
      mediaRecorder.current.stop()
    } else {
      cleanup()
      idle()
    }
  }, [cleanup, idle])
  const stopRef = useRef(stop)
  stopRef.current = stop

  const tickLevels = useCallback((analyser: AnalyserNode) => {
    const data = new Uint8Array(analyser.fftSize)
    lastFrame.current = performance.now()
    silenceMs.current = 0
    const loop = () => {
      const now = performance.now()
      const dt = now - lastFrame.current
      lastFrame.current = now

      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i += 2) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.min(1, Math.sqrt(sum / (data.length / 2)) * 3.2)
      levelsBuf.current = [...levelsBuf.current.slice(1), Math.max(0.04, rms)]
      setState((s) => ({ ...s, levels: levelsBuf.current }))

      if (optsRef.current.silenceStop) {
        if (rms < SILENCE_RMS) {
          silenceMs.current += dt
          if (silenceMs.current > SILENCE_LIMIT_MS) {
            stopRef.current()
            return
          }
        } else {
          silenceMs.current = 0
        }
      }
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
  }, [])

  const start = useCallback(
    async (source: RecordSource) => {
      setState((s) => ({ ...s, error: null }))
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices) {
        setState((s) => ({ ...s, error: t('rec.err.unsupported') }))
        return
      }
      const ctx = new AudioContext()
      audioCtx.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      const micConstraints = { echoCancellation: true, noiseSuppression: true }

      try {
        let recordStream: MediaStream
        let micMixed = false
        let preview: MediaStream | null = null

        if (source === 'mic') {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints })
          streams.current.push(mic)
          ctx.createMediaStreamSource(mic).connect(analyser)
          recordStream = mic
        } else if (source === 'camera') {
          const cam = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: micConstraints,
          })
          streams.current.push(cam)
          ctx.createMediaStreamSource(cam).connect(analyser)
          recordStream = cam
          preview = new MediaStream(cam.getVideoTracks())
        } else {
          if (!('getDisplayMedia' in navigator.mediaDevices)) {
            throw new Error(t('rec.err.noDisplay'))
          }
          const display = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          })
          streams.current.push(display)
          const videoTracks = display.getVideoTracks()
          const audioTracks = display.getAudioTracks()
          // пользователь остановил демонстрацию → завершаем запись
          ;[...videoTracks, ...audioTracks].forEach((tr) =>
            tr.addEventListener('ended', () => stopRef.current()),
          )

          const dest = ctx.createMediaStreamDestination()
          if (audioTracks.length > 0) {
            const tabSrc = ctx.createMediaStreamSource(new MediaStream(audioTracks))
            tabSrc.connect(dest)
            tabSrc.connect(analyser)
          }
          // подмешиваем микрофон, чтобы на встрече слышно было и вас
          try {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints })
            streams.current.push(mic)
            const micSrc = ctx.createMediaStreamSource(mic)
            micSrc.connect(dest)
            micSrc.connect(analyser)
            micMixed = true
          } catch {
            micMixed = false
          }
          if (audioTracks.length === 0 && !micMixed) {
            throw new Error(t('rec.err.noAudio'))
          }
          if (source === 'tab') {
            // нужен только звук — видеодорожку отпускаем сразу
            videoTracks.forEach((tr) => tr.stop())
            recordStream = dest.stream
          } else {
            recordStream = new MediaStream([...videoTracks, ...dest.stream.getAudioTracks()])
            preview = new MediaStream(videoTracks)
          }
        }

        const video = isVideoSource(source)
        const mime = (video ? VIDEO_MIMES : AUDIO_MIMES).find((m) => MediaRecorder.isTypeSupported(m))
        const rec = new MediaRecorder(recordStream, mime ? { mimeType: mime } : undefined)
        mediaRecorder.current = rec
        chunks.current = []
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.current.push(e.data)
        }
        rec.onstop = () => {
          const duration = (Date.now() - startedAt.current) / 1000
          const blob = new Blob(chunks.current, {
            type: rec.mimeType || (video ? 'video/webm' : 'audio/webm'),
          })
          chunks.current = []
          cleanup()
          idle()
          if (blob.size > 0) onStopRef.current(blob, duration, source)
        }

        startedAt.current = Date.now()
        // видео отдаём кусками раз в секунду — меньше мелких Blob в памяти
        rec.start(video ? 1000 : 250)
        levelsBuf.current = IDLE_LEVELS
        setState({
          recording: true,
          source,
          elapsed: 0,
          error: null,
          levels: IDLE_LEVELS,
          micMixed,
          preview,
        })
        timer.current = window.setInterval(
          () => setState((s) => ({ ...s, elapsed: (Date.now() - startedAt.current) / 1000 })),
          250,
        )
        tickLevels(analyser)
      } catch (e) {
        cleanup()
        let msg: string
        if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
          msg =
            source === 'mic'
              ? t('rec.err.micDenied')
              : source === 'camera'
                ? t('rec.err.camDenied')
                : t('rec.err.displayDenied')
        } else if (e instanceof DOMException && e.name === 'NotFoundError') {
          msg = t(source === 'camera' ? 'rec.err.noCamera' : 'rec.err.noMic')
        } else {
          msg = e instanceof Error ? e.message : String(e)
        }
        setState((s) => ({ ...s, error: msg, preview: null }))
      }
    },
    [cleanup, idle, tickLevels],
  )

  return { ...state, start, stop }
}
