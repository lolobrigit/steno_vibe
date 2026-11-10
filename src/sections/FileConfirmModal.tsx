import { FileAudio, Loader2, X } from 'lucide-react'
import { formatBytes } from '@/lib/audio'
import { useT } from '@/i18n'

export interface PendingFile {
  file: File
  /** превью имени/размера уже известны */
}

interface FileConfirmModalProps {
  file: File | null
  /** идёт загрузка/декодирование выбранного файла */
  loading: boolean
  loadingText?: string
  onConfirm: () => void
  onCancel: () => void
}

/** Подтверждение загрузки файла: имя, размер, кнопки. */
export function FileConfirmModal({
  file,
  loading,
  loadingText,
  onConfirm,
  onCancel,
}: FileConfirmModalProps) {
  const t = useT()
  if (!file) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('file.confirmTitle')}
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel()
      }}
    >
      <div className="panel w-full max-w-md shadow-xl shadow-black/40">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))]">
          <h2 className="chrome-label">{t('file.confirmTitle')}</h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            aria-label={t('common.cancel')}
            className="size-9 inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-40"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4">
          <div className="panel-inset px-3 py-3 flex items-center gap-3 min-w-0">
            <FileAudio
              className="size-6 shrink-0"
              style={{ color: 'hsl(var(--primary))' }}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="font-mono text-[13px] text-foreground/90 truncate">{file.name}</div>
              <div className="chrome-label !text-[10px] mt-0.5">{formatBytes(file.size)}</div>
            </div>
          </div>

          {loading ? (
            <div
              className="flex items-center gap-2.5 font-mono text-[12px]"
              style={{ color: 'hsl(var(--primary))' }}
              role="status"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {loadingText ?? t('file.preparing')}
            </div>
          ) : (
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={onCancel}
                className="btn-console px-4 border panel-inset text-muted-foreground hover:text-foreground"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="btn-console px-5 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] font-semibold hover:brightness-110"
              >
                {t('file.load')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
