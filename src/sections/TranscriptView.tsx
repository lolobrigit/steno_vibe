import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  Check,
  Copy,
  GitMerge,
  Layers,
  Link2,
  Bookmark,
  GitCompare,
  MessageSquare,
  Pencil,
  Redo2,
  Replace,
  Search,
  Sparkles,
  Undo2,
  ChevronDown,
  ChevronUp,
  Scissors,
  Trash2,
  Users,
  X, Plus,
} from 'lucide-react'
import { formatDurationShort, formatTimecode } from '@/lib/audio'
import { blobToDataUrl, downloadFile, toHtml, toMarkdown, toSrt, toTxt, toTxtStamped, toVtt } from '@/lib/exporters'
import { DiffModal } from '@/sections/DiffModal'
import { ExportMenu } from '@/sections/ExportMenu'
import { activeSegmentIndex, type PlayerHandle } from '@/lib/player'
import { findInText, findMatches, NEW_SPEAKER, nextSpeakerId, speakerColor, speakersOf } from '@/lib/transcript'
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
  /** есть ли медиа: клик по реплике перематывает его (плеер — в MediaPane) */
  hasMedia?: boolean
  playerRef: RefObject<PlayerHandle | null>
  playerState: { playing: boolean; time: number; duration: number }
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
  /** заменить текст реплики `index` */
  onEditSegment?: (index: number, text: string) => void
  /** закладка / комментарий */
  onSegmentMeta?: (index: number, patch: { mark?: boolean; note?: string }) => void
  /** заменить запрос; index — только в этой реплике; возвращает число замен */
  onReplace?: (query: string, replacement: string, matchCase: boolean, index?: number) => number
  /** убрать слова-паразиты; возвращает число удалённых */
  onCleanFillers?: () => number
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** скриншоты для экспорта в документ */
  shots?: { time: number; blob: Blob }[]
  /** занять всю высоту родителя: список реплик прокручивается внутри блока */
  fill?: boolean
}

export { speakerColor }

export function TranscriptView({
  result,
  sourceName,
  hasMedia = false,
  playerRef,
  playerState,
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
  onEditSegment,
  onSegmentMeta,
  onReplace,
  onCleanFillers,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  shots = [],
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
  // поиск и замена
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [replQ, setReplQ] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [curMatch, setCurMatch] = useState(0)
  const findInput = useRef<HTMLInputElement | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [noteIdx, setNoteIdx] = useState<number | null>(null)
  const [editIdx, setEditIdx] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
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

  // спикеры реплик + добавленные вручную (у них есть имя, но пока нет реплик)
  const speakers = useMemo(() => {
    const list = speakersOf(result.segments)
    for (const id of Object.keys(speakerNames)) if (!list.includes(id)) list.push(id)
    return list
  }, [result.segments, speakerNames])
  const [adding, setAdding] = useState(false)
  const [newSpeakerName, setNewSpeakerName] = useState('')
  const addSpeaker = () => {
    const name = newSpeakerName.trim()
    if (name) onRenameSpeaker?.(nextSpeakerId(result.segments, Object.keys(speakerNames)), name)
    setAdding(false)
    setNewSpeakerName('')
  }

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

  const matches = useMemo(
    () => (findOpen ? findMatches(result.segments, findQ, matchCase) : []),
    [findOpen, findQ, matchCase, result.segments],
  )
  const total = matches.reduce((a, m) => a + m.count, 0)
  const curSeg = matches[Math.min(curMatch, Math.max(0, matches.length - 1))]?.index ?? -1

  const scrollToRow = (i: number) => {
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>(`[data-seg="${i}"]`)
    if (!list || !row) return
    userScrollAt.current = Date.now()
    list.scrollTo({ top: Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2), behavior: 'smooth' })
  }
  const goMatch = (delta: number) => {
    if (!matches.length) return
    const n = (curMatch + delta + matches.length) % matches.length
    setCurMatch(n)
    scrollToRow(matches[n].index)
  }
  useEffect(() => setCurMatch(0), [findQ, matchCase])

  // Ctrl/Cmd+F открывает поиск по расшифровке вместо поиска браузера
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
        window.setTimeout(() => findInput.current?.select(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const flash = (text: string) => {
    setNotice(text)
    window.setTimeout(() => setNotice(null), 3500)
  }

  const marks = useMemo(
    () => result.segments.map((s, i) => (s.mark ? i : -1)).filter((i) => i >= 0),
    [result.segments],
  )
  const markCursor = useRef(0)
  const nextMark = () => {
    if (!marks.length) return
    markCursor.current = (markCursor.current + 1) % marks.length
    const i = marks[markCursor.current]
    scrollToRow(i)
    playerRef.current?.seek(result.segments[i].start)
  }

  /** Текст реплики с подсвеченными вхождениями поиска. */
  const highlighted = (text: string, isCur: boolean) => {
    if (!findOpen || !findQ) return text
    const hits = findInText(text, findQ, matchCase)
    if (!hits.length) return text
    const out: React.ReactNode[] = []
    let at = 0
    hits.forEach((h, k) => {
      out.push(text.slice(at, h.at))
      out.push(
        <mark key={k} className={`rounded px-0.5 text-foreground ${isCur ? 'bg-[hsl(var(--primary)/0.55)]' : 'bg-[hsl(var(--warn)/0.4)]'}`}>
          {text.slice(h.at, h.at + h.len)}
        </mark>,
      )
      at = h.at + h.len
    })
    out.push(text.slice(at))
    return out
  }

  // черновик правки переживает перезагрузку страницы
  const DRAFT_KEY = 'steno.draft.v1'
  useEffect(() => {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') as { sig: string; idx: number; text: string } | null
      if (d && d.sig === activeVersionId && result.segments[d.idx] && onEditSegment) {
        setEditIdx(d.idx)
        setEditText(d.text)
      }
    } catch {
      /* ignore */
    }
    // только при открытии версии
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVersionId])
  const clearDraft = () => {
    try {
      localStorage.removeItem(DRAFT_KEY)
    } catch {
      /* ignore */
    }
  }

  const buildDoc = async (kind: 'md' | 'html', withShots: boolean): Promise<string> => {
    const docShots = withShots
      ? await Promise.all(shots.map(async (s) => ({ time: s.time, dataUrl: await blobToDataUrl(s.blob) })))
      : []
    const opts = {
      title: baseName,
      segments: result.segments,
      fallbackText: result.text,
      nameOf: displayName,
      shots: docShots,
      noteLabel: t('note.label'),
    }
    return kind === 'md' ? toMarkdown(opts) : toHtml(opts)
  }

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

  const startEdit = (i: number) => {
    setSplitIdx(null)
    setEditText(result.segments[i]?.text ?? '')
    setEditIdx(i)
    setNoteIdx(null)
  }
  const commitEdit = () => {
    if (editIdx === null) return
    const text = editText.replace(/\s+/g, ' ').trim()
    if (text && text !== result.segments[editIdx]?.text) onEditSegment?.(editIdx, text)
    setEditIdx(null)
    clearDraft()
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

      {/* инструменты: поиск, отмена правок, чистка, сравнение, закладки */}
      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
        {onReplace && (
          <button type="button" onClick={() => { setFindOpen((v) => !v); window.setTimeout(() => findInput.current?.focus(), 0) }} aria-pressed={findOpen} title={`${t('find.btn')} (Ctrl+F)`} aria-label={t('find.btn')} className={`${iconBtn} ${findOpen ? '!text-[hsl(var(--primary))]' : ''}`}>
            <Search className="size-4" aria-hidden="true" />
          </button>
        )}
        {onUndo && (
          <>
            <button type="button" onClick={onUndo} disabled={!canUndo} title={`${t('undo.undo')} (Ctrl+Z)`} aria-label={t('undo.undo')} className={`${iconBtn} disabled:opacity-30 disabled:cursor-not-allowed`}>
              <Undo2 className="size-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={onRedo} disabled={!canRedo} title={`${t('undo.redo')} (Ctrl+Shift+Z)`} aria-label={t('undo.redo')} className={`${iconBtn} disabled:opacity-30 disabled:cursor-not-allowed`}>
              <Redo2 className="size-4" aria-hidden="true" />
            </button>
          </>
        )}
        {onCleanFillers && hasSegments && (
          <button
            type="button"
            onClick={() => {
              const n = onCleanFillers()
              flash(n > 0 ? t('fill.done', { n }) : t('fill.none'))
            }}
            title={t('fill.btn')}
            aria-label={t('fill.btn')}
            className={iconBtn}
          >
            <Sparkles className="size-4" aria-hidden="true" />
          </button>
        )}
        {versions.length > 1 && (
          <button type="button" onClick={() => setDiffOpen(true)} title={t('diff.title')} aria-label={t('diff.title')} className={iconBtn}>
            <GitCompare className="size-4" aria-hidden="true" />
          </button>
        )}
        {marks.length > 0 && (
          <button type="button" onClick={nextMark} title={t('mark.next')} className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs text-[hsl(var(--warn))] hover:bg-[hsl(var(--row-hover))] cursor-pointer">
            <Bookmark className="size-3.5 fill-current" aria-hidden="true" /> {marks.length}
          </button>
        )}
        {notice && <span role="status" className="text-xs text-muted-foreground ml-1">{notice}</span>}
      </div>

      {findOpen && onReplace && (
        <div className="panel-inset px-2.5 py-2 flex flex-wrap items-center gap-2 shrink-0 text-xs">
          <input
            ref={findInput}
            value={findQ}
            onChange={(e) => setFindQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') goMatch(e.shiftKey ? -1 : 1)
              if (e.key === 'Escape') setFindOpen(false)
            }}
            placeholder={t('find.placeholder')}
            aria-label={t('find.placeholder')}
            className="h-8 w-40 rounded border border-[hsl(var(--border))] bg-background px-2 text-foreground"
          />
          <span className="tabular-nums text-muted-foreground min-w-[3.5rem]">
            {findQ ? (total ? `${Math.min(curMatch, matches.length - 1) + 1}/${matches.length}` : t('find.none')) : ''}
          </span>
          <button type="button" onClick={() => goMatch(-1)} disabled={!matches.length} aria-label={t('find.prev')} className={`${iconBtn} disabled:opacity-30`}><ChevronUp className="size-4" aria-hidden="true" /></button>
          <button type="button" onClick={() => goMatch(1)} disabled={!matches.length} aria-label={t('find.next')} className={`${iconBtn} disabled:opacity-30`}><ChevronDown className="size-4" aria-hidden="true" /></button>
          <label className="flex items-center gap-1 text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> {t('find.case')}
          </label>
          <input
            value={replQ}
            onChange={(e) => setReplQ(e.target.value)}
            placeholder={t('find.replaceWith')}
            aria-label={t('find.replaceWith')}
            className="h-8 w-40 rounded border border-[hsl(var(--border))] bg-background px-2 text-foreground"
          />
          <button
            type="button"
            disabled={!matches.length}
            onClick={() => {
              if (curSeg >= 0) onReplace(findQ, replQ, matchCase, curSeg)
            }}
            className="btn-console !min-h-8 px-2.5 disabled:opacity-40 cursor-pointer"
          >
            <Replace className="size-3.5" aria-hidden="true" /> {t('find.replace')}
          </button>
          <button
            type="button"
            disabled={!matches.length}
            onClick={() => flash(t('find.replaced', { n: onReplace(findQ, replQ, matchCase) }))}
            className="btn-console !min-h-8 px-2.5 disabled:opacity-40 cursor-pointer"
          >
            {t('find.replaceAll')}
          </button>
        </div>
      )}

      {diffOpen && <DiffModal versions={versions} activeId={activeVersionId} onClose={() => setDiffOpen(false)} />}

      {(speakers.length > 0 || (!!onRenameSpeaker && result.segments.length > 0)) && (
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
            {onRenameSpeaker && (
              adding ? (
                <input
                  autoFocus
                  value={newSpeakerName}
                  onChange={(e) => setNewSpeakerName(e.target.value)}
                  onBlur={addSpeaker}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addSpeaker()
                    if (e.key === 'Escape') {
                      setNewSpeakerName('')
                      setAdding(false)
                    }
                  }}
                  placeholder={t('spk.addName')}
                  className="h-7 w-36 rounded border border-[hsl(var(--primary)/0.5)] bg-background px-2 text-xs focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="flex items-center gap-1 rounded-full border border-dashed border-[hsl(var(--border))] px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-[hsl(var(--primary)/0.5)] cursor-pointer"
                >
                  <Plus className="size-3" aria-hidden="true" /> {t('spk.add')}
                </button>
              )
            )}
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
          data-sync="transcript"
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
              <li key={i} data-seg={i} data-start={s.start}>
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
                      : 'hover:bg-[hsl(var(--row-hover))]') +
                    (s.mark ? ' border-l-2 border-[hsl(var(--warn))]' : '')
                  }
                >
                  <span className="font-mono text-[11px] text-[hsl(var(--primary)/0.8)] pt-0.5 whitespace-nowrap">
                    <button
                      type="button"
                      className="hover:underline disabled:no-underline"
                      disabled={!hasMedia}
                      title={hasMedia ? t('tv.jump') : undefined}
                      onClick={() => playerRef.current?.seek(s.start, true)}
                    >
                      {formatTimecode(s.start)}
                    </button>
                    <span className="hidden sm:inline text-muted-foreground/60">
                      {' '}
                      → {formatTimecode(s.end)}
                    </span>
                    {onReassignSegment && (speakers.length > 0 || s.speaker) && (
                      <select
                        value={s.speaker ?? ''}
                        onChange={(e) =>
                          onReassignSegment(
                            i,
                            e.target.value === NEW_SPEAKER
                              ? nextSpeakerId(result.segments, Object.keys(speakerNames))
                              : e.target.value,
                          )
                        }
                        title={t('tv.reassign')}
                        className="mt-1 block w-full max-w-[110px] rounded border border-[hsl(var(--border))] bg-background px-1 py-0.5 text-[10px] text-muted-foreground focus:outline-none focus:border-[hsl(var(--primary)/0.5)]"
                      >
                        {!s.speaker && <option value="">{t('spk.none')}</option>}
                        {speakers.map((sp) => (
                          <option key={sp} value={sp}>
                            {displayName(sp)}
                          </option>
                        ))}
                        <option value={NEW_SPEAKER}>{t('split.newSpeaker')}</option>
                      </select>
                    )}
                  </span>
                  <div className="min-w-0">
                  {editIdx === i ? (
                    <div className="flex flex-col gap-1.5 min-w-0">
                      <textarea
                        autoFocus
                        value={editText}
                        rows={Math.max(2, Math.ceil(editText.length / 60))}
                        onChange={(e) => {
                          setEditText(e.target.value)
                          try {
                            localStorage.setItem(DRAFT_KEY, JSON.stringify({ sig: activeVersionId, idx: editIdx, text: e.target.value }))
                          } catch {
                            /* ignore */
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setEditIdx(null)
                            clearDraft()
                          }
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitEdit()
                        }}
                        aria-label={t('edit.btn')}
                        className="w-full resize-y rounded border border-[hsl(var(--primary)/0.5)] bg-background px-2 py-1.5 text-[15px] leading-relaxed focus:outline-none"
                      />
                      <div className="flex items-center gap-2 text-xs">
                        <button type="button" onClick={commitEdit} className="btn-console !min-h-8 px-2.5 cursor-pointer" style={{ color: 'hsl(var(--primary))' }}>
                          <Check className="size-3.5" aria-hidden="true" /> {t('edit.save')}
                        </button>
                        <button type="button" onClick={() => { setEditIdx(null); clearDraft() }} className="btn-console !min-h-8 px-2.5 cursor-pointer text-muted-foreground">
                          <X className="size-3.5" aria-hidden="true" /> {t('common.cancel')}
                        </button>
                        <span className="text-muted-foreground/70 hidden sm:inline">{t('edit.hint')}</span>
                      </div>
                    </div>
                  ) : (
                    <span
                      className={
                        'text-[15px] leading-relaxed text-foreground/90 ' +
                        (hasMedia ? 'cursor-pointer hover:text-foreground' : '')
                      }
                      title={hasMedia ? t('tv.jump') : undefined}
                      onClick={() => playerRef.current?.seek(s.start, true)}
                      onDoubleClick={() => onEditSegment && startEdit(i)}
                    >
                      {highlighted(s.text, i === curSeg)}
                    </span>
                  )}
                  {s.note && noteIdx !== i && (
                    <p className="mt-0.5 text-xs italic text-muted-foreground cursor-pointer" onClick={() => setNoteIdx(i)}>
                      <MessageSquare className="size-3 inline mr-1" aria-hidden="true" />
                      {s.note}
                    </p>
                  )}
                  {noteIdx === i && (
                    <input
                      autoFocus
                      defaultValue={s.note ?? ''}
                      placeholder={t('note.placeholder')}
                      aria-label={t('note.placeholder')}
                      onBlur={(e) => {
                        onSegmentMeta?.(i, { note: e.target.value.trim() })
                        setNoteIdx(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') setNoteIdx(null)
                      }}
                      className="mt-1 w-full rounded border border-[hsl(var(--border))] bg-background px-2 py-1 text-xs"
                    />
                  )}
                  </div>
                  <span className="flex items-start gap-0.5 opacity-60 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
                    {onSegmentMeta && (
                      <>
                        <button
                          type="button"
                          onClick={() => onSegmentMeta(i, { mark: !s.mark })}
                          aria-pressed={!!s.mark}
                          className={`${iconBtn} ${s.mark ? '!text-[hsl(var(--warn))] !opacity-100' : ''}`}
                          title={t('mark.toggle')}
                          aria-label={t('mark.toggle')}
                        >
                          <Bookmark className={`size-3.5 ${s.mark ? 'fill-current' : ''}`} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setNoteIdx(noteIdx === i ? null : i)}
                          className={iconBtn}
                          title={t('note.btn')}
                          aria-label={t('note.btn')}
                        >
                          <MessageSquare className="size-3.5" aria-hidden="true" />
                        </button>
                      </>
                    )}
                    {onEditSegment && (
                      <button
                        type="button"
                        onClick={() => startEdit(i)}
                        className={`${iconBtn} ${editIdx === i ? '!text-[hsl(var(--primary))]' : ''}`}
                        title={t('edit.btn')}
                        aria-label={t('edit.btn')}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </button>
                    )}
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
        <ExportMenu
          hasSegments={hasSegments}
          baseName={baseName}
          shotsCount={shots.length}
          onTxt={() => downloadFile(`${baseName}.txt`, exportText())}
          onSrt={() => downloadFile(`${baseName}.srt`, toSrt(result.segments))}
          onVtt={() => downloadFile(`${baseName}.vtt`, toVtt(result.segments), 'text/vtt')}
          buildDoc={buildDoc}
        />
      </div>
    </div>
  )
}
