import { useEffect, useRef, type ReactNode } from 'react'
import { Cpu, FileAudio, FolderArchive, HardDrive, History, Plus } from 'lucide-react'
import { useT } from '@/i18n'

export type Flyout = 'source' | 'engine' | 'history' | 'storage'

interface RailProps {
  open: Flyout | null
  onOpen: (f: Flyout | null) => void
  onNew: () => void
  onProjects: () => void
  /** содержимое выезжающей панели выбранного раздела */
  flyout: ReactNode
  busy?: boolean
}

/**
 * Узкая колонка с ярлыками: на время работы с расшифровкой левая панель
 * сворачивается сюда, а всё место отдаётся плееру, тексту и LLM.
 */
export function Rail({ open, onOpen, onNew, onProjects, flyout, busy }: RailProps) {
  const t = useT()
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onOpen(null)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onOpen(null)
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open, onOpen])

  const item = (id: Flyout, label: string, icon: ReactNode) => (
    <button
      key={id}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={open === id}
      onClick={() => onOpen(open === id ? null : id)}
      className={`size-10 shrink-0 inline-flex items-center justify-center rounded-xl cursor-pointer transition-colors ${
        open === id
          ? 'bg-[hsl(var(--primary)/0.16)] text-[hsl(var(--primary))]'
          : 'text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--row-hover,var(--border)))]'
      }`}
    >
      {icon}
    </button>
  )

  return (
    <div ref={root} className="relative flex flex-col z-20">
      <nav
        aria-label={t('rail.aria')}
        className="panel flex lg:flex-col items-center gap-1 p-1.5 overflow-x-auto"
      >
        <button
          type="button"
          title={t('rail.new')}
          aria-label={t('rail.new')}
          disabled={busy}
          onClick={onNew}
          className="size-10 shrink-0 inline-flex items-center justify-center rounded-xl cursor-pointer bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:brightness-110 disabled:opacity-40"
        >
          <Plus className="size-5" aria-hidden="true" />
        </button>
        {item('source', t('rail.source'), <FileAudio className="size-[18px]" aria-hidden="true" />)}
        {item('engine', t('rail.engine'), <Cpu className="size-[18px]" aria-hidden="true" />)}
        {item('history', t('rail.history'), <History className="size-[18px]" aria-hidden="true" />)}
        <button
          type="button"
          title={t('rail.projects')}
          aria-label={t('rail.projects')}
          onClick={onProjects}
          className="size-10 shrink-0 inline-flex items-center justify-center rounded-xl cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <FolderArchive className="size-[18px]" aria-hidden="true" />
        </button>
        {item('storage', t('rail.storage'), <HardDrive className="size-[18px]" aria-hidden="true" />)}
      </nav>
      {open && (
        <div className="mt-2 lg:mt-0 lg:absolute lg:left-full lg:ml-2 lg:top-0 lg:w-[340px] max-h-[75dvh] overflow-y-auto">
          {flyout}
        </div>
      )}
    </div>
  )
}
