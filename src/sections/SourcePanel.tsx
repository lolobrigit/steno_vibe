import { useCallback, useRef, useState } from 'react'
import { Check, Clock, FileAudio, FolderOpen, FolderX, Loader2, Mic, MonitorSpeaker, Square, X, AlertTriangle, BellOff, Bell } from 'lucide-react'
import { formatBytes, formatDurationShort } from '@/lib/audio'
import type { QueueItem } from '@/types'
import type { RecordSource } from '@/hooks/useRecorder'

interface SourcePanelProps {
  fileName: string | null
  fileSize: number | null
  durationSec: number | null
  decodeError: string | null
  /** файл выбран и сейчас загружается/декодируется */
  fileLoading: boolean
  recording: boolean
  recSource: RecordSource | null
  recElapsed: number
  recError: string | null
  micMixed: boolean
  busy: boolean
  silenceStop: boolean
  folder: {
    supported: boolean
    folderName: string | null
    watching: boolean
    error: string | null
  }
  queue: QueueItem[]
  onFile: (file: File) => void
  onStartRec: (source: RecordSource) => void
  onStopRec: () => void
  onClear: () => void
  onToggleSilence: () => void
  onPickFolder: () => void
  onStopFolder: () => void
  onClearQueueFinished: () => void
}

const ACCEPT = '.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm,.mp4,audio/*,video/mp4'

const QUEUE_ICON: Record<QueueItem['status'], React.ReactNode> = {
  pending: <Clock className="size-3.5 text-muted-foreground" aria-hidden="true" />,
  processing: <Loader2 className="size-3.5 animate-spin text-[hsl(var(--primary))]" aria-hidden="true" />,
  done: <Check className="size-3.5 text-[hsl(var(--ok))]" aria-hidden="true" />,
  error: <AlertTriangle className="size-3.5 text-[hsl(var(--err))]" aria-hidden="true" />,
}

export function SourcePanel(p: SourcePanelProps) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const f = e.dataTransfer.files?.[0]
      if (f) p.onFile(f)
    },
    [p],
  )

  const recBtn = p.recording ? (
    <button
      type="button"
      onClick={p.onStopRec}
      className="btn-console w-full border bg-[hsl(var(--err)/0.14)] border-[hsl(var(--err)/0.6)] text-[hsl(var(--err))] hover:bg-[hsl(var(--err)/0.22)]"
    >
      <Square className="size-4" aria-hidden="true" />
      Стоп · {formatDurationShort(p.recElapsed)}
    </button>
  ) : (
    <div className="grid grid-cols-1 gap-2">
      <button
        type="button"
        onClick={() => p.onStartRec('mic')}
        disabled={p.busy}
        className="btn-console w-full border bg-[hsl(var(--primary)/0.1)] border-[hsl(var(--primary)/0.5)] text-[hsl(var(--accent-foreground))] hover:bg-[hsl(var(--primary)/0.18)] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Mic className="size-4" aria-hidden="true" />
        Микрофон
      </button>
      <button
        type="button"
        onClick={() => p.onStartRec('tab')}
        disabled={p.busy}
        className="btn-console w-full border panel-inset text-muted-foreground hover:text-foreground hover:border-[hsl(var(--primary)/0.5)] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <MonitorSpeaker className="size-4" aria-hidden="true" />
        Звук вкладки (встреча)
      </button>
    </div>
  )

  return (
    <section className="panel p-4 flex flex-col gap-4" aria-label="Источник аудио">
      <div className="flex items-center justify-between">
        <h2 className="chrome-label">01 · Источник</h2>
        {p.fileName && (
          <button
            type="button"
            onClick={p.onClear}
            className="btn-console !min-h-8 px-2 text-muted-foreground hover:text-foreground"
            aria-label="Убрать файл"
          >
            <X className="size-3.5" />
            сброс
          </button>
        )}
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-label="Загрузить аудиофайл"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`panel-inset border-dashed !border-[1.5px] px-4 py-5 text-center cursor-pointer transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] ${
          dragOver ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.06)]' : ''
        } ${p.fileLoading ? 'pointer-events-none' : ''}`}
      >
        {p.fileLoading ? (
          <>
            <Loader2
              className="size-6 mx-auto mb-2 animate-spin"
              style={{ color: 'hsl(var(--primary))' }}
              aria-hidden="true"
            />
            <p className="text-sm" style={{ color: 'hsl(var(--primary))' }}>
              Загружаем файл…
            </p>
            <p className="text-xs text-muted-foreground mt-1">декодирование и подготовка аудио</p>
          </>
        ) : (
          <>
            <FileAudio
              className="size-6 mx-auto mb-2"
              style={{ color: 'hsl(var(--primary))' }}
              aria-hidden="true"
            />
            <p className="text-sm text-foreground/90">Перетащите аудио сюда</p>
            <p className="text-xs text-muted-foreground mt-1">
              или нажмите, чтобы выбрать · mp3, wav, m4a, ogg, opus, flac
            </p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) p.onFile(f)
            e.target.value = ''
          }}
        />
      </div>

      {recBtn}
      {p.recording && p.recSource === 'tab' && (
        <p className="text-[11px] font-mono text-muted-foreground -mt-2">
          {p.micMixed ? 'вкладка + ваш микрофон' : 'только звук вкладки'}
        </p>
      )}
      {p.recError && <p className="text-xs text-[hsl(var(--err))]">{p.recError}</p>}

      <button
        type="button"
        onClick={p.onToggleSilence}
        aria-pressed={p.silenceStop}
        className={`btn-console !min-h-9 px-3 border justify-start ${
          p.silenceStop
            ? 'border-[hsl(var(--primary)/0.4)] text-[hsl(var(--accent-foreground))]'
            : 'panel-inset text-muted-foreground hover:text-foreground'
        }`}
      >
        {p.silenceStop ? (
          <Bell className="size-3.5" aria-hidden="true" />
        ) : (
          <BellOff className="size-3.5" aria-hidden="true" />
        )}
        Автостоп по тишине · 10 с
      </button>

      <div className="border-t border-[hsl(var(--border))] pt-3 flex flex-col gap-2">
        {p.folder.supported ? (
          p.folder.watching ? (
            <div className="flex items-center gap-2">
              <span className="led led-pulse shrink-0 text-[hsl(var(--ok))] bg-[hsl(var(--ok))]" />
              <span className="font-mono text-xs text-foreground/90 truncate flex-1" title={p.folder.folderName ?? ''}>
                {p.folder.folderName}
              </span>
              <button
                type="button"
                onClick={p.onStopFolder}
                className="btn-console !min-h-8 px-2 text-muted-foreground hover:text-foreground"
              >
                <FolderX className="size-3.5" aria-hidden="true" />
                стоп
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={p.onPickFolder}
              disabled={p.busy}
              className="btn-console !min-h-10 px-3 border panel-inset text-muted-foreground hover:text-foreground hover:border-[hsl(var(--primary)/0.5)] justify-start disabled:opacity-40"
            >
              <FolderOpen className="size-4" aria-hidden="true" />
              Следить за папкой
            </button>
          )
        ) : (
          <p className="text-[11px] font-mono text-muted-foreground/80">
            Слежение за папкой — только Chrome/Edge
          </p>
        )}
        {p.folder.watching && (
          <p className="text-[11px] text-muted-foreground leading-snug">
            Новые аудио из папки автоматически уходят в очередь. Работает, пока открыта вкладка.
          </p>
        )}
        {p.folder.error && <p className="text-xs text-[hsl(var(--err))]">{p.folder.error}</p>}

        {p.queue.length > 0 && (
          <div className="flex flex-col gap-1 pt-1">
            <div className="flex items-center justify-between">
              <span className="chrome-label !text-[10px]">Очередь · {p.queue.length}</span>
              <button
                type="button"
                onClick={p.onClearQueueFinished}
                className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground cursor-pointer min-h-6"
              >
                убрать готовые
              </button>
            </div>
            <ol className="flex flex-col max-h-36 overflow-y-auto">
              {p.queue.map((q) => (
                <li
                  key={q.id}
                  className="flex items-center gap-2 py-1 border-t first:border-t-0 border-[hsl(var(--border))]"
                  title={q.error ?? q.name}
                >
                  {QUEUE_ICON[q.status]}
                  <span className="font-mono text-[11px] text-foreground/80 truncate flex-1">
                    {q.name}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {p.fileName && (
        <div className="panel-inset px-3 py-2.5 text-sm">
          <div className="font-mono text-[13px] truncate text-foreground/90">{p.fileName}</div>
          <div className="chrome-label !text-[10px] mt-1 flex gap-3">
            {p.fileSize !== null && <span>{formatBytes(p.fileSize)}</span>}
            {p.durationSec !== null && <span>{formatDurationShort(p.durationSec)}</span>}
            {p.decodeError && <span className="text-[hsl(var(--warn))]">{p.decodeError}</span>}
          </div>
        </div>
      )}
    </section>
  )
}
