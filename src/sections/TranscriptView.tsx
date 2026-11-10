import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, Pencil, Users } from 'lucide-react'
import { formatDurationShort, formatTimecode } from '@/lib/audio'
import { downloadFile, toSrt, toTxt, toTxtStamped, toVtt } from '@/lib/exporters'
import {
  activeSegmentIndex,
  detectMediaKind,
  MediaPlayerBar,
  type PlayerHandle,
} from '@/lib/player'
import type { TranscriptResult } from '@/types'

type ExportFormat = 'plain' | 'stamped'
const EXPORT_FMT_KEY = 'steno.export-fmt.v1'

function loadExportFormat(): ExportFormat {
  try {
    return localStorage.getItem(EXPORT_FMT_KEY) === 'stamped' ? 'stamped' : 'plain'
  } catch {
    return 'plain'
  }
}

interface TranscriptViewProps {
  result: TranscriptResult
  sourceName: string
  /** аудио для прослушивания с динамическими субтитрами */
  audioBlob?: Blob | null
  /** «Спикер 1» → «Иван» */
  speakerNames?: Record<string, string>
  onRenameSpeaker?: (speaker: string, name: string) => void
  /** ручная переназначение спикера у сегмента (индекс в result.segments) */
  onReassignSegment?: (index: number, speaker: string) => void
}

const SPEAKER_COLORS = [
  'hsl(187 85% 62%)',
  'hsl(160 64% 55%)',
  'hsl(43 96% 60%)',
  'hsl(350 80% 68%)',
  'hsl(265 70% 72%)',
]

function speakerColor(speaker: string): string {
  let h = 0
  for (const c of speaker) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return SPEAKER_COLORS[h % SPEAKER_COLORS.length]
}

export function TranscriptView({
  result,
  sourceName,
  audioBlob,
  speakerNames = {},
  onRenameSpeaker,
  onReassignSegment,
}: TranscriptViewProps) {
  const [copied, setCopied] = useState(false)
  const [exportFmt, setExportFmtState] = useState<ExportFormat>(loadExportFormat)
  const setExportFmt = (f: ExportFormat) => {
    setExportFmtState(f)
    try {
      localStorage.setItem(EXPORT_FMT_KEY, f)
    } catch {
      /* ignore */
    }
  }
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const listRef = useRef<HTMLOListElement | null>(null)
  const baseName = sourceName.replace(/\.[^.]+$/, '') || 'transcript'
  const words = result.text.split(/\s+/).filter(Boolean).length

  const speakers = useMemo(() => {
    const seen = new Set<string>()
    for (const s of result.segments) if (s.speaker) seen.add(s.speaker)
    return [...seen]
  }, [result.segments])

  const player = useMemo(
    () => (audioBlob ? { url: URL.createObjectURL(audioBlob), kind: detectMediaKind(audioBlob, sourceName) } : null),
    [audioBlob, sourceName],
  )
  useEffect(() => () => {
    if (player) URL.revokeObjectURL(player.url)
  }, [player])
  const playerRef = useRef<PlayerHandle | null>(null)
  const [playerState, setPlayerState] = useState({ playing: false, time: 0, duration: 0 })

  const activeIdx = useMemo(
    () =>
      playerState.playing || playerState.time > 0
        ? activeSegmentIndex(result.segments, playerState.time)
        : -1,
    [playerState.playing, playerState.time, result.segments],
  )

  // автоскролл к активной строке субтитров
  const scrollToIdx = (idx: number) => {
    const el = listRef.current
    if (!el || idx < 0) return
    const row = el.querySelector<HTMLElement>(`[data-seg="${idx}"]`)
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  const lastScrolled = useRef(-1)
  if (activeIdx >= 0 && activeIdx !== lastScrolled.current) {
    lastScrolled.current = activeIdx
    // отложенно, чтобы DOM успел отрисовать подсветку
    queueMicrotask(() => scrollToIdx(activeIdx))
  }

  const displayName = (sp: string) => speakerNames[sp]?.trim() || sp

  /** Текст для копирования/TXT согласно выбранному формату сохранения. */
  const exportText = () =>
    exportFmt === 'stamped'
      ? toTxtStamped(result.segments, result.text, displayName)
      : toTxt(result.segments, result.text)

  const commitRename = (sp: string) => {
    onRenameSpeaker?.(sp, editName.trim())
    setEditingSpeaker(null)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportText())
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard недоступен */
    }
  }

  const exportBtn =
    'btn-console !min-h-9 px-3 border border-[hsl(var(--border))] text-muted-foreground hover:text-foreground hover:border-[hsl(var(--primary)/0.5)]'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 chrome-label !text-[10px]">
        <span>
          Длительность <b className="text-foreground">{formatDurationShort(result.durationSec)}</b>
        </span>
        <span>
          Обработано за <b className="text-foreground">{formatDurationShort(result.elapsedSec)}</b>
        </span>
        <span>
          Слов <b className="text-foreground">{words}</b>
        </span>
        {result.language && (
          <span>
            Язык <b className="text-foreground">{result.language}</b>
          </span>
        )}
        <span className="text-[hsl(var(--primary))]">
          {result.engineLabel} · {result.modelLabel}
        </span>
      </div>

      {player && result.segments.length > 0 && (
        <MediaPlayerBar
          ref={playerRef}
          url={player.url}
          kind={player.kind}
          fallbackDuration={result.durationSec}
          onState={setPlayerState}
        />
      )}

      {speakers.length > 0 && (
        <div className="panel-inset px-3 py-2.5">
          <div className="chrome-label !text-[10px] flex items-center gap-1.5 mb-2">
            <Users className="size-3.5" aria-hidden="true" /> Спикеры
            <span className="text-muted-foreground/60 normal-case tracking-normal">
              — клик по имени, чтобы переименовать
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {speakers.map((sp) => (
              <div key={sp} className="flex items-center gap-1.5">
                <span className="size-2 rounded-full shrink-0" style={{ background: speakerColor(sp) }} />
                {editingSpeaker === sp ? (
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => commitRename(sp)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(sp)
                      if (e.key === 'Escape') setEditingSpeaker(null)
                    }}
                    className="h-7 w-32 rounded border border-[hsl(var(--primary)/0.5)] bg-background px-2 text-xs focus:outline-none"
                    placeholder={sp}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingSpeaker(sp)
                      setEditName(speakerNames[sp] ?? '')
                    }}
                    className="group flex items-center gap-1 rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs hover:border-[hsl(var(--primary)/0.5)] transition-colors"
                    title="Переименовать спикера"
                  >
                    {displayName(sp)}
                    <Pencil className="size-3 opacity-0 group-hover:opacity-60 transition-opacity" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {result.segments.length > 0 ? (
        <ol ref={listRef} className="flex flex-col gap-1 max-h-[46vh] md:max-h-[52vh] overflow-y-auto pr-1">
          {result.segments.map((s, i) => {
            const showSpeaker = s.speaker && s.speaker !== result.segments[i - 1]?.speaker
            const isActive = i === activeIdx
            return (
              <li key={i} data-seg={i}>
                {showSpeaker && (
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.16em] mt-2 mb-0.5 px-2"
                    style={{ color: speakerColor(s.speaker!) }}
                  >
                    ● {displayName(s.speaker!)}
                  </div>
                )}
                <div
                  className={
                    'grid grid-cols-[86px_1fr] sm:grid-cols-[120px_1fr] gap-3 px-2 py-1.5 rounded transition-colors ' +
                    (isActive
                      ? 'bg-[hsl(var(--primary)/0.12)] ring-1 ring-[hsl(var(--primary)/0.35)]'
                      : 'hover:bg-[hsl(var(--row-hover))]')
                  }
                >
                  <span className="font-mono text-[11px] text-[hsl(var(--primary)/0.8)] pt-0.5 whitespace-nowrap">
                    <button
                      type="button"
                      className="hover:underline disabled:no-underline"
                      disabled={!player}
                      title={player ? 'Перейти к этому моменту' : undefined}
                      onClick={() => playerRef.current?.seek(s.start, true)}
                    >
                      {formatTimecode(s.start)}
                    </button>
                    <span className="hidden sm:inline text-muted-foreground/60">
                      {' '}
                      → {formatTimecode(s.end)}
                    </span>
                    {s.speaker && speakers.length > 1 && onReassignSegment && (
                      <select
                        value={s.speaker}
                        onChange={(e) => onReassignSegment(i, e.target.value)}
                        title="Переназначить спикера для этой реплики"
                        className="mt-1 block w-full max-w-[110px] rounded border border-[hsl(var(--border))] bg-background px-1 py-0.5 text-[10px] text-muted-foreground focus:outline-none focus:border-[hsl(var(--primary)/0.5)]"
                      >
                        {speakers.map((sp) => (
                          <option key={sp} value={sp}>
                            {displayName(sp)}
                          </option>
                        ))}
                      </select>
                    )}
                  </span>
                  <span
                    className={
                      'text-[15px] leading-relaxed text-foreground/90 ' +
                      (player ? 'cursor-pointer hover:text-foreground' : '')
                    }
                    title={player ? 'Клик — перемотать к этой реплике' : undefined}
                    onClick={() => playerRef.current?.seek(s.start, true)}
                  >
                    {s.text}
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="text-[15px] leading-relaxed text-foreground/90 whitespace-pre-wrap max-h-[46vh] overflow-y-auto pr-1">
          {result.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[hsl(var(--border))]">
        {result.segments.length > 0 && (
          <div
            className="flex gap-0.5 p-0.5 panel-inset mr-1"
            role="tablist"
            aria-label="Формат сохранения текста"
          >
            {(
              [
                ['plain', 'Просто текст'],
                ['stamped', 'Со спикерами и таймкодами'],
              ] as Array<[ExportFormat, string]>
            ).map(([f, label]) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={exportFmt === f}
                onClick={() => setExportFmt(f)}
                className={`btn-console !min-h-7 px-2 !text-[10px] border ${
                  exportFmt === f
                    ? 'border-[hsl(var(--primary)/0.5)]'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
                style={exportFmt === f ? { color: 'hsl(var(--primary))' } : undefined}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={copy} className={exportBtn}>
          {copied ? (
            <Check className="size-4 text-[hsl(var(--ok))]" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
        <button
          type="button"
          className={exportBtn}
          onClick={() => downloadFile(`${baseName}.txt`, exportText())}
        >
          <Download className="size-4" aria-hidden="true" /> TXT
        </button>
        <button
          type="button"
          className={exportBtn}
          disabled={result.segments.length === 0}
          onClick={() => downloadFile(`${baseName}.srt`, toSrt(result.segments))}
        >
          <Download className="size-4" aria-hidden="true" /> SRT
        </button>
        <button
          type="button"
          className={exportBtn}
          disabled={result.segments.length === 0}
          onClick={() => downloadFile(`${baseName}.vtt`, toVtt(result.segments), 'text/vtt')}
        >
          <Download className="size-4" aria-hidden="true" /> VTT
        </button>
      </div>
    </div>
  )
}
