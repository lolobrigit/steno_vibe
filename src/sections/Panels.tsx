import { useEffect, useState } from 'react'
import { FileAudio, HardDrive, Trash2 } from 'lucide-react'
import { formatBytes, formatDurationShort } from '@/lib/audio'
import {
  clearAudioStore,
  deleteAudio,
  listAudio,
  type StoredAudioMeta,
} from '@/lib/audioStore'
import type { HistoryItem } from '@/types'

interface HistoryPanelProps {
  items: HistoryItem[]
  onOpen: (item: HistoryItem) => void
  onRemove: (id: string) => void
}

export function HistoryPanel({ items, onOpen, onRemove }: HistoryPanelProps) {
  return (
    <section className="panel p-4 flex flex-col gap-3" aria-label="История">
      <h2 className="chrome-label">История · в этом браузере</h2>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground border border-dashed border-[hsl(var(--border))] rounded px-3 py-4 text-center">
          Здесь появятся загруженные файлы и транскрипции (хранятся локально)
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
                  {new Date(it.createdAt).toLocaleString('ru-RU', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {' · '}
                  {it.modelLabel}
                  {it.durationSec > 0 && <> · {formatDurationShort(it.durationSec)}</>}
                </div>
              </button>
              <button
                type="button"
                onClick={() => onRemove(it.id)}
                aria-label="Удалить запись"
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

/** Панель управления сохранёнными аудиофайлами (IndexedDB).
 *  Управление моделями — в отдельном окне настроек (SettingsModal). */
export function StoragePanel() {
  const [files, setFiles] = useState<StoredAudioMeta[]>([])
  const [open, setOpen] = useState(false)

  const refresh = async () => {
    setFiles(await listAudio())
  }

  useEffect(() => {
    // счётчик в заголовке — сразу, детали — при раскрытии
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (open) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const fileBytes = files.reduce((a, f) => a + f.size, 0)

  return (
    <section className="panel p-4 flex flex-col gap-3" aria-label="Локальное хранилище">
      <div className="flex items-center justify-between gap-2">
        <h2 className="chrome-label flex items-center gap-2">
          <HardDrive className="size-3.5" style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />
          Файлы · {formatBytes(fileBytes)}
        </h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="btn-console !min-h-8 px-2 text-muted-foreground hover:text-foreground"
        >
          {open ? 'скрыть' : 'управление'}
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="chrome-label !text-[10px]">
                Аудиофайлы · {files.length} · {formatBytes(fileBytes)}
              </span>
              {files.length > 0 && (
                <button
                  type="button"
                  onClick={() => void clearAudioStore().then(refresh)}
                  className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground hover:text-[hsl(var(--err))] cursor-pointer min-h-6"
                >
                  удалить все
                </button>
              )}
            </div>
            {files.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">Нет сохранённых файлов.</p>
            ) : (
              <ol className="flex flex-col max-h-36 overflow-y-auto pr-1">
                {[...files]
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .map((f) => (
                    <li
                      key={f.id}
                      className="flex items-center gap-2 py-1 border-t first:border-t-0 border-[hsl(var(--border))]"
                    >
                      <span className="font-mono text-[11px] text-foreground/80 truncate flex-1" title={f.name}>
                        {f.name}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                        {formatBytes(f.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void deleteAudio(f.id).then(refresh)}
                        aria-label={`Удалить ${f.name}`}
                        className="size-8 shrink-0 inline-flex items-center justify-center text-muted-foreground/60 hover:text-[hsl(var(--err))] cursor-pointer"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
              </ol>
            )}
            <p className="text-[11px] text-muted-foreground/80 leading-snug">
              Модели — в окне настроек (иконка шестерёнки в шапке).
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
