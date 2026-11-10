// Проигрывание медиа (аудио/видео) с динамическими субтитрами по распознанному
// тексту. Полоса прогресса кликабельна (перемотка), клик по таймкоду или тексту
// реплики — переход к фрагменту; активная строка подсвечивается и центрируется.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { formatTimecode } from '@/lib/audio'
import type { Segment } from '@/types'

export type MediaKind = 'audio' | 'video'

/** Видео ли это по MIME-типу или расширению имени файла. */
export function detectMediaKind(blob: Blob, name: string): MediaKind {
  if (blob.type.startsWith('video/')) return 'video'
  return /\.(mp4|mkv|webm|mov|avi|m4v|ts|mts)$/i.test(name) ? 'video' : 'audio'
}

export interface PlayerHandle {
  toggle: () => void
  /** переход к секунде; autoplay=true — ещё и запускает воспроизведение */
  seek: (sec: number, autoplay?: boolean) => void
}

interface PlayerState {
  playing: boolean
  time: number
  duration: number
}

function SeekBar({
  time,
  duration,
  onSeek,
}: {
  time: number
  duration: number
  onSeek: (sec: number) => void
}) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const seekFromEvent = (clientX: number) => {
    const bar = barRef.current
    if (!bar || duration <= 0) return
    const rect = bar.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onSeek(frac * duration)
  }

  return (
    <div
      ref={barRef}
      role="slider"
      aria-label="Перемотка"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      tabIndex={0}
      onClick={(e) => seekFromEvent(e.clientX)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onSeek(Math.min(duration, time + 5))
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, time - 5))
      }}
      className="group flex-1 h-4 flex items-center cursor-pointer"
      title="Клик — перемотка, ←/→ — ±5 сек"
    >
      <div
        className="relative w-full h-1 group-hover:h-1.5 rounded-sm transition-all"
        style={{ background: 'hsl(var(--track))' }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-sm"
          style={{
            width: `${duration > 0 ? Math.min(100, (time / duration) * 100) : 0}%`,
            background: 'hsl(var(--primary))',
          }}
        />
      </div>
    </div>
  )
}

/**
 * Панель плеера: кнопка play/pause, время, кликабельная полоса перемотки.
 * Для видео над панелью рендерится <video>. Управление снаружи — через ref
 * (PlayerHandle), состояние — через onState.
 */
export const MediaPlayerBar = forwardRef<
  PlayerHandle,
  {
    url: string
    kind: MediaKind
    /** длительность из метаданных транскрипта, пока тег не прочитал свою */
    fallbackDuration: number
    onState: (s: PlayerState) => void
  }
>(function MediaPlayerBar({ url, kind, fallbackDuration, onState }, ref) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(fallbackDuration)
  const el = (kind === 'video' ? videoRef.current : audioRef.current) as HTMLMediaElement | null
  const durationRef = useRef(duration)
  durationRef.current = duration

  useEffect(() => {
    if (!el) return
    const onTime = () => setTime(el.currentTime)
    const onMeta = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('durationchange', onMeta)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onPause)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('durationchange', onMeta)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onPause)
    }
  }, [el])

  useEffect(() => setDuration((d) => (d > 0 ? d : fallbackDuration)), [fallbackDuration])

  useImperativeHandle(
    ref,
    () => ({
      toggle: () => {
        if (!el) return
        if (el.paused) void el.play().catch(() => {})
        else el.pause()
      },
      seek: (sec: number, autoplay = false) => {
        if (!el) return
        const d = durationRef.current > 0 ? durationRef.current : Number.MAX_SAFE_INTEGER
        el.currentTime = Math.max(0, Math.min(sec, d))
        setTime(el.currentTime)
        if (autoplay && el.paused) void el.play().catch(() => {})
      },
    }),
    [el],
  )

  useEffect(() => {
    onState({ playing, time, duration })
  }, [playing, time, duration, onState])

  return (
    <div className="flex flex-col gap-2">
      {kind === 'video' && (
        <video
          ref={videoRef}
          src={url}
          preload="metadata"
          className="w-full max-h-[42vh] rounded-lg bg-black cursor-pointer"
          controls={false}
          playsInline
          onClick={() => {
            if (!videoRef.current) return
            if (videoRef.current.paused) void videoRef.current.play().catch(() => {})
            else videoRef.current.pause()
          }}
        />
      )}
      {kind === 'audio' && <audio ref={audioRef} src={url} preload="metadata" />}
      <div className="panel-inset px-3 py-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            if (!el) return
            if (el.paused) void el.play().catch(() => {})
            else el.pause()
          }}
          aria-label={playing ? 'Пауза' : 'Слушать'}
          className="btn-console !min-h-9 !min-w-9 inline-flex items-center justify-center border border-[hsl(var(--primary)/0.5)]"
          style={{ color: 'hsl(var(--primary))' }}
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">
          {formatTimecode(time)} / {formatTimecode(duration)}
        </span>
        <SeekBar
          time={time}
          duration={duration}
          onSeek={(sec) => {
            if (!el) return
            el.currentTime = sec
            setTime(sec)
          }}
        />
      </div>
    </div>
  )
})

/** Индекс активного сегмента по текущему времени (бинпоиск по start). */
export function activeSegmentIndex(segments: Segment[], t: number): number {
  let lo = 0
  let hi = segments.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].start <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}
