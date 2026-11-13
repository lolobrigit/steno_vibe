// Проигрывание медиа (аудио/видео) с динамическими субтитрами по распознанному
// тексту. Полоса прогресса кликабельна (перемотка), клик по таймкоду или тексту
// реплики — переход к фрагменту; активная строка подсвечивается и центрируется.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { Camera, Captions, Pause, Play } from 'lucide-react'
import { speakerColor } from '@/lib/transcript'
import { formatTimecode } from '@/lib/audio'
import type { Segment } from '@/types'
import { useT } from '@/i18n'

export type MediaKind = 'audio' | 'video'

/** Доступные скорости воспроизведения; выбор запоминается между сессиями. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const RATE_KEY = 'steno.rate.v1'

function loadRate(): number {
  try {
    const n = Number(localStorage.getItem(RATE_KEY))
    return PLAYBACK_RATES.includes(n) ? n : 1
  } catch {
    return 1
  }
}

/** Видео ли это по MIME-типу или расширению имени файла. */
export function detectMediaKind(blob: Blob, name: string): MediaKind {
  if (blob.type.startsWith('video/')) return 'video'
  return /\.(mp4|mkv|webm|mov|avi|m4v|ts|mts)$/i.test(name) ? 'video' : 'audio'
}

const SUBS_KEY = 'steno.subs.v1'
function loadSubs(): boolean {
  try {
    return localStorage.getItem(SUBS_KEY) !== '0'
  } catch {
    return true
  }
}

/** Слова реплики и номер последнего «уже произнесённого» (оценка по доле символов). */
export function activeWords(seg: Segment, time: number): { words: string[]; upto: number } {
  // точные пословные метки (если Whisper их отдал) — иначе оценка по числу символов
  if (seg.words?.length) {
    let upto = -1
    seg.words.forEach((w, i) => {
      if (w.start <= time) upto = i
    })
    return { words: seg.words.map((w) => w.text.trim()), upto }
  }
  const words = seg.text.split(/\s+/).filter(Boolean)
  const total = words.reduce((a, w) => a + w.length + 1, 0) || 1
  const frac = seg.end > seg.start ? Math.min(1, Math.max(0, (time - seg.start) / (seg.end - seg.start))) : 1
  let acc = 0
  let upto = -1
  words.forEach((w, i) => {
    acc += w.length + 1
    if (acc / total <= frac + 1e-6) upto = i
  })
  return { words, upto }
}

/** Реплика, которую надо показать как субтитр в момент `time` (или null в паузе между репликами). */
export function subtitleAt(segments: Segment[], time: number): Segment | null {
  const i = activeSegmentIndex(segments, time)
  if (i < 0) return null
  const seg = segments[i]
  return time <= seg.end + 0.4 ? seg : null
}

/** Нарисовать субтитр поверх кадра (для скриншота): те же подсветка слов и плашка. */
export function drawSubtitle(ctx: CanvasRenderingContext2D, w: number, h: number, seg: Segment, time: number, who?: string) {
  const size = Math.max(16, Math.round(h * 0.045))
  ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`
  ctx.textBaseline = 'middle'
  const { words, upto } = activeWords(seg, time)
  const maxW = w * 0.86
  const space = ctx.measureText(' ').width
  const lines: { i: number; w: number }[][] = [[]]
  let lw = 0
  words.forEach((word, i) => {
    const ww = ctx.measureText(word).width
    if (lw + ww > maxW && lines[lines.length - 1].length) {
      lines.push([])
      lw = 0
    }
    lines[lines.length - 1].push({ i, w: ww })
    lw += ww + space
  })
  const lineH = size * 1.35
  const boxH = lines.length * lineH + size * (who ? 1.6 : 0.8)
  const boxW = Math.min(w * 0.92, Math.max(...lines.map((l) => l.reduce((a, x) => a + x.w + space, 0))) + size * 1.6)
  const x0 = (w - boxW) / 2
  const y0 = h - boxH - h * 0.05
  ctx.fillStyle = 'rgba(8,10,20,0.78)'
  ctx.beginPath()
  ctx.roundRect(x0, y0, boxW, boxH, size * 0.5)
  ctx.fill()
  const hot = seg.speaker ? speakerColor(seg.speaker) : '#fde68a'
  let y = y0 + size * 0.4
  if (who) {
    ctx.font = `600 ${Math.round(size * 0.6)}px system-ui, sans-serif`
    ctx.fillStyle = hot
    ctx.textAlign = 'center'
    ctx.fillText(who.toUpperCase(), w / 2, y + size * 0.4)
    y += size * 0.8
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`
  }
  ctx.textAlign = 'left'
  for (const line of lines) {
    const total = line.reduce((a, x) => a + x.w + space, 0) - space
    let x = (w - total) / 2
    for (const it of line) {
      ctx.fillStyle = it.i <= upto ? hot : '#ffffff'
      ctx.fillText(words[it.i], x, y + lineH / 2)
      x += it.w + space
    }
    y += lineH
  }
}

export interface PlayerHandle {
  toggle: () => void
  /** переход к секунде; autoplay=true — ещё и запускает воспроизведение */
  seek: (sec: number, autoplay?: boolean) => void
}

export interface Shot {
  blob: Blob
  /** секунда видео, с которой снят кадр */
  time: number
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
  const t = useT()
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
      aria-label={t('pl.seek')}
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
      title={t('pl.seekHint')}
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
    /** реплики для субтитров поверх видео */
    segments?: Segment[]
    /** отображаемое имя спикера в субтитре */
    nameOf?: (speaker: string) => string
    /** снят скриншот (кнопка в панели) */
    onShot?: (shot: Shot) => void
    /** максимальная высота видео (CSS) */
    videoMaxHeight?: string
    /** дополнительные кнопки справа в панели */
    extra?: ReactNode
  }
>(function MediaPlayerBar(
  { url, kind, fallbackDuration, onState, segments, nameOf, onShot, videoMaxHeight = '34vh', extra },
  ref,
) {
  const t = useT()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(fallbackDuration)
  const [rate, setRateState] = useState(loadRate)
  const [subsOn, setSubsOn] = useState(loadSubs)
  const rateRef = useRef(rate)
  rateRef.current = rate
  const el = (kind === 'video' ? videoRef.current : audioRef.current) as HTMLMediaElement | null
  const durationRef = useRef(duration)
  durationRef.current = duration

  useEffect(() => {
    if (!el) return
    // браузер сбрасывает скорость при загрузке нового источника — задаём заново
    const applyRate = () => {
      el.playbackRate = rateRef.current
      el.preservesPitch = true
    }
    applyRate()
    const onTime = () => setTime(el.currentTime)
    const onMeta = () => {
      applyRate()
      if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration)
    }
    const onPlay = () => {
      applyRate()
      setPlaying(true)
    }
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

  const setRate = (r: number) => {
    setRateState(r)
    if (el) el.playbackRate = r
    try {
      localStorage.setItem(RATE_KEY, String(r))
    } catch {
      /* ignore */
    }
  }

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

  const toggleSubs = () => {
    setSubsOn((v) => {
      try {
        localStorage.setItem(SUBS_KEY, v ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !v
    })
  }

  const sub = kind === 'video' && subsOn && segments?.length ? subtitleAt(segments, time) : null

  const shoot = () => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.drawImage(v, 0, 0, c.width, c.height)
    if (sub) drawSubtitle(ctx, c.width, c.height, sub, v.currentTime, sub.speaker ? nameOf?.(sub.speaker) : undefined)
    const at = v.currentTime
    c.toBlob((blob) => blob && onShot?.({ blob, time: at }), 'image/png')
  }

  useEffect(() => {
    onState({ playing, time, duration })
  }, [playing, time, duration, onState])

  return (
    <div className="flex flex-col gap-2">
      {kind === 'video' && (
        <div className="relative">
          <video
            ref={videoRef}
            src={url}
            preload="metadata"
            className="w-full rounded-lg bg-black object-contain cursor-pointer"
            style={{ maxHeight: videoMaxHeight }}
            controls={false}
            playsInline
            onClick={() => {
              if (!videoRef.current) return
              if (videoRef.current.paused) void videoRef.current.play().catch(() => {})
              else videoRef.current.pause()
            }}
          />
          {sub && <SubtitleOverlay seg={sub} time={time} who={sub.speaker ? nameOf?.(sub.speaker) : undefined} />}
        </div>
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
          aria-label={playing ? t('pl.pause') : t('pl.play')}
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
        <label className="flex items-center gap-1 shrink-0">
          <span className="sr-only">{t('pl.speed')}</span>
          <select
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            title={t('pl.speed')}
            className="h-8 rounded-md border border-[hsl(var(--border))] bg-transparent px-1.5 font-mono text-[11px] tabular-nums text-foreground/90 cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))]"
          >
            {PLAYBACK_RATES.map((r) => (
              <option key={r} value={r} className="bg-[hsl(var(--popover))]">
                {r}×
              </option>
            ))}
          </select>
        </label>
        {kind === 'video' && (
          <>
            {segments && segments.length > 0 && (
              <button
                type="button"
                onClick={toggleSubs}
                aria-pressed={subsOn}
                title={t('sub.toggle')}
                aria-label={t('sub.toggle')}
                className={`size-8 shrink-0 inline-flex items-center justify-center rounded-md cursor-pointer transition-colors ${
                  subsOn ? 'text-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.14)]' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Captions className="size-4" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={shoot}
              title={t('shot.btn')}
              aria-label={t('shot.btn')}
              className="size-8 shrink-0 inline-flex items-center justify-center rounded-md cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <Camera className="size-4" aria-hidden="true" />
            </button>
          </>
        )}
        {extra}
      </div>
    </div>
  )
})

/** Субтитр поверх видео: плашка как активная реплика в расшифровке, слова подсвечиваются по мере речи. */
function SubtitleOverlay({ seg, time, who }: { seg: Segment; time: number; who?: string }) {
  const { words, upto } = activeWords(seg, time)
  // подсветка произнесённых слов — цветом спикера, как в расшифровке
  const hot = seg.speaker ? speakerColor(seg.speaker) : 'hsl(43 96% 75%)'
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
      <div className="max-w-[92%] rounded-lg px-3 py-1.5 text-center bg-[rgba(8,10,20,0.78)] ring-1 ring-[hsl(var(--primary)/0.4)] backdrop-blur-sm">
        {who && (
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] leading-tight" style={{ color: hot }}>
            {who}
          </div>
        )}
        <div className="font-semibold leading-snug text-[clamp(12px,1.5vw,19px)] text-white [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
          {words.map((w, i) => (
            <span key={i} style={i <= upto ? { color: hot } : undefined}>
              {w}{' '}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

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
