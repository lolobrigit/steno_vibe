import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, HardDrive, Trash2, X } from 'lucide-react'
import type { HistoryItem, TranscriptVersion } from '@/types'
import { useT } from '@/i18n'
import { formatBytes } from '@/lib/audio'
import { deleteAudio, deleteConvertedWav, getAudio, getConvertedWav, listAudio, type StoredAudioMeta } from '@/lib/audioStore'
import { downloadBlob, downloadFile, toSrt, toTxt } from '@/lib/exporters'
import { loadHistory, updateHistory } from '@/lib/storage'
import { loadVersions, saveVersions } from '@/lib/versionStore'

interface Props {
  onClose: () => void
  /** список истории изменился (чтобы главная страница обновила свою копию) */
  onHistory: (list: HistoryItem[]) => void
  /** удалить проект целиком (история, файлы, версии) */
  onRemoveProject: (id: string) => void
}

interface Row {
  item: HistoryItem
  audio?: StoredAudioMeta
  versions: TranscriptVersion[]
  activeId?: string
  /** размеры версий в байтах (JSON) */
  sizes: Record<string, number>
}

const bytesOf = (v: unknown) => new Blob([JSON.stringify(v)]).size

/** Подробное хранилище: по каждому проекту — оригинал, конвертация и версии с размерами и удалением. */
export function StorageModal({ onClose, onHistory, onRemoveProject }: Props) {
  const t = useT()
  const [rows, setRows] = useState<Row[]>([])
  const [orphans, setOrphans] = useState<StoredAudioMeta[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const history = loadHistory()
    const audio = await listAudio()
    const byId = new Map(audio.map((a) => [a.id, a]))
    const out: Row[] = []
    for (const item of history) {
      const stored = await loadVersions(item.id)
      // записи из старых версий приложения без версий: один условный «распознанный» вариант
      const versions: TranscriptVersion[] = stored?.versions?.length
        ? stored.versions
        : [
            {
              id: 'legacy',
              createdAt: item.createdAt,
              kind: 'asr',
              label: item.modelLabel || item.engineLabel,
              text: item.text,
              segments: item.segments,
              speakerNames: item.speakerNames ?? {},
              language: item.language,
              durationSec: item.durationSec,
              elapsedSec: item.elapsedSec,
              engineLabel: item.engineLabel,
              modelLabel: item.modelLabel,
            },
          ]
      out.push({
        item,
        audio: byId.get(item.id),
        versions,
        activeId: stored?.activeVersionId ?? item.activeVersionId,
        sizes: Object.fromEntries(versions.map((v) => [v.id, bytesOf(v)])),
      })
    }
    const ids = new Set(history.map((h) => h.id))
    setRows(out)
    setOrphans(audio.filter((a) => !ids.has(a.id)))
    setLoading(false)
    try {
      const est = await navigator.storage?.estimate?.()
      if (est?.usage !== undefined && est.quota !== undefined) setQuota({ usage: est.usage, quota: est.quota })
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const totals = useMemo(() => {
    const sum = (kind: TranscriptVersion['kind']) =>
      rows.reduce(
        (a, r) => {
          for (const v of r.versions) if (v.kind === kind) a = { n: a.n + 1, bytes: a.bytes + (r.sizes[v.id] ?? 0) }
          return a
        },
        { n: 0, bytes: 0 },
      )
    const all = [...rows.map((r) => r.audio), ...orphans].filter(Boolean) as StoredAudioMeta[]
    return {
      files: { n: all.length, bytes: all.reduce((a, f) => a + f.size, 0) },
      wav: {
        n: all.filter((f) => f.wavSize).length,
        bytes: all.reduce((a, f) => a + (f.wavSize ?? 0), 0),
      },
      asr: sum('asr'),
      llm: sum('llm'),
      edit: sum('edit'),
    }
  }, [rows, orphans])

  const afterChange = async () => {
    onHistory(loadHistory())
    await load()
  }

  const baseOf = (name: string) => name.replace(/\.[^./\\]+$/, '') || 'steno'
  const dlFile = async (id: string, name: string) => {
    const b = await getAudio(id)
    if (b) downloadBlob(name, b)
  }
  const dlWav = async (id: string, name: string) => {
    const b = await getConvertedWav(id)
    if (b) downloadBlob(`${baseOf(name)}.wav`, b)
  }
  const dlVersion = (r: Row, v: TranscriptVersion, kind: 'txt' | 'srt') => {
    const base = `${baseOf(r.item.sourceName)}_${v.kind}_${new Date(v.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`
    if (kind === 'srt') downloadFile(`${base}.srt`, toSrt(v.segments), 'application/x-subrip')
    else downloadFile(`${base}.txt`, v.segments.length ? toTxt(v.segments, v.text) : v.text)
  }

  const delFile = async (r: Row) => {
    await deleteAudio(r.item.id)
    updateHistory(r.item.id, { hasAudio: false })
    await afterChange()
  }
  const delWav = async (id: string) => {
    await deleteConvertedWav(id)
    await load()
  }
  const delVersion = async (r: Row, v: TranscriptVersion) => {
    const left = r.versions.filter((x) => x.id !== v.id)
    if (left.length === 0 || v.id === r.activeId || v.id === 'legacy') return
    await saveVersions({ id: r.item.id, versions: left, activeVersionId: r.activeId ?? left[left.length - 1].id })
    await load()
  }

  const stat = (label: string, n: number, bytes: number) => (
    <div className="panel-inset px-3 py-2 min-w-[8.5rem] flex-1">
      <div className="chrome-label !text-[10px]">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{formatBytes(bytes)}</div>
      <div className="text-[11px] text-muted-foreground">{n}</div>
    </div>
  )
  const del =
    'size-8 shrink-0 inline-flex items-center justify-center text-muted-foreground/60 hover:text-[hsl(var(--err))] cursor-pointer'
  const dlBtn =
    'size-8 shrink-0 inline-flex items-center justify-center text-muted-foreground/60 hover:text-foreground cursor-pointer'
  const line = 'flex items-center gap-2 py-1.5 border-t first:border-t-0 border-[hsl(var(--border))] text-[13px]'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('stor.title')}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="panel w-full max-w-4xl h-[88dvh] flex flex-col shadow-xl shadow-black/40">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))]">
          <h2 className="chrome-label flex items-center gap-2">
            <HardDrive className="size-3.5" style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />
            {t('stor.title')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="size-8 inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 overflow-y-auto min-h-0">
          <div className="flex flex-wrap gap-2">
            {stat(t('stor.cat.original'), totals.files.n, totals.files.bytes)}
            {stat(t('stor.cat.converted'), totals.wav.n, totals.wav.bytes)}
            {stat(t('stor.cat.asr'), totals.asr.n, totals.asr.bytes)}
            {stat(t('stor.cat.llm'), totals.llm.n, totals.llm.bytes)}
            {stat(t('stor.cat.edit'), totals.edit.n, totals.edit.bytes)}
          </div>
          {quota && (
            <div className="flex flex-col gap-1">
              <div className="h-1.5 rounded bg-[hsl(var(--border))] overflow-hidden">
                <div className="h-full bg-[hsl(var(--primary))]" style={{ width: `${Math.min(100, (quota.usage / quota.quota) * 100)}%` }} />
              </div>
              <span className="text-[11px] text-muted-foreground">
                {t('stor.browser', { used: formatBytes(quota.usage), total: formatBytes(quota.quota) })}
              </span>
            </div>
          )}

          {loading ? null : rows.length === 0 && orphans.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('stor.none')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((r) => {
                const open = openId === r.item.id
                const total = (r.audio?.size ?? 0) + (r.audio?.wavSize ?? 0) + (Object.values(r.sizes) as number[]).reduce((a, b) => a + b, 0)
                return (
                  <li key={r.item.id} className="panel-inset">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <button type="button" onClick={() => setOpenId(open ? null : r.item.id)} aria-expanded={open} className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer">
                        {open ? <ChevronDown className="size-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0" aria-hidden="true" />}
                        <span className="truncate text-sm font-medium" title={r.item.sourceName}>{r.item.sourceName}</span>
                        <span className="text-[11px] text-muted-foreground shrink-0">{new Date(r.item.createdAt).toLocaleDateString()}</span>
                      </button>
                      <span className="font-mono text-[11px] text-muted-foreground shrink-0">{formatBytes(total)}</span>
                      <button type="button" onClick={() => onRemoveProject(r.item.id)} className={del} aria-label={`${t('stor.deleteProject')}: ${r.item.sourceName}`} title={t('stor.deleteProject')}>
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    {open && (
                      <div className="px-3 pb-3 flex flex-col">
                        <div className={line}>
                          <span className="w-44 shrink-0 text-muted-foreground">{t('stor.cat.original')}</span>
                          {r.audio ? (
                            <>
                              <span className="flex-1 truncate" title={r.audio.name}>{r.audio.name} · {r.audio.type || '—'}</span>
                              <span className="font-mono text-[11px] text-muted-foreground">{formatBytes(r.audio.size)}</span>
                              <button type="button" onClick={() => void dlFile(r.item.id, r.audio!.name)} className={dlBtn} aria-label={t('exp.download')} title={t('exp.download')}>
                                <Download className="size-3.5" aria-hidden="true" />
                              </button>
                              <button type="button" onClick={() => void delFile(r)} className={del} aria-label={t('stor.deleteFile')} title={t('stor.deleteFile')}>
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              </button>
                            </>
                          ) : (
                            <span className="flex-1 text-muted-foreground">{t('stor.absent')}</span>
                          )}
                        </div>
                        <div className={line}>
                          <span className="w-44 shrink-0 text-muted-foreground">{t('stor.cat.converted')}</span>
                          {r.audio?.wavSize ? (
                            <>
                              <span className="flex-1">WAV</span>
                              <span className="font-mono text-[11px] text-muted-foreground">{formatBytes(r.audio.wavSize)}</span>
                              <button type="button" onClick={() => void dlWav(r.item.id, r.audio!.name)} className={dlBtn} aria-label={t('exp.download')} title={t('exp.download')}>
                                <Download className="size-3.5" aria-hidden="true" />
                              </button>
                              <button type="button" onClick={() => void delWav(r.item.id)} className={del} aria-label={t('stor.deleteWav')} title={t('stor.deleteWav')}>
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              </button>
                            </>
                          ) : (
                            <span className="flex-1 text-muted-foreground">{t('stor.absent')}</span>
                          )}
                        </div>
                        {r.versions.map((v) => (
                          <div key={v.id} className={line}>
                            <span className="w-44 shrink-0 text-muted-foreground">
                              {t(`stor.cat.${v.kind}`)}
                              {v.id === r.activeId && <span className="ml-1.5 text-[10px] text-[hsl(var(--primary))]">● {t('stor.active')}</span>}
                            </span>
                            <span className="flex-1 truncate" title={v.label}>{v.label} · {new Date(v.createdAt).toLocaleString()}</span>
                            <span className="font-mono text-[11px] text-muted-foreground">{formatBytes(r.sizes[v.id] ?? 0)}</span>
                            <button type="button" onClick={() => dlVersion(r, v, 'txt')} className={`${dlBtn} !w-auto px-1.5 text-[11px] font-mono`} title={t('exp.download')} aria-label={`${t('exp.download')} TXT`}>
                              TXT
                            </button>
                            {v.segments.length > 0 && (
                              <button type="button" onClick={() => dlVersion(r, v, 'srt')} className={`${dlBtn} !w-auto px-1.5 text-[11px] font-mono`} title={t('exp.download')} aria-label={`${t('exp.download')} SRT`}>
                                SRT
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={v.id === r.activeId || v.id === 'legacy' || r.versions.length < 2}
                              onClick={() => void delVersion(r, v)}
                              className={`${del} disabled:opacity-25 disabled:cursor-not-allowed`}
                              aria-label={t('stor.deleteVersion')}
                              title={v.id === r.activeId ? t('stor.activeKeep') : t('stor.deleteVersion')}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                )
              })}
              {orphans.length > 0 && (
                <li className="panel-inset px-3 py-2">
                  <div className="chrome-label !text-[10px] mb-1">{t('stor.orphans')}</div>
                  {orphans.map((f) => (
                    <div key={f.id} className={line}>
                      <span className="flex-1 truncate" title={f.name}>{f.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{formatBytes(f.size + (f.wavSize ?? 0))}</span>
                      <button type="button" onClick={() => void dlFile(f.id, f.name)} className={dlBtn} aria-label={t('exp.download')} title={t('exp.download')}>
                        <Download className="size-3.5" aria-hidden="true" />
                      </button>
                      <button type="button" onClick={() => void deleteAudio(f.id).then(load)} className={del} aria-label={`${t('common.delete')} ${f.name}`}>
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </li>
              )}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground/80 leading-snug">{t('stor.modelsNote')}</p>
        </div>
      </div>
    </div>
  )
}
