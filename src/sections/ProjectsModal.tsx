import { useCallback, useEffect, useRef, useState } from 'react'
import { Cloud, Download, FileUp, HardDriveDownload, Loader2, RefreshCw, X } from 'lucide-react'
import type { HistoryItem } from '@/types'
import { useT } from '@/i18n'
import { formatBytes } from '@/lib/audio'
import { PROVIDER_LIST, PROVIDERS, CloudError, type CloudFile, type CloudId } from '@/lib/cloud'
import { PROJECT_EXT, projectFileName } from '@/lib/project'
import { buildExport, importProject } from '@/lib/projectStore'

interface Props {
  items: HistoryItem[]
  /** id открытой записи (если есть) — экспорт «только этот проект» */
  currentId?: string | null
  onClose: () => void
  onImported: (list: HistoryItem[]) => void
}

type Dest = 'file' | CloudId

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`h-9 px-3 text-xs rounded-full border cursor-pointer transition-colors ${
        on
          ? 'border-[hsl(var(--primary))] text-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.12)]'
          : 'border-[hsl(var(--border))] text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function DestPicker({ value, set }: { value: Dest; set: (d: Dest) => void }) {
  const t = useT()
  return (
    <div className="flex flex-wrap gap-2">
      <Chip on={value === 'file'} onClick={() => set('file')}>
        {t('prj.destFile')}
      </Chip>
      {PROVIDER_LIST.map((p) => (
        <Chip key={p.id} on={value === p.id} onClick={() => set(p.id)}>
          {p.label}
        </Chip>
      ))}
    </div>
  )
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function ProjectsModal({ items, currentId, onClose, onImported }: Props) {
  const t = useT()
  const [tab, setTab] = useState<'export' | 'import'>('export')
  const [scope, setScope] = useState<'current' | 'all'>(currentId ? 'current' : 'all')
  const [withAudio, setWithAudio] = useState(true)
  const [dest, setDest] = useState<Dest>('file')
  const [src, setSrc] = useState<Dest>('file')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [files, setFiles] = useState<CloudFile[] | null>(null)
  const [, bump] = useState(0)
  const [drafts, setDrafts] = useState<Partial<Record<CloudId, string>>>({})
  const fileInput = useRef<HTMLInputElement>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  const fail = (e: unknown) => {
    if (e instanceof DOMException && e.name === 'AbortError') return
    let text: string
    if (e instanceof CloudError) {
      text = t(`prj.err.${e.code}`)
      if (e.detail) text += ` (${e.detail})`
      else if (e.status) text += ` (${e.status})`
    } else if (e instanceof Error && (e.message === 'not-a-project' || e.message === 'corrupt-project')) {
      text = t('prj.err.bad')
    } else {
      text = e instanceof Error ? e.message : String(e)
    }
    setMsg({ kind: 'err', text })
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMsg(null)
    setProgress(null)
    abort.current = new AbortController()
    try {
      await fn()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const ensureConnected = async (id: CloudId) => {
    const p = PROVIDERS[id]
    if (!p.credential()) throw new CloudError('no-credential')
    if (!p.connected()) await p.connect()
    bump((n) => n + 1)
  }

  const chosen = scope === 'current' && currentId ? items.filter((i) => i.id === currentId) : items

  const doExport = () =>
    run(async () => {
      if (chosen.length === 0) return
      const blob = await buildExport(chosen, withAudio)
      const name = projectFileName(chosen.map((item) => ({ item })))
      if (dest === 'file') {
        saveBlob(blob, name)
        setMsg({ kind: 'ok', text: t('prj.doneFile', { name }) })
        return
      }
      await ensureConnected(dest)
      try {
        await PROVIDERS[dest].upload(name, blob, setProgress, abort.current!.signal)
      } catch (e) {
        if (e instanceof CloudError && e.code === 'auth') {
          PROVIDERS[dest].disconnect()
          bump((n) => n + 1)
        }
        throw e
      }
      setMsg({ kind: 'ok', text: t('prj.doneCloud', { name, cloud: PROVIDERS[dest].label }) })
    })

  const finishImport = async (blob: Blob) => {
    const { list, count } = await importProject(blob)
    onImported(list)
    setMsg({ kind: 'ok', text: t('prj.imported', { n: count }) })
  }

  const loadList = useCallback(
    (id: CloudId) =>
      run(async () => {
        await ensureConnected(id)
        try {
          setFiles(await PROVIDERS[id].list())
        } catch (e) {
          if (e instanceof CloudError && e.code === 'auth') {
            PROVIDERS[id].disconnect()
            bump((n) => n + 1)
          }
          throw e
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const downloadFrom = (id: CloudId, f: CloudFile) =>
    run(async () => {
      const blob = await PROVIDERS[id].download(f, setProgress, abort.current!.signal)
      await finishImport(blob)
    })

  const cloud = dest !== 'file' ? PROVIDERS[dest] : null
  const srcCloud = src !== 'file' ? PROVIDERS[src] : null
  const needKey = (c: typeof cloud) => !!c && !c.credential()

  const keyField = (id: CloudId) => {
    const p = PROVIDERS[id]
    const v = drafts[id] ?? p.credential()
    if (!needKey(p)) {
      return (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{p.connected() ? t('prj.connected') : t('prj.notConnected')}</span>
          {p.connected() && (
            <button
              type="button"
              className="underline cursor-pointer"
              onClick={() => {
                p.disconnect()
                bump((n) => n + 1)
              }}
            >
              {t('prj.disconnect')}
            </button>
          )}
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-1.5">
        <label className="chrome-label !text-[10px]">{t('prj.keyLabel', { label: p.credentialLabel })}</label>
        <input
          value={v}
          onChange={(e) => {
            setDrafts((d) => ({ ...d, [id]: e.target.value }))
            p.setCredential(e.target.value)
          }}
          spellCheck={false}
          className="h-9 px-2 text-xs rounded border border-[hsl(var(--border))] bg-transparent font-mono"
        />
        <a href={p.consoleUrl} target="_blank" rel="noreferrer" className="text-[11px] underline text-muted-foreground">
          {t('prj.getKey')}
        </a>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('prj.title')}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="panel w-full max-w-lg max-h-[85vh] flex flex-col shadow-xl shadow-black/40">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))]">
          <h2 className="chrome-label">{t('prj.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="size-9 inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex gap-2 px-4 pt-3">
          <Chip on={tab === 'export'} onClick={() => { setTab('export'); setMsg(null) }}>
            <Download className="size-3.5 inline mr-1.5" aria-hidden="true" />
            {t('prj.export')}
          </Chip>
          <Chip on={tab === 'import'} onClick={() => { setTab('import'); setMsg(null) }}>
            <FileUp className="size-3.5 inline mr-1.5" aria-hidden="true" />
            {t('prj.import')}
          </Chip>
        </div>

        <div className="p-4 flex flex-col gap-4 overflow-y-auto">
          {tab === 'export' ? (
            <>
              <div className="flex flex-col gap-2">
                <span className="chrome-label !text-[10px]">{t('prj.scope')}</span>
                <div className="flex gap-2">
                  {currentId && (
                    <Chip on={scope === 'current'} onClick={() => setScope('current')}>
                      {t('prj.scopeCurrent')}
                    </Chip>
                  )}
                  <Chip on={scope === 'all'} onClick={() => setScope('all')}>
                    {t('prj.scopeAll', { n: items.length })}
                  </Chip>
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={withAudio} onChange={(e) => setWithAudio(e.target.checked)} className="mt-1" />
                <span>
                  {t('prj.withAudio')}
                  <span className="block text-xs text-muted-foreground">{t('prj.withAudioHint')}</span>
                </span>
              </label>
              <div className="flex flex-col gap-2">
                <span className="chrome-label !text-[10px]">{t('prj.dest')}</span>
                <DestPicker value={dest} set={(d) => { setDest(d); setMsg(null) }} />
              </div>
              {cloud && keyField(cloud.id)}
              <button
                type="button"
                disabled={busy || chosen.length === 0 || (needKey(cloud))}
                onClick={doExport}
                className="btn-console h-10 inline-flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
              >
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : cloud ? <Cloud className="size-4" aria-hidden="true" /> : <HardDriveDownload className="size-4" aria-hidden="true" />}
                {busy ? t('prj.running') : t('prj.run')}
              </button>
            </>
          ) : (
            <>
              <input
                ref={fileInput}
                type="file"
                accept={`${PROJECT_EXT},application/octet-stream`}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void run(() => finishImport(f))
                }}
              />
              <div className="flex flex-col gap-2">
                <span className="chrome-label !text-[10px]">{t('prj.source')}</span>
                <DestPicker value={src} set={(d) => { setSrc(d); setFiles(null); setMsg(null) }} />
              </div>
              {srcCloud && keyField(srcCloud.id)}
              {src === 'file' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                  className="btn-console h-10 inline-flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <FileUp className="size-4" aria-hidden="true" />}
                  {t('prj.pickFile')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy || needKey(srcCloud)}
                    onClick={() => loadList(src as CloudId)}
                    className="btn-console h-10 inline-flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
                  >
                    {busy && !files ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
                    {files ? t('prj.refresh') : t('prj.showList')}
                  </button>
                  {files && files.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center">{t('prj.empty')}</p>
                  )}
                  {files && files.length > 0 && (
                    <ul className="flex flex-col">
                      {files.map((f) => (
                        <li key={f.id} className="flex items-center gap-2 py-2 border-t first:border-t-0 border-[hsl(var(--border))]">
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] truncate">{f.name}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {formatBytes(f.size)}
                              {f.modified && <> · {new Date(f.modified).toLocaleString()}</>}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => downloadFrom(src as CloudId, f)}
                            className="btn-console h-9 px-3 text-xs disabled:opacity-50 cursor-pointer"
                          >
                            {t('prj.importOne')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          )}

          {progress !== null && (
            <div className="h-1.5 rounded bg-[hsl(var(--border))] overflow-hidden" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
              <div className="h-full bg-[hsl(var(--primary))] transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          {msg && (
            <p
              role={msg.kind === 'err' ? 'alert' : 'status'}
              className={`text-xs break-words ${msg.kind === 'err' ? 'text-[hsl(var(--err))]' : 'text-[hsl(var(--ok,var(--primary)))]'}`}
            >
              {msg.text}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
