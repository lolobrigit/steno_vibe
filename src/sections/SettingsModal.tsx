import { useCallback, useEffect, useState } from 'react'
import {
  BookMarked,
  Check,
  Download,
  Link2,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { LOCAL_MODELS } from '@/lib/models'
import { formatBytes } from '@/lib/audio'
import { hasWebGPU, loadLocalModel } from '@/lib/localEngine'
import { preloadDiarizeModels } from '@/lib/diarize'
import { preloadLocalAi } from '@/lib/localAi'
import { cacheSizeFor, deleteCacheEntriesMatching, storageQuota } from '@/lib/storageManager'
import { downloadRepo, parseRepoUrl, verifyAndRepairRepo } from '@/lib/modelIntegrity'
import {
  LLM_MODELS,
  loadLlmButtons,
  saveLlmButtons,
  type AppSettings,
  type Glossary,
  type LlmButton,
} from '@/lib/storage'
import { AI_ACTIONS } from '@/lib/models'
import type { TaskApi } from '@/lib/tasks'

interface DownloadableModel {
  id: string
  label: string
  sizeHint: string
  /** подстроки URL в кэше, по которым определяем «скачано» и удаляем */
  markers: string[]
  /** HF-репозитории для проверки целостности по хэшам */
  repos: string[]
  load: (cb: {
    status: (t: string) => void
    progress: (f: string, p: number) => void
    /** агрегат скачивания всех файлов по байтам (если движок его шлёт) */
    total?: (pct: number) => void
  }) => Promise<void>
}

const DIARIZE_MODEL_ID = 'diarize-pack'

type ModelState =
  | { status: 'unknown' }
  | { status: 'absent' }
  | { status: 'present'; bytes: number }
  | { status: 'queued' }
  | { status: 'downloading'; pct: number; file: string }
  | { status: 'error'; message: string }

type TabId = 'downloads' | 'llm-buttons' | 'glossaries'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  settings: AppSettings
  glossaries: Glossary[]
  onSettings: (s: AppSettings) => void
  onGlossaries: (g: Glossary[]) => void
  /** общий список задач: скачивания из настроек видны и в основном окне */
  taskApi?: TaskApi
}

const inputCls =
  'panel-inset px-2.5 py-1.5 text-xs bg-transparent text-foreground focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] w-full'

export function SettingsModal({
  open,
  onClose,
  settings,
  glossaries,
  onSettings,
  onGlossaries,
  taskApi,
}: SettingsModalProps) {
  const models: DownloadableModel[] = [
    ...LOCAL_MODELS.map((m) => ({
      id: m.id,
      label: `${m.label} · распознавание`,
      sizeHint: m.size,
      markers: [m.hfId.split('/')[1]],
      repos: [m.hfId],
      load: (cb: Parameters<DownloadableModel['load']>[0]) =>
        loadLocalModel(m.hfId, {
          onStatus: cb.status,
          onLoadProgress: (p) => cb.progress(p.file, p.progress),
          onLoadTotal: cb.total,
        }),
    })),
    {
      id: DIARIZE_MODEL_ID,
      label: 'Диаризация · pyannote + WeSpeaker',
      sizeHint: '~45 МБ',
      markers: ['pyannote', 'wespeaker', 'voxceleb'],
      repos: ['onnx-community/pyannote-segmentation-3.0', 'Wespeaker/wespeaker-voxceleb-resnet34-LM'],
      load: (cb) =>
        preloadDiarizeModels({
          onStatus: cb.status,
          onLoadProgress: cb.progress,
          onLoadTotal: cb.total,
        }),
    },
    ...LLM_MODELS.map((m) => ({
      id: `ai-${m.id}`,
      label: `Локальный AI · ${m.label}`,
      sizeHint: m.size,
      markers: [m.id.split('/')[1].toLowerCase()],
      repos: [m.id],
      load: (cb: Parameters<DownloadableModel['load']>[0]) =>
        preloadLocalAi(hasWebGPU(), m.id, {
          onStatus: cb.status,
          onLoadProgress: cb.progress,
          onLoadTotal: cb.total,
        }),
    })),
  ]

  const [tab, setTab] = useState<TabId>('downloads')
  const [states, setStates] = useState<Record<string, ModelState>>({})
  /** прогресс проверки целостности по id модели */
  const [verifying, setVerifying] = useState<Record<string, { file: string; done: number; total: number }>>({})
  /** итог последней проверки по id модели */
  const [verifyNotes, setVerifyNotes] = useState<Record<string, { ok: boolean; text: string }>>({})
  /** занято/лимит хранилища браузера (для предупреждений перед большими закачками) */
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null)
  /** модель, ожидающая подтверждения скачивания (null — окно закрыто) */
  const [confirming, setConfirming] = useState<DownloadableModel | null>(null)
  /** места не хватит — подтверждение становится предупреждением */
  const [confirmTight, setConfirmTight] = useState(false)
  /** очередь скачиваний: id моделей, ждущих своей очереди */
  const [queue, setQueue] = useState<string[]>([])

  // --- загрузка по ссылке ---
  const [urlInput, setUrlInput] = useState('')
  const [urlState, setUrlState] = useState<
    | { kind: 'idle' }
    | { kind: 'busy'; file: string; pct: number }
    | { kind: 'ok'; text: string }
    | { kind: 'error'; text: string }
  >({ kind: 'idle' })

  // --- LLM-кнопки ---
  const [buttons, setButtons] = useState<LlmButton[]>(
    () => loadLlmButtons() ?? AI_ACTIONS.map((a) => ({ id: a.id, label: a.label, prompt: a.prompt })),
  )

  const persistButtons = (list: LlmButton[]) => {
    setButtons(list)
    saveLlmButtons(list)
  }

  /**
   * Проверка целостности по хэшам HF: битые файлы докачиваются заново,
   * целые и отсутствующие не трогаем (отсутствующие докачает обычная загрузка).
   * Возвращает true, если всё в порядке (или всё починили).
   */
  const verifyModel = useCallback(
    async (m: DownloadableModel): Promise<boolean> => {
      setVerifyNotes((n) => {
        const next = { ...n }
        delete next[m.id]
        return next
      })
      let totalChecked = 0
      let totalFixed = 0
      const failed: string[] = []
      try {
        for (const repo of m.repos) {
          const r = await verifyAndRepairRepo(repo, (file, done, total) =>
            setVerifying((v) => ({ ...v, [m.id]: { file, done, total } })),
          )
          totalChecked += r.checked
          totalFixed += r.fixed
          failed.push(...r.failed)
        }
        if (failed.length > 0) {
          setVerifyNotes((n) => ({
            ...n,
            [m.id]: { ok: false, text: `Не удалось докачать: ${failed.join(', ')}` },
          }))
          return false
        }
        if (totalChecked === 0) {
          setVerifyNotes((n) => ({
            ...n,
            [m.id]: { ok: true, text: 'Файлов в кэше нет — качать нечего' },
          }))
          return true
        }
        setVerifyNotes((n) => ({
          ...n,
          [m.id]: {
            ok: true,
            text:
              totalFixed > 0
                ? `Проверено ${totalChecked} · исправлено ${totalFixed}`
                : `Проверено ${totalChecked} · целостность OK`,
          },
        }))
        return true
      } catch (e) {
        setVerifyNotes((n) => ({
          ...n,
          [m.id]: {
            ok: false,
            text: `Проверка не удалась: ${e instanceof Error ? e.message : String(e)}`,
          },
        }))
        return false
      } finally {
        setVerifying((v) => {
          const next = { ...v }
          delete next[m.id]
          return next
        })
      }
    },
    [],
  )

  const refresh = useCallback(async () => {
    const next: Record<string, ModelState> = {}
    for (const m of models) {
      let bytes = 0
      for (const marker of m.markers) bytes += await cacheSizeFor(marker)
      next[m.id] = bytes > 1024 ? { status: 'present', bytes } : { status: 'absent' }
    }
    setStates((prev) => {
      // не затираем идущие загрузки и очередь
      for (const k of Object.keys(next)) {
        if (prev[k]?.status === 'downloading' || prev[k]?.status === 'queued') next[k] = prev[k]
      }
      return next
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    void storageQuota().then((q) => setQuota(q && q.reliable ? q : null))
  }, [open])

  /** Оценка размера модели в байтах из подсказки вида «~1.1 ГБ» / «~400 МБ». */
  const sizeHintBytes = (hint: string): number => {
    const m = hint.match(/([\d.,]+)\s*(ГБ|GB|МБ|MB)/i)
    if (!m) return 0
    const n = parseFloat(m[1].replace(',', '.'))
    return /ГБ|GB/i.test(m[2]) ? n * 1024 ** 3 : n * 1024 ** 2
  }

  /**
   * Клик «Скачать» не начинает закачку сразу: сначала окно подтверждения
   * (размер, свободное место). Если места не хватает — предупреждение в том же окне.
   */
  const requestDownload = async (m: DownloadableModel) => {
    const need = sizeHintBytes(m.sizeHint)
    let tight = false
    if (need > 300 * 1024 ** 2) {
      const q = await storageQuota()
      if (q && q.reliable) tight = need > (q.quota - q.usage) * 0.9
    }
    setConfirmTight(tight)
    setConfirming(m)
  }

  /**
   * Подтверждённое скачивание. Параллельные закачки не запускаем:
   * каждая держит файл в памяти вкладки, и 2×2 ГБ одновременно — верный
   * способ уронить страницу. Вместо этого — очередь: следующая модель
   * стартует, когда завершилась предыдущая.
   */
  const confirmDownload = () => {
    const m = confirming
    setConfirming(null)
    if (!m) return
    const anyActive =
      Object.values(states).some((s) => s.status === 'downloading') || queue.length > 0
    if (anyActive) {
      setStates((s) => ({ ...s, [m.id]: { status: 'queued' } }))
      setQueue((q) => [...q, m.id])
      taskApi?.start(`dl-${m.id}`, `Скачивание · ${m.label}`, 'в очереди')
    } else {
      void download(m)
    }
  }

  /** После завершения закачки запускает следующую из очереди. */
  const pumpQueue = useCallback(() => {
    setQueue((q) => {
      const [nextId, ...rest] = q
      if (nextId) {
        const next = models.find((m) => m.id === nextId)
        if (next) void download(next)
      }
      return rest
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const download = async (m: DownloadableModel) => {
    const rowId = `dl-${m.id}`
    setStates((s) => ({ ...s, [m.id]: { status: 'downloading', pct: 0, file: '' } }))
    taskApi?.start(rowId, `Скачивание · ${m.label}`)
    // процент один на всю модель: агрегат по байтам (total), имя текущего
    // файла — только подпись под прогрессом
    let totalSeen = false
    const setPct = (pct: number) => {
      setStates((s) => {
        const cur = s[m.id]
        return cur?.status === 'downloading'
          ? { ...s, [m.id]: { status: 'downloading', pct, file: cur.file } }
          : s
      })
      taskApi?.update(rowId, { pct, detail: 'скачивание файлов' })
    }
    try {
      await m.load({
        status: () => {},
        total: (pct) => {
          totalSeen = true
          setPct(pct)
        },
        progress: (file, pct) => {
          setStates((s) => {
            const cur = s[m.id]
            return cur?.status === 'downloading'
              ? { ...s, [m.id]: { status: 'downloading', pct: cur.pct, file } }
              : s
          })
          taskApi?.update(rowId, { detail: file.split('/').pop() })
          // если агрегата нет (старый путь) — показываем процент текущего файла
          if (!totalSeen) setPct(pct)
        },
      })
      // после скачивания — контроль целостности: битые файлы докачаются,
      // целые не трогаем (экономит трафик на прерванных загрузках)
      taskApi?.update(rowId, { detail: 'проверка целостности' })
      const intact = await verifyModel(m)
      if (intact) taskApi?.done(rowId)
      else taskApi?.fail(rowId, 'не удалось докачать часть файлов')
      await refresh()
    } catch (e) {
      taskApi?.fail(rowId)
      setStates((s) => ({
        ...s,
        [m.id]: { status: 'error', message: e instanceof Error ? e.message : String(e) },
      }))
    } finally {
      // слот освободился — запускаем следующую модель из очереди
      pumpQueue()
    }
  }

  const remove = async (m: DownloadableModel) => {
    for (const marker of m.markers) await deleteCacheEntriesMatching(marker)
    await refresh()
  }

  const downloadByUrl = async () => {
    const repo = parseRepoUrl(urlInput)
    if (!repo) {
      setUrlState({ kind: 'error', text: 'Не похоже на ссылку Hugging Face — см. требования ниже.' })
      return
    }
    setUrlState({ kind: 'busy', file: '', pct: 0 })
    const rowId = `dl-url-${repo}`
    taskApi?.start(rowId, `Скачивание по ссылке · ${repo}`)
    try {
      const r = await downloadRepo(repo, (file, pct) => {
        setUrlState({ kind: 'busy', file, pct })
        taskApi?.update(rowId, { pct, detail: file })
      })
      if (r.failed.length > 0) {
        taskApi?.fail(rowId, `не скачалось: ${r.failed.length}`)
        setUrlState({
          kind: 'error',
          text: `Скачано ${r.downloaded}, пропущено ${r.skipped}, ошибки: ${r.failed.slice(0, 3).join(', ')}${r.failed.length > 3 ? '…' : ''}`,
        })
      } else {
        taskApi?.done(rowId)
        setUrlState({
          kind: 'ok',
          text: `Готово: скачано ${r.downloaded} файлов, уже были ${r.skipped}. Репозиторий: ${repo}`,
        })
      }
      await refresh()
    } catch (e) {
      taskApi?.fail(rowId)
      setUrlState({
        kind: 'error',
        text: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // --- редакторы справочников и кнопок ---
  const addGlossary = () =>
    onGlossaries([
      ...glossaries,
      { id: crypto.randomUUID(), name: `Справочник ${glossaries.length + 1}`, terms: [] },
    ])

  const patchGlossary = (id: string, patch: Partial<Glossary>) =>
    onGlossaries(glossaries.map((g) => (g.id === id ? { ...g, ...patch } : g)))

  const addButton = () =>
    persistButtons([
      ...buttons,
      {
        id: crypto.randomUUID(),
        label: `Кнопка ${buttons.length + 1}`,
        prompt: '',
        glossaryId: null,
      },
    ])

  const patchButton = (id: string, patch: Partial<LlmButton>) =>
    persistButtons(buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)))

  const resetButtons = () =>
    persistButtons(AI_ACTIONS.map((a) => ({ id: a.id, label: a.label, prompt: a.prompt })))

  if (!open) return null

  const tabBtn = (id: TabId, label: string, icon: React.ReactNode) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`btn-console !min-h-8 px-2.5 !text-[10px] border ${
        tab === id
          ? 'border-[hsl(var(--primary)/0.5)]'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
      style={tab === id ? { color: 'hsl(var(--primary))' } : undefined}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Настройки"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="panel w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl shadow-black/40">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))]">
          <h2 className="chrome-label">Настройки</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="size-9 inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div
          className="flex gap-1 px-4 pt-3 pb-2 border-b border-[hsl(var(--border))]"
          role="tablist"
          aria-label="Разделы настроек"
        >
          {tabBtn('downloads', 'Загрузки', <Download className="size-3.5" aria-hidden="true" />)}
          {tabBtn('llm-buttons', 'LLM-кнопки', <Sparkles className="size-3.5" aria-hidden="true" />)}
          {tabBtn('glossaries', 'Справочники', <BookMarked className="size-3.5" aria-hidden="true" />)}
        </div>

        <div className="overflow-y-auto p-4 flex flex-col gap-2">
          {tab === 'downloads' && (
            <>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Модели скачиваются с huggingface.co и хранятся в кэше браузера. Можно
                скачать заранее — тогда первая транскрипция начнётся без ожидания.
              </p>
              {quota && (
                <div className="panel-inset px-3 py-2 flex items-center gap-3">
                  <span className="font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                    Хранилище: {formatBytes(quota.usage)} / {formatBytes(quota.quota)}
                  </span>
                  <div className="flex-1 h-1 rounded-sm overflow-hidden" style={{ background: 'hsl(var(--track))' }}>
                    <div
                      className="h-full rounded-sm"
                      style={{
                        width: `${Math.min(100, (quota.usage / quota.quota) * 100)}%`,
                        background:
                          quota.usage / quota.quota > 0.85 ? 'hsl(var(--err))' : 'hsl(var(--primary))',
                      }}
                    />
                  </div>
                  {quota.usage / quota.quota > 0.85 && (
                    <span className="text-[10px]" style={{ color: 'hsl(var(--err))' }}>
                      место на исходе — удалите лишние модели
                    </span>
                  )}
                </div>
              )}
              {confirming && (
                <div
                  className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Подтверждение загрузки"
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setConfirming(null)
                  }}
                >
                  <div className="panel w-full max-w-md p-4 flex flex-col gap-3 shadow-xl shadow-black/50">
                    <h3 className="chrome-label">Скачать модель?</h3>
                    <p className="text-sm text-foreground/90 leading-relaxed">
                      «{confirming.label}» · {confirming.sizeHint}. Файлы сохранятся в кэше
                      браузера и будут доступны офлайн.
                    </p>
                    {quota && (
                      <p className="font-mono text-[11px] text-muted-foreground">
                        Свободно в хранилище: ~{formatBytes(Math.max(0, quota.quota - quota.usage))} из{' '}
                        {formatBytes(quota.quota)}
                      </p>
                    )}
                    {confirmTight && (
                      <p className="text-xs leading-snug" style={{ color: 'hsl(var(--warn))' }}>
                        Места может не хватить: если хранилище переполнится посреди загрузки,
                        вкладка рискует вылететь. Лучше сначала удалить ненужные модели.
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground/80 leading-snug">
                      Если уже идёт другая загрузка, модель встанет в очередь и скачается
                      следом — параллельно не качаем, чтобы не переполнить память вкладки.
                    </p>
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="btn-console !min-h-9 px-4 border border-[hsl(var(--border))] text-muted-foreground hover:text-foreground"
                      >
                        Отмена
                      </button>
                      <button
                        type="button"
                        onClick={confirmDownload}
                        className="btn-console !min-h-9 px-4 border bg-[hsl(var(--primary)/0.1)] border-[hsl(var(--primary)/0.5)] hover:bg-[hsl(var(--primary)/0.18)]"
                        style={{ color: 'hsl(var(--primary))' }}
                      >
                        <Download className="size-3.5" aria-hidden="true" />
                        {confirmTight ? 'Скачать всё равно' : 'Скачать'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {models.map((m) => {
                const st = states[m.id] ?? { status: 'unknown' }
                const downloading = st.status === 'downloading'
                const queued = st.status === 'queued'
                const ver = verifying[m.id]
                const note = verifyNotes[m.id]
                const rowBusy = downloading || queued || !!ver
                return (
                  <div key={m.id} className="panel-inset px-3 py-2.5 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-foreground/90 flex-1 min-w-0 truncate">
                        {m.label}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                        {st.status === 'present' ? formatBytes(st.bytes) : m.sizeHint}
                      </span>
                      {st.status === 'present' && (
                        <Check className="size-3.5 shrink-0" style={{ color: 'hsl(var(--ok))' }} aria-label="Скачано" />
                      )}
                      {downloading ? (
                        <span
                          className="btn-console !min-h-8 px-2.5 border border-[hsl(var(--primary)/0.4)] inline-flex"
                          style={{ color: 'hsl(var(--primary))' }}
                        >
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          {st.pct}%
                        </span>
                      ) : queued ? (
                        <span className="btn-console !min-h-8 px-2.5 border border-[hsl(var(--border))] inline-flex text-muted-foreground">
                          в очереди
                        </span>
                      ) : ver ? (
                        <span
                          className="btn-console !min-h-8 px-2.5 border border-[hsl(var(--primary)/0.4)] inline-flex"
                          style={{ color: 'hsl(var(--primary))' }}
                        >
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          проверка
                        </span>
                      ) : (
                        <>
                          {st.status === 'present' && (
                            <button
                              type="button"
                              onClick={() => void verifyModel(m)}
                              disabled={rowBusy}
                              title="Проверить целостность файлов по хэшам Hugging Face; битые докачаются заново"
                              className="btn-console !min-h-8 px-2.5 border border-[hsl(var(--border))] text-muted-foreground hover:text-foreground disabled:opacity-40"
                            >
                              <ShieldCheck className="size-3.5" aria-hidden="true" />
                              Проверить
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void requestDownload(m)}
                            disabled={rowBusy}
                            className="btn-console !min-h-8 px-2.5 border border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--primary)/0.1)] disabled:opacity-40"
                            style={{ color: 'hsl(var(--primary))' }}
                          >
                            <Download className="size-3.5" aria-hidden="true" />
                            {st.status === 'present' ? 'Обновить' : 'Скачать'}
                          </button>
                        </>
                      )}
                      {st.status === 'present' && !rowBusy && (
                        <button
                          type="button"
                          onClick={() => void remove(m)}
                          aria-label={`Удалить ${m.label}`}
                          className="size-8 shrink-0 inline-flex items-center justify-center text-muted-foreground/60 hover:text-[hsl(var(--err))] cursor-pointer"
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    {downloading && st.file && (
                      <span className="font-mono text-[10px] text-muted-foreground truncate">
                        {st.file}
                      </span>
                    )}
                    {ver && (
                      <span className="font-mono text-[10px] text-muted-foreground truncate">
                        {ver.total > 0
                          ? `Хэш: ${ver.file} · ${ver.done}/${ver.total}`
                          : 'Запрашиваю эталонные хэши с HF…'}
                      </span>
                    )}
                    {note && (
                      <span
                        className="text-[11px]"
                        style={{ color: note.ok ? 'hsl(var(--ok))' : 'hsl(var(--err))' }}
                      >
                        {note.text}
                      </span>
                    )}
                    {st.status === 'error' && (
                      <span className="text-[11px]" style={{ color: 'hsl(var(--err))' }}>
                        {st.message}
                      </span>
                    )}
                  </div>
                )
              })}

              {/* Загрузка модели по ссылке */}
              <div className="panel-inset px-3 py-3 flex flex-col gap-2 mt-1">
                <span className="chrome-label !text-[10px] flex items-center gap-1.5">
                  <Link2 className="size-3.5" aria-hidden="true" /> Своя модель по ссылке
                </span>
                <div className="flex gap-2">
                  <input
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX"
                    className={inputCls}
                    disabled={urlState.kind === 'busy'}
                  />
                  <button
                    type="button"
                    onClick={() => void downloadByUrl()}
                    disabled={urlState.kind === 'busy' || urlInput.trim().length < 10}
                    className="btn-console !min-h-8 px-3 border border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--primary)/0.1)] disabled:opacity-40 shrink-0"
                    style={{ color: 'hsl(var(--primary))' }}
                  >
                    {urlState.kind === 'busy' ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="size-3.5" aria-hidden="true" />
                    )}
                    {urlState.kind === 'busy' ? `${urlState.pct}%` : 'Скачать'}
                  </button>
                </div>
                {urlState.kind === 'busy' && urlState.file && (
                  <span className="font-mono text-[10px] text-muted-foreground truncate">
                    {urlState.file}
                  </span>
                )}
                {(urlState.kind === 'ok' || urlState.kind === 'error') && (
                  <span
                    className="text-[11px]"
                    style={{ color: urlState.kind === 'ok' ? 'hsl(var(--ok))' : 'hsl(var(--err))' }}
                  >
                    {urlState.text}
                  </span>
                )}
                <p className="text-[11px] text-muted-foreground/80 leading-snug">
                  Требования к ссылке: публичный репозиторий Hugging Face вида{' '}
                  <code className="font-mono">https://huggingface.co/&lt;владелец&gt;/&lt;модель&gt;</code>{' '}
                  (подойдёт и ссылка на страницу файла — репозиторий выделится автоматически).
                  Для локального распознавания нужна Whisper-сборка ONNX от onnx-community
                  (например <code className="font-mono">onnx-community/whisper-small</code>), для
                  локального LLM — ONNX text-generation (<code className="font-mono">onnx-community/Qwen3-*-ONNX</code>).
                  Скачанные файлы проверяются по хэшам и попадают в общий кэш — затем выберите
                  такую модель в списке выше или в «Движке», если она там есть.
                </p>
              </div>

              <p className="text-[11px] text-muted-foreground/80 leading-snug">
                Удалённые модели скачаются заново при следующем использовании. Облачные
                сервисы (OpenAI / Groq / Deepgram) моделей не требуют. «Проверить»
                сверяет хэши файлов с Hugging Face и докачивает только повреждённые.
              </p>
            </>
          )}

          {tab === 'llm-buttons' && (
            <>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Кнопки панели «AI-обработка»: название, промпт и справочник, термины которого
                подмешиваются в промпт. Плейсхолдер <code className="font-mono">{'{glossary}'}</code> в
                промпте заменяется терминами справочника; если его нет — термины добавляются в конец.
              </p>
              {buttons.map((b) => (
                <div key={b.id} className="panel-inset px-3 py-2.5 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Pencil className="size-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                    <input
                      value={b.label}
                      onChange={(e) => patchButton(b.id, { label: e.target.value })}
                      placeholder="Название кнопки"
                      className={inputCls}
                    />
                    <select
                      value={b.glossaryId ?? ''}
                      onChange={(e) => patchButton(b.id, { glossaryId: e.target.value || null })}
                      title="Справочник для этой кнопки"
                      className="panel-inset px-2 py-1.5 text-xs bg-transparent text-foreground shrink-0 max-w-40 focus:outline-none"
                    >
                      <option value="">Без справочника</option>
                      {glossaries.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => persistButtons(buttons.filter((x) => x.id !== b.id))}
                      aria-label={`Удалить кнопку ${b.label}`}
                      className="size-8 shrink-0 inline-flex items-center justify-center text-muted-foreground/60 hover:text-[hsl(var(--err))] cursor-pointer"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <textarea
                    value={b.prompt}
                    onChange={(e) => patchButton(b.id, { prompt: e.target.value })}
                    rows={3}
                    placeholder="Промпт для LLM…"
                    className="panel-inset px-2.5 py-2 text-xs bg-transparent text-foreground resize-y min-h-14 focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] w-full"
                  />
                </div>
              ))}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={addButton}
                  className="btn-console !min-h-8 px-3 border border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--primary)/0.1)]"
                  style={{ color: 'hsl(var(--primary))' }}
                >
                  <Plus className="size-3.5" aria-hidden="true" /> Добавить кнопку
                </button>
                <button
                  type="button"
                  onClick={resetButtons}
                  className="btn-console !min-h-8 px-3 border border-[hsl(var(--border))] text-muted-foreground hover:text-foreground"
                >
                  Сбросить к встроенным
                </button>
              </div>
            </>
          )}

          {tab === 'glossaries' && (
            <>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Справочники терминов: одна строка — один термин. Отмеченные в панели «Движок»
                справочники улетают в Whisper как подсказка (точнее имена и термины), а в LLM-кнопках
                можно указать справочник для конкретного промпта.
              </p>
              {glossaries.map((g) => (
                <div key={g.id} className="panel-inset px-3 py-2.5 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings.glossaryIds.includes(g.id)}
                      onChange={(e) =>
                        onSettings({
                          ...settings,
                          glossaryIds: e.target.checked
                            ? [...settings.glossaryIds, g.id]
                            : settings.glossaryIds.filter((id) => id !== g.id),
                        })
                      }
                      title="Передавать в Whisper"
                      className="size-4 accent-[hsl(var(--primary))]"
                    />
                    <input
                      value={g.name}
                      onChange={(e) => patchGlossary(g.id, { name: e.target.value })}
                      placeholder="Название справочника"
                      className={inputCls}
                    />
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {g.terms.length} терм.
                      </span>
                    <button
                      type="button"
                      onClick={() => onGlossaries(glossaries.filter((x) => x.id !== g.id))}
                      aria-label={`Удалить справочник ${g.name}`}
                      className="size-8 shrink-0 inline-flex items-center justify-center text-muted-foreground/60 hover:text-[hsl(var(--err))] cursor-pointer"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <textarea
                    value={g.terms.join('\n')}
                    onChange={(e) =>
                      patchGlossary(g.id, {
                        terms: e.target.value.split('\n').map((t) => t.trim()).filter(Boolean),
                      })
                    }
                    rows={4}
                    placeholder={'Keycloak\nJWT\nWebSocket\n…'}
                    className="panel-inset px-2.5 py-2 text-xs font-mono bg-transparent text-foreground resize-y min-h-16 focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] w-full"
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={addGlossary}
                className="btn-console !min-h-8 px-3 border border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--primary)/0.1)] self-start"
                style={{ color: 'hsl(var(--primary))' }}
              >
                <Plus className="size-3.5" aria-hidden="true" /> Добавить справочник
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
