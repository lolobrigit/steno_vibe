import { useEffect, useRef, useState } from 'react'
import { Download, Eye, Loader2, X } from 'lucide-react'
import { downloadFile } from '@/lib/exporters'
import { mdToHtml, shortenDataUrls } from '@/lib/mdPreview'
import { useT } from '@/i18n'

type DocKind = 'md' | 'html'

interface Props {
  hasSegments: boolean
  baseName: string
  /** сколько скриншотов можно приложить к документу */
  shotsCount: number
  onTxt: () => void
  onSrt: () => void
  onVtt: () => void
  /** собрать текст документа */
  buildDoc: (kind: DocKind, withShots: boolean) => Promise<string>
}

const MIME: Record<DocKind, string> = { md: 'text/markdown', html: 'text/html' }

/** Кнопка загрузки: всплывающее меню форматов; для MD и HTML — со скриншотами или без, плюс предпросмотр. */
export function ExportMenu({ hasSegments, baseName, shotsCount, onTxt, onSrt, onVtt, buildDoc }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [withShots, setWithShots] = useState(true)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ kind: DocKind; content: string; source: boolean } | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const shots = shotsCount > 0 && withShots

  const download = async (kind: DocKind) => {
    setBusy(true)
    try {
      downloadFile(`${baseName}.${kind}`, await buildDoc(kind, shots), MIME[kind])
    } finally {
      setBusy(false)
    }
  }
  const show = async (kind: DocKind) => {
    setBusy(true)
    try {
      setPreview({ kind, content: await buildDoc(kind, shots), source: false })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const item =
    'w-full text-left px-3 py-2 text-sm hover:bg-[hsl(var(--row-hover))] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'
  const small =
    'size-8 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--row-hover))] cursor-pointer disabled:opacity-40'

  const docRow = (kind: DocKind, label: string, hint: string) => (
    <div className="flex items-center gap-1 pr-1">
      <span className="flex-1 px-3 py-2 text-sm" title={hint}>
        {label}
      </span>
      <button type="button" disabled={busy} onClick={() => void show(kind)} className={small} title={t('exp.preview')} aria-label={`${label}: ${t('exp.preview')}`}>
        <Eye className="size-4" aria-hidden="true" />
      </button>
      <button type="button" disabled={busy} onClick={() => void download(kind)} className={small} title={t('exp.download')} aria-label={`${label}: ${t('exp.download')}`}>
        <Download className="size-4" aria-hidden="true" />
      </button>
    </div>
  )

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('exp.menu')}
        aria-label={t('exp.menu')}
        className="btn-console !min-h-8 px-3 inline-flex items-center gap-1.5 cursor-pointer"
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
        {t('exp.menu')}
      </button>

      {open && (
        <div role="menu" className="panel absolute bottom-full left-0 mb-2 w-72 z-30 py-1 shadow-xl shadow-black/30">
          <button type="button" role="menuitem" className={item} onClick={() => { onTxt(); setOpen(false) }}>TXT</button>
          <button type="button" role="menuitem" className={item} disabled={!hasSegments} onClick={() => { onSrt(); setOpen(false) }}>SRT</button>
          <button type="button" role="menuitem" className={item} disabled={!hasSegments} onClick={() => { onVtt(); setOpen(false) }}>VTT</button>
          <div className="my-1 border-t border-[hsl(var(--border))]" />
          {docRow('md', 'Markdown', t('exp.mdHint'))}
          {docRow('html', 'HTML', t('exp.htmlHint'))}
          <label
            className={`flex items-center gap-2 px-3 py-2 text-xs ${shotsCount > 0 ? 'cursor-pointer text-foreground' : 'text-muted-foreground/60'}`}
          >
            <input type="checkbox" disabled={shotsCount === 0} checked={shotsCount > 0 && withShots} onChange={(e) => setWithShots(e.target.checked)} />
            {shotsCount > 0 ? t('exp.withShots', { n: shotsCount }) : t('exp.noShots')}
          </label>
        </div>
      )}

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('exp.preview')}
          onClick={(e) => e.target === e.currentTarget && setPreview(null)}
        >
          <div className="panel w-full max-w-4xl h-[88dvh] flex flex-col">
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[hsl(var(--border))]">
              <h2 className="chrome-label mr-auto">
                {t('exp.preview')} · {baseName}.{preview.kind}
              </h2>
              {preview.kind === 'md' && (
                <button type="button" onClick={() => setPreview({ ...preview, source: !preview.source })} aria-pressed={preview.source} className="btn-console !min-h-8 px-2.5 cursor-pointer">
                  {preview.source ? t('exp.rendered') : t('exp.source')}
                </button>
              )}
              <button
                type="button"
                onClick={() => downloadFile(`${baseName}.${preview.kind}`, preview.content, MIME[preview.kind])}
                className="btn-console !min-h-8 px-3 cursor-pointer"
                style={{ color: 'hsl(var(--primary))' }}
              >
                <Download className="size-4" aria-hidden="true" /> {t('exp.download')}
              </button>
              <button type="button" onClick={() => setPreview(null)} aria-label={t('common.close')} className="size-8 inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer">
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            {preview.kind === 'md' && preview.source ? (
              <pre className="flex-1 min-h-0 overflow-auto p-4 text-xs font-mono whitespace-pre-wrap break-words">
                {shortenDataUrls(preview.content)}
              </pre>
            ) : (
              <iframe
                title={t('exp.preview')}
                sandbox=""
                srcDoc={preview.kind === 'html' ? preview.content : mdToHtml(preview.content)}
                className="flex-1 min-h-0 w-full bg-white rounded-b-lg"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
