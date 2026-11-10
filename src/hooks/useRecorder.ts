import { useCallback, useEffect, useRef, useState } from 'react'

export type RecordSource = 'mic' | 'tab'

export interface RecorderState {
  recording: boolean
  source: RecordSource | null
  elapsed: number
  error: string | null
  /** массив уровней 0..1 для живой волны */
  levels: number[]
  /** при записи вкладки: микрофон подмешан в запись */
  micMixed: boolean
}

const LEVELS_LEN = 96
const SILENCE_RMS = 0.012
const SILENCE_LIMIT_MS = 10000

export function useRecorder(
  onStop: (blob: Blob, durationSec: number) => void,
  opts: { silenceStop: boolean },
) {
  const [state, setState] = useState<RecorderState>({
    recording: false,
    source: null,
    elapsed: 0,
    error: null,
    levels: new Array(LEVELS_LEN).fill(0.04),
    micMixed: false,
  })

  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const streams = useRef<MediaStream[]>([])
  const audioCtx = useRef<AudioContext | null>(null)
  const raf = useRef<number>(0)
  const timer = useRef<number>(0)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef(0)
  const levelsBuf = useRef<number[]>(new Array(LEVELS_LEN).fill(0.04))
  const silenceMs = useRef(0)
  const lastFrame = useRef(0)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const cleanup = useCallback(() => {
    cancelAnimationFrame(raf.current)
    window.clearInterval(timer.current)
    streams.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    streams.current = []
    void audioCtx.current?.close().catch(() => undefined)
    audioCtx.current = null
    mediaRecorder.current = null
  }, [])

  useEffect(() => cleanup, [cleanup])

  const stop = useCallback(() => {
    if (mediaRecorder.current && mediaRecorder.current.state !== 'inactive') {
      mediaRecorder.current.stop()
    } else {
      cleanup()
      setState((s) => ({
        ...s,
        recording: false,
        source: null,
        micMixed: false,
        levels: new Array(LEVELS_LEN).fill(0.04),
      }))
    }
  }, [cleanup])
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
      const ctx = new AudioContext()
      audioCtx.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024

      try {
        let recordStream: MediaStream
        let micMixed = false

        if (source === 'mic') {
          const mic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          })
          streams.current.push(mic)
          ctx.createMediaStreamSource(mic).connect(analyser)
          recordStream = mic
        } else {
          if (!('getDisplayMedia' in navigator.mediaDevices)) {
            throw new Error('Захват звука вкладки не поддерживается здесь — нужен Chrome или Edge')
          }
          const display = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          })
          streams.current.push(display)
          display.getVideoTracks().forEach((t) => t.stop())
          const audioTracks = display.getAudioTracks()
          if (audioTracks.length === 0) {
            throw new Error(
              'Звук не передан: в диалоге выбора вкладки включите «Также поделиться звуком»',
            )
          }
          // пользователь остановил демонстрацию → завершаем запись
          audioTracks[0].addEventListener('ended', () => stopRef.current())

          const dest = ctx.createMediaStreamDestination()
          const tabSrc = ctx.createMediaStreamSource(display)
          tabSrc.connect(dest)
          tabSrc.connect(analyser)

          // подмешиваем микрофон, чтобы на встрече слышно было и вас
          try {
            const mic = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true },
            })
            streams.current.push(mic)
            const micSrc = ctx.createMediaStreamSource(mic)
            micSrc.connect(dest)
            micSrc.connect(analyser)
            micMixed = true
          } catch {
            micMixed = false
          }
          recordStream = dest.stream
        }

        const mime = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
          'audio/ogg;codecs=opus',
        ].find((m) => MediaRecorder.isTypeSupported(m))
        const rec = new MediaRecorder(recordStream, mime ? { mimeType: mime } : undefined)
        mediaRecorder.current = rec
        chunks.current = []
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.current.push(e.data)
        }
        rec.onstop = () => {
          const duration = (Date.now() - startedAt.current) / 1000
          const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' })
          cleanup()
          setState((s) => ({
            ...s,
            recording: false,
            source: null,
            micMixed: false,
            levels: new Array(LEVELS_LEN).fill(0.04),
          }))
          if (blob.size > 0) onStop(blob, duration)
        }

        startedAt.current = Date.now()
        rec.start(250)
        setState({
          recording: true,
          source,
          elapsed: 0,
          error: null,
          levels: new Array(LEVELS_LEN).fill(0.04),
          micMixed,
        })
        timer.current = window.setInterval(
          () => setState((s) => ({ ...s, elapsed: (Date.now() - startedAt.current) / 1000 })),
          250,
        )
        tickLevels(analyser)
      } catch (e) {
        cleanup()
        let msg: string
        if (e instanceof DOMException && e.name === 'NotAllowedError') {
          msg =
            source === 'tab'
              ? 'Выбор вкладки отменён или не разрешён.'
              : 'Нет доступа к микрофону. Разрешите доступ в браузере.'
        } else {
          msg = e instanceof Error ? e.message : String(e)
        }
        setState((s) => ({ ...s, error: msg }))
      }
    },
    [cleanup, onStop, tickLevels],
  )

  return { ...state, start, stop }
}
