import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Check, Copy, Download, Trash2, X } from 'lucide-react'
import { formatTimecode } from '@/lib/audio'
import { detectMediaKind, MediaPlayerBar, type PlayerHandle, type Shot } from '@/lib/player'
import type { Segment } from '@/types'
import { speakerLabel, useT } from '@/i18n'

interface Props {
  blob: Blob
  sourceName: string
  segments: Segment[]
  speakerNames: Record<string, string>
  durationSec: number
  playerRef: RefObject<PlayerHandle | null>
  onState: (s: { playing: boolean; time: number; duration: number }) => void
  /** максимальная высота видео (CSS) */
  videoMaxHeight: string
  /** кнопки справа в панели плеера (например «увеличить») */
  extra?: ReactNode
}

interface Entry {
  id: number
  url: string
  blob: Blob
  time: number
}

let nextId = 1

/** Плеер + лента скриншотов: просмотр, копирование в буфер, скачивание. */
export function MediaPane({
  blob,
  sourceName,
  segments,
  speakerNames,
  durationSec,
  playerRef,
  onState,
  videoMaxHeight,
  extra,
}: Props) {
  const t = useT()
  const media = useMemo(() => ({ url: URL.createObjectURL(blob), kind: detectMediaKind(blob, sourceName) }), [blob, sourceName])
  useEffect(() => () => URL.revokeObjectURL(media.url), [media])

  const [shots, setShots] = useState<Entry[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const shotsRef = useRef(shots)
  shotsRef.current = shots
  // освободить адреса при смене файла и закрытии
  useEffect(() => () => shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url)), [blob])
  useEffect(() => setShots([]), [blob])

  const base = sourceName.replace(/\.[^.]+$/, '') || 'steno'
  const nameOf = useCallback((sp: string) => speakerNames[sp]?.trim() || speakerLabel(sp), [speakerNames])

  const onShot = (s: Shot) => {
    const e: Entry = { id: nextId++, url: URL.createObjectURL(s.blob), blob: s.blob, time: s.time }
    setShots((prev) => [e, ...prev].slice(0, 12))
    setOpen(e.id)
    setCopied(null)
  }

  const fileName = (e: Entry) => `${base}_${formatTimecode(e.time).replace(/:/g, '-')}.png`

  const download = (e: Entry) => {
    const a = document.createElement('a')
    a.href = e.url
    a.download = fileName(e)
    a.click()
  }

  const copy = async (e: Entry) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': e.blob })])
      setCopied('ok')
    } catch {
      setCopied('fail')
    }
    window.setTimeout(() => setCopied(null), 2200)
  }

  const remove = (e: Entry) => {
    URL.revokeObjectURL(e.url)
    setShots((prev) => prev.filter((x) => x.id !== e.id))
    setOpen(null)
  }

  const current = shots.find((s) => s.id === open) ?? null

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <MediaPlayerBar
        ref={playerRef}
        url={media.url}
        kind={media.kind}
        fallbackDuration={durationSec}
        onState={onState}
        segments={segments}
        nameOf={nameOf}
        onShot={onShot}
        videoMaxHeight={videoMaxHeight}
        extra={extra}
      />

      {shots.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1" aria-label={t('shot.title')}>
          {shots.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setOpen(s.id)
                setCopied(null)
              }}
              title={formatTimecode(s.time)}
              className="relative shrink-0 h-12 rounded-md overflow-hidden ring-1 ring-[hsl(var(--border))] hover:ring-[hsl(var(--primary))] cursor-pointer"
            >
              <img src={s.url} alt={`${t('shot.title')} ${formatTimecode(s.time)}`} className="h-full w-auto" />
              <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[9px] font-mono text-white text-center">
                {formatTimecode(s.time)}
              </span>
            </button>
          ))}
        </div>
      )}

      {current && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('shot.title')}
          onClick={(e) => e.target === e.currentTarget && setOpen(null)}
        >
          <div className="panel max-w-4xl w-full max-h-[92dvh] flex flex-col gap-3 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="chrome-label !text-[10px]">
                {t('shot.title')} · {formatTimecode(current.time)}
              </span>
              <button
                type="button"
                onClick={() => setOpen(null)}
                aria-label={t('common.close')}
                className="size-8 inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <img src={current.url} alt="" className="min-h-0 max-h-[68dvh] w-auto mx-auto rounded-lg object-contain" />
            <div className="flex flex-wrap items-center gap-2 justify-center">
              <button type="button" onClick={() => void copy(current)} className="btn-console px-3 cursor-pointer">
                {copied === 'ok' ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
                {copied === 'ok' ? t('shot.copied') : t('shot.copy')}
              </button>
              <button type="button" onClick={() => download(current)} className="btn-console px-3 cursor-pointer">
                <Download className="size-4" aria-hidden="true" />
                {t('shot.download')}
              </button>
              <button type="button" onClick={() => remove(current)} className="btn-console px-3 cursor-pointer">
                <Trash2 className="size-4" aria-hidden="true" />
                {t('shot.delete')}
              </button>
            </div>
            {copied === 'fail' && (
              <p role="alert" className="text-xs text-center" style={{ color: 'hsl(var(--err))' }}>
                {t('shot.copyFailed')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
