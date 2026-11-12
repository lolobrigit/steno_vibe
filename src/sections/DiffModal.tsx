import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { diffWords } from '@/lib/transcript'
import type { TranscriptVersion } from '@/types'
import { useT } from '@/i18n'

interface Props {
  versions: TranscriptVersion[]
  /** активная — выбирается «справа», её родитель (если есть) или предыдущая — «слева» */
  activeId: string | null
  onClose: () => void
}

/** Сравнение двух версий расшифровки: добавленное и удалённое подсвечены. */
export function DiffModal({ versions, activeId, onClose }: Props) {
  const t = useT()
  const activeIdx = Math.max(0, versions.findIndex((v) => v.id === activeId))
  const parentIdx = versions.findIndex((v) => v.id === versions[activeIdx]?.parentId)
  const [left, setLeft] = useState(parentIdx >= 0 ? parentIdx : Math.max(0, activeIdx - 1))
  const [right, setRight] = useState(activeIdx)

  const ops = useMemo(
    () => diffWords(versions[left]?.text ?? '', versions[right]?.text ?? ''),
    [versions, left, right],
  )
  const changed = ops.filter((o) => o.kind !== 'same').length

  const label = (v: TranscriptVersion, i: number) =>
    `${i + 1}. ${t(`ver.kind.${v.kind}`)} · ${v.label}`
  const sel =
    'rounded border border-[hsl(var(--border))] bg-background px-1.5 py-1 text-xs text-foreground min-w-0 max-w-full'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('diff.title')}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="panel w-full max-w-3xl max-h-[88dvh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))]">
          <h2 className="chrome-label">{t('diff.title')}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="size-8 inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <select value={left} onChange={(e) => setLeft(Number(e.target.value))} className={sel} aria-label={t('diff.from')}>
            {versions.map((v, i) => (
              <option key={v.id} value={i}>{label(v, i)}</option>
            ))}
          </select>
          <span className="text-muted-foreground">→</span>
          <select value={right} onChange={(e) => setRight(Number(e.target.value))} className={sel} aria-label={t('diff.to')}>
            {versions.map((v, i) => (
              <option key={v.id} value={i}>{label(v, i)}</option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground ml-auto">{t('diff.changes', { n: changed })}</span>
        </div>
        <p className="px-4 pb-4 overflow-y-auto text-[15px] leading-relaxed whitespace-pre-wrap">
          {changed === 0 && <span className="text-muted-foreground">{t('diff.same')}</span>}
          {ops.map((o, i) =>
            o.kind === 'same' ? (
              <span key={i}>{o.text} </span>
            ) : o.kind === 'add' ? (
              <ins key={i} className="bg-[hsl(var(--ok)/0.2)] text-foreground no-underline rounded px-0.5">{o.text} </ins>
            ) : (
              <del key={i} className="bg-[hsl(var(--err)/0.18)] text-foreground/70 rounded px-0.5">{o.text} </del>
            ),
          )}
        </p>
      </div>
    </div>
  )
}
