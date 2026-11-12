import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Download,
  GitMerge,
  Layers,
  Link2,
  Pencil,
  Scissors,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { formatDurationShort, formatTimecode } from '@/lib/audio'
import { downloadFile, toSrt, toTxt, toTxtStamped, toVtt } from '@/lib/exporters'
import {
  activeSegmentIndex,
  detectMediaKind,
  MediaPlayerBar,
  type PlayerHandle,
} from '@/lib/player'
import { NEW_SPEAKER, speakersOf } from '@/lib/transcript'
import type { TranscriptResult, TranscriptVersion } from '@/types'
import { languageName, speakerLabel, useT } from '@/i18n'

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
  /** медиа для проигрывания с подсветкой реплик */
  audioBlob?: Blob | null
  /** «S1» → «Иван» */
  speakerNames?: Record<string, string>
  versions: TranscriptVersion[]
  activeVersionId: string | null
  onSelectVersion: (id: string) => void
  onDuplicateVersion: () => void
  onDeleteVersion: (id: string) => void
  onRenameSpeaker?: (speaker: string, name: string) => void
  onReassignSegment?: (index: number, speaker: string) => void
  /** объединить спикера `from` с `into` */
  onMergeSpeakers?: (from: string, into: string) => void
  /** разделить реплику `index` по смещению в тексте; вторая часть — у `speaker` (NEW_SPEAKER — новый) */
  onSplitSegment?: (index: number, offset: number, speaker: string) => void
  onJoinPrevious?: (index: number) => void
  /** занять всю высоту родителя: список реплик прокручивается внутри блока */
  fill?: boolean
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
  versions,
  activeVersionId,
  onSelectVersion,
  onDuplicateVersion,
  onDeleteVersion,
  onRenameSpeaker,
  onReassignSegment,
  onMergeSpeakers,
  onSplitSegment,
  onJoinPrevious,
  fill = false,
}: TranscriptViewProps) {
  const t = useT()
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
  const [merge, setMerge] = useState<{ from: string; into: string } | null>(null)
  const [splitIdx, setSplitIdx] = useState<number | null>(null)
  const [splitSpeaker, setSplitSpeaker] = useState(NEW_SPEAKER)
  const [splitError, setSplitError] = useState(false)
  const splitRef = useRef<HTMLTextAreaElement | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)
  /** когда пользователь последний раз сам крутил список: автоскролл его не перебивает */
  const userScrollAt = useRef(0)
  const baseName = sourceName.replace(/\.[^.]+$/, '') || 'transcript'
  const words = result.text.split(/\s+/).filter(Boolean).length
  const hasSegments = result.segments.length > 0

  const speakers = useMemo(() => speakersOf(result.segments), [result.segments])

  const player = useMemo(
    () =>
      audioBlob
        ? { url: URL.createObjectURL(audioBlob), kind: detectMediaKind(audioBlob, sourceName) }
        : null,
    [audioBlob, sourceName],
  )
  useEffect(
    () => () => {
      if (player) URL.revokeObjectURL(player.url)
    },
    [player],
  )
  const playerRef = useRef<PlayerHandle | null>(null)
  const [playerState, setPlayerState] = useState({ playing: false, time: 0, duration: 0 })

  const activeIdx = useMemo(
    () =>
      playerState.playing || playerState.time > 0
        ? activeSegmentIndex(result.segments, playerState.time)
        : -1,
    [playerState.playing, playerState.time, result.segments],
  )

  // Активная реплика центрируется ТОЛЬКО внутри списка: scrollIntoView прокручивал
  // бы ещё и страницу, и видео уезжало за экран. Считаем смещение сами.
  useEffect(() => {
    const list = listRef.current
    if (!list || activeIdx < 0) return
    if (Date.now() - userScrollAt.current < 3000) return
    const row = list.querySelector<HTMLElement>(`[data-seg="${activeIdx}"]`)
    if (!row) return
    const top = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2
    list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [activeIdx])

  const displayName = (sp: string) => speakerNames[sp]?.trim() || speakerLabel(sp)

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

  const openSplit = (i: number) => {
    if (splitIdx === i) {
      setSplitIdx(null)
      return
    }
    const cur = result.segments[i]?.speaker
    const other = speakers.find((s) => s !== cur)
    setSplitSpeaker(other ?? NEW_SPEAKER)
    setSplitError(false)
    setSplitIdx(i)
  }

  const applySplit = () => {
    if (splitIdx === null) return
    const area = splitRef.current
    const text = result.segments[splitIdx]?.text ?? ''
    const at = area?.selectionStart ?? 0
    if (at <= 0 || at >= text.length || !text.slice(0, at).trim() || !text.slice(at).trim()) {
      setSplitError(true)
      return
    }
    onSplitSegment?.(splitIdx, at, splitSpeaker)
    setSplitIdx(null)
  }

  const selectedVersion = versions.find((v) => v.id === activeVersionId)
  const kindLabel = (k: TranscriptVersion['kind']) => t(`ver.kind.${k}`)

  const exportBtn =
    'btn-console !min-h-9 px-3 border border-[hsl(var(--border))] text-muted-foreground hover:text-foreground hover:border-[hsl(var(--primary)/0.5)]'
  const iconBtn =
    'size-7 shrink-0 inline-flex items-center justify-center rounded text-muted-foreground/70 hover:text-foreground hover:bg-[hsl(var(--row-hover))] cursor-pointer transition-colors'
  const selectCls =
    'rounded border border-[hsl(var(--border))] bg-background px-1.5 py-1 text-xs text-foreground focus:outline-none focus:border-[hsl(var(--primary)/0.5)]'

  return (
    <div className={`flex flex-col gap-3 ${fill ? 'h-full min-h-0' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 chrome-label !text-[10px] shrink-0">
        <span>
          {t('tv.duration')} <b className="text-foreground">{formatDurationShort(result.durationSec)}</b>
        </span>
        <span>
          {t('tv.elapsed')} <b className="text-foreground">{formatDurationShort(result.elapsedSec)}</b>
        </span>
        <span>
          {t('tv.words')} <b className="text-foreground">{words}</b>
        </span>
        {result.language && (
          <span>
            {t('tv.language')}{' '}
            <b className="text-foreground">
              {/^[a-z]{2,3}$/.test(result.language) ? languageName(result.language) : result.language}
            </b>
          </span>
        )}
        <span className="text-[hsl(var(--primary))]">
          {result.engineLabel} · {result.modelLabel}
        </span>
      </div>

      {/* версии расшифровки */}
      {versions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 shrink-0" title={t('ver.hint')}>
          <span className="chrome-label !text-[10px] flex items-center gap-1.5">
            <Layers className="size-3.5" aria-hidden="true" /> {t('ver.label')}
          </span>
          <select
            value={activeVersionId ?? ''}
            onChange={(e) => onSelectVersion(e.target.value)}
            aria-label={t('ver.label')}
            className={`${selectCls} max-w-full min-w-0 flex-1 sm:flex-none sm:max-w-[22rem]`}
          >
            {versions.map((v, i) => (
              <option key={v.id} value={v.id}>
                {`${i + 1}. ${kindLabel(v.kind)} · ${v.label} · ${new Date(v.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${v.segments.length === 0 ? ` · ${t('ver.plain')}` : ''}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onDuplicateVersion}
            disabled={!selectedVersion}
            className={iconBtn}
            title={t('ver.duplicate')}
            aria-label={t('ver.duplicate')}
          >
            <Copy className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => activeVersionId && onDeleteVersion(activeVersionId)}
            disabled={versions.length <= 1}
            className={`${iconBtn} disabled:opacity-30 disabled:cursor-not-allowed`}
            title={t('ver.delete')}
            aria-label={t('ver.delete')}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {player && hasSegments && (
        <div className="shrink-0">
          <MediaPlayerBar
            ref={playerRef}
            url={player.url}
            kind={player.kind}
            fallbackDuration={result.durationSec}
            onState={setPlayerState}
          />
        </div>
      )}

      {speakers.length > 0 && (
        <div className="panel-inset px-3 py-2.5 shrink-0">
          <div className="chrome-label !text-[10px] flex items-center gap-1.5 mb-2 flex-wrap">
            <Users className="size-3.5" aria-hidden="true" /> {t('tv.speakers')}
            <span className="text-muted-foreground/60 normal-case tracking-normal">
              — {t('tv.renameHint')}
            </span>
            {speakers.length > 1 && onMergeSpeakers && !merge && (
              <button
                type="button"
                onClick={() => setMerge({ from: speakers[speakers.length - 1], into: speakers[0] })}
                className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <GitMerge className="size-3.5" aria-hidden="true" /> {t('spk.merge')}
              </button>
            )}
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
                    placeholder={speakerLabel(sp)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingSpeaker(sp)
                      setEditName(speakerNames[sp] ?? '')
                    }}
                    className="group flex items-center gap-1 rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs hover:border-[hsl(var(--primary)/0.5)] transition-colors"
                    title={t('tv.rename')}
                  >
                    {displayName(sp)}
                    <Pencil className="size-3 opacity-0 group-hover:opacity-60 transition-opacity" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {merge && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <select
                value={merge.from}
                onChange={(e) => setMerge({ ...merge, from: e.target.value })}
                className={selectCls}
                aria-label={t('spk.merge')}
              >
                {speakers.map((sp) => (
                  <option key={sp} value={sp}>
                    {displayName(sp)}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">{t('spk.mergeInto')}</span>
              <select
                value={merge.into}
                onChange={(e) => setMerge({ ...merge, into: e.target.value })}
                className={selectCls}
                aria-label={t('spk.mergeInto')}
              >
                {speakers.map((sp) => (
                  <option key={sp} value={sp}>
                    {displayName(sp)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={merge.from === merge.into}
                onClick={() => {
                  onMergeSpeakers?.(merge.from, merge.into)
                  setMerge(null)
                }}
                className="btn-console !min-h-8 px-3 border border-[hsl(var(--primary)/0.5)] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: 'hsl(var(--primary))' }}
              >
                <Check className="size-3.5" aria-hidden="true" /> {t('spk.mergeApply')}
              </button>
              <button
                type="button"
                onClick={() => setMerge(null)}
                className={iconBtn}
                aria-label={t('common.cancel')}
                title={t('common.cancel')}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}

      {hasSegments ? (
        <ol
          ref={listRef}
          onWheel={() => (userScrollAt.current = Date.now())}
          onTouchMove={() => (userScrollAt.current = Date.now())}
          className={`relative flex flex-col gap-1 overflow-y-auto pr-1 ${
            fill ? 'flex-1 min-h-0' : 'max-h-[46vh] md:max-h-[52vh]'
          }`}
        >
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
                    'group/row grid grid-cols-[86px_1fr_auto] sm:grid-cols-[120px_1fr_auto] gap-3 px-2 py-1.5 rounded transition-colors ' +
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
                      title={player ? t('tv.jump') : undefined}
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
                        title={t('tv.reassign')}
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
                    title={player ? t('tv.jump') : undefined}
                    onClick={() => playerRef.current?.seek(s.start, true)}
                  >
                    {s.text}
                  </span>
                  <span className="flex items-start gap-0.5 opacity-60 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
                    {onSplitSegment && (
                      <button
                        type="button"
                        onClick={() => openSplit(i)}
                        className={`${iconBtn} ${splitIdx === i ? '!text-[hsl(var(--primary))]' : ''}`}
                        title={t('split.btn')}
                        aria-label={t('split.btn')}
                        aria-pressed={splitIdx === i}
                      >
                        <Scissors className="size-3.5" aria-hidden="true" />
                      </button>
                    )}
                    {onJoinPrevious && i > 0 && (
                      <button
                        type="button"
                        onClick={() => onJoinPrevious(i)}
                        className={iconBtn}
                        title={t('split.join')}
                        aria-label={t('split.join')}
                      >
                        <Link2 className="size-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </div>
                {splitIdx === i && (
                  <div className="panel-inset mx-2 mt-1 mb-2 p-2.5 flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">{t('split.hint')}</p>
                    <textarea
                      ref={splitRef}
                      readOnly
                      value={s.text}
                      rows={Math.min(6, Math.max(2, Math.ceil(s.text.length / 70)))}
                      onSelect={() => setSplitError(false)}
                      className="w-full resize-y rounded border border-[hsl(var(--border))] bg-background px-2 py-1.5 text-[15px] leading-relaxed text-foreground focus:outline-none focus:border-[hsl(var(--primary)/0.6)] cursor-text"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {t('split.second')}
                        <select
                          value={splitSpeaker}
                          onChange={(e) => setSplitSpeaker(e.target.value)}
                          className={selectCls}
                        >
                          {speakers.map((sp) => (
                            <option key={sp} value={sp}>
                              {displayName(sp)}
                            </option>
                          ))}
                          <option value={NEW_SPEAKER}>{t('split.newSpeaker')}</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={applySplit}
                        className="btn-console !min-h-8 px-3 border border-[hsl(var(--primary)/0.5)]"
                        style={{ color: 'hsl(var(--primary))' }}
                      >
                        <Scissors className="size-3.5" aria-hidden="true" /> {t('split.apply')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSplitIdx(null)}
                        className="btn-console !min-h-8 px-2 text-muted-foreground hover:text-foreground"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                    {splitError && (
                      <p role="alert" className="text-xs" style={{ color: 'hsl(var(--err))' }}>
                        {t('split.badPos')}
                      </p>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      ) : (
        <p
          className={`text-[15px] leading-relaxed text-foreground/90 whitespace-pre-wrap overflow-y-auto pr-1 ${
            fill ? 'flex-1 min-h-0' : 'max-h-[46vh]'
          }`}
        >
          {result.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[hsl(var(--border))] shrink-0">
        {hasSegments && (
          <div
            className="flex gap-0.5 p-0.5 panel-inset mr-1"
            role="tablist"
            aria-label={t('tv.format')}
          >
            {(
              [
                ['plain', t('tv.plain')],
                ['stamped', t('tv.stamped')],
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
          {copied ? t('common.copied') : t('common.copy')}
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
          disabled={!hasSegments}
          onClick={() => downloadFile(`${baseName}.srt`, toSrt(result.segments))}
        >
          <Download className="size-4" aria-hidden="true" /> SRT
        </button>
        <button
          type="button"
          className={exportBtn}
          disabled={!hasSegments}
          onClick={() => downloadFile(`${baseName}.vtt`, toVtt(result.segments), 'text/vtt')}
        >
          <Download className="size-4" aria-hidden="true" /> VTT
        </button>
      </div>
    </div>
  )
}
