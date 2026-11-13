import { useEffect, useState } from 'react'
import { FileAudio, HardDrive, Trash2 } from 'lucide-react'
import { formatBytes, formatDurationShort } from '@/lib/audio'
import { listAudio, type StoredAudioMeta } from '@/lib/audioStore'
import { StorageModal } from '@/sections/StorageModal'
import type { HistoryItem } from '@/types'
import { getLanguage, useT } from '@/i18n'

interface HistoryPanelProps {
  items: HistoryItem[]
  onOpen: (item: HistoryItem) => void
  onRemove: (id: string) => void
  /** окно экспорта/импорта проектов */
  onProjects?: () => void
}

export function HistoryPanel({ items, onOpen, onRemove, onProjects }: HistoryPanelProps) {
  const t = useT()
  return (
    <section className="panel p-4 flex flex-col gap-3" aria-label={t('hist.title')}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="chrome-label">{t('hist.title')}</h2>
        {onProjects && (
          <button
            type="button"
            onClick={onProjects}
            className="btn-console !min-h-8 px-2.5 text-xs cursor-pointer"
          >
            {t('prj.open')}
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground border border-dashed border-[hsl(var(--border))] rounded px-3 py-4 text-center">
          {t('hist.empty')}
        </p>
      ) : (
        <ol className="flex flex-col max-h-72 overflow-y-auto pr-1">
          {items.map((it) => (
            <li
              key={it.id}
              className="group flex items-start gap-2 py-2 border-t first:border-t-0 border-[hsl(var(--border))]"
            >
              <button
                type="button"
                onClick={() => onOpen(it)}
                className="flex-1 text-left min-w-0 cursor-pointer"
              >
                <div className="text-[13px] text-foreground/90 truncate group-hover:text-[hsl(var(--primary))] transition-colors flex items-center gap-1.5">
                  {it.hasAudio && (
                    <FileAudio
                      className="size-3 shrink-0"
                      style={{ color: 'hsl(var(--primary))' }}
                      aria-hidden="true"
                    />
                  )}
                  {it.text.slice(0, 90) || it.sourceName}
                </div>
                <div className="chrome-label !text-[10px] mt-1 truncate">
                  {new Date(it.createdAt).toLocaleString(getLanguage(), {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {' · '}
                  {it.modelLabel || t('hist.uploaded')}
                  {it.durationSec > 0 && <> · {formatDurationShort(it.durationSec)}</>}
                </div>
              </button>
              <button
                type="button"
                onClick={() => onRemove(it.id)}
                aria-label={t('hist.remove')}
                className="size-9 shrink-0 inline-flex items-center justify-center text-muted-foreground/60 hover:text-[hsl(var(--err))] cursor-pointer"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** Сводка по локальному хранилищу; подробности и удаление — в большом окне (StorageModal).
 *  Управление моделями — в окне настроек (SettingsModal). */
export function StoragePanel({
  onHistory,
  onRemoveProject,
}: {
  onHistory?: (list: HistoryItem[]) => void
  onRemoveProject?: (id: string) => void
}) {
  const [files, setFiles] = useState<StoredAudioMeta[]>([])
  const [open, setOpen] = useState(false)
  const t = useT()

  useEffect(() => {
    void listAudio().then(setFiles)
  }, [open])

  const fileBytes = files.reduce((a, f) => a + f.size + (f.wavSize ?? 0), 0)

  return (
    <section className="panel p-4 flex flex-col gap-3" aria-label={t('stor.aria')}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="chrome-label flex items-center gap-2">
          <HardDrive className="size-3.5" style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />
          {t('stor.files')} · {files.length} · {formatBytes(fileBytes)}
        </h2>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn-console !min-h-8 px-2 text-muted-foreground hover:text-foreground"
        >
          {t('stor.manage')}
        </button>
      </div>
      {open && (
        <StorageModal
          onClose={() => setOpen(false)}
          onHistory={(l) => onHistory?.(l)}
          onRemoveProject={(id) => onRemoveProject?.(id)}
        />
      )}
    </section>
  )
}
