import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookMarked,
  Check,
  Download,
  Upload,
  Globe,
  Link2,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { termsFromCsv, termsToCsv } from '@/lib/glossaryCsv'
import { downloadFile } from '@/lib/exporters'
import { AI_ACTIONS, LOCAL_MODELS } from '@/lib/models'
import { formatBytes } from '@/lib/audio'
import { modelJobId } from '@/lib/localEngine'
import { llmJobId } from '@/lib/localAi'
import { cacheSizeFor, deleteCacheEntriesMatching, storageQuota } from '@/lib/storageManager'
import { parseRepoUrl, repoFileSpecs, verifyAndRepairRepo } from '@/lib/modelIntegrity'
import {
  cancelDownload,
  clearPartialsMatching,
  forgetDownload,
  inspectFiles,
  pauseDownload,
  resumeDownload,
  startDownload,
  type FileSpec,
  type JobState,
} from '@/lib/downloads'
import {
  DIARIZE_JOB_ID,
  detectGpu,
  diarizeFiles,
  llmVariants,
  planDownload,
  storedDownloadPlan,
  whisperVariants,
} from '@/lib/modelPlan'
import {
  fetchEndpointModels,
  guessModelKind,
  normalizeBaseUrl,
  probeTranscribe,
  type CustomEndpoint,
  type EndpointModelKind,
} from '@/lib/customEndpoints'
import {
  LLM_MODELS,
  loadLlmButtons,
  saveLlmButtons,
  type AppSettings,
  type Glossary,
  type LlmButton,
} from '@/lib/storage'
import { useDownloads } from '@/hooks/useDownloads'
import { UI_LANGUAGES, useT, type TFn } from '@/i18n'

interface ModelRow {
  /** id задачи в менеджере загрузок */
  id: string
  label: string
  sizeHint: string
  /** подстроки URL в кэше, по которым определяем «скачано» и удаляем */
  markers: string[]
  /** HF-репозитории для проверки целостности по хэшам */
  repos: string[]
  /** список файлов для скачивания (обращается к дереву репозитория на HF) */
  plan: () => Promise<FileSpec[]>
  /** тот же список из локального хранилища, без сети; undefined — ещё не запрашивали */
  stored: () => Promise<FileSpec[] | undefined>
}

/** Что уже лежит на диске для модели. */
interface RowInfo {
  cached: number
  /** недокачанные байты (после паузы или обрыва) */
  partial: number
  /** true/false — известно точно по списку файлов; null — оценка по кэшу */
  complete: boolean | null
}

/**
 * Список терминов: пока пользователь печатает, хранится «сырой» текст, иначе
 * пробел и перенос строки в конце срезались бы сразу (пустые строки отбрасываются
 * при разборе). Внешние изменения (импорт CSV) подхватываются по смене массива.
 */
function TermsEditor({ terms, onChange, placeholder }: { terms: string[]; onChange: (t: string[]) => void; placeholder: string }) {
  const [text, setText] = useState(terms.join('\n'))
  const last = useRef(terms)
  useEffect(() => {
    if (terms !== last.current) {
      last.current = terms
      setText(terms.join('\n'))
    }
  }, [terms])
  return (
    <textarea
      value={text}
      onChange={(e) => {
        const v = e.target.value
        setText(v)
        const next = v.split('\n').map((x) => x.trim()).filter(Boolean)
        last.current = next
        onChange(next)
      }}
      rows={4}
      placeholder={placeholder}
      className="panel-inset px-2.5 py-2 text-xs font-mono bg-transparent text-foreground resize-y min-h-16 focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] w-full"
    />
  )
}

type TabId = 'general' | 'downloads' | 'endpoints' | 'llm-buttons' | 'glossaries'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  settings: AppSettings
  glossaries: Glossary[]
  endpoints: CustomEndpoint[]
  onSettings: (s: AppSettings) => void
  onGlossaries: (g: Glossary[]) => void
  onEndpoints: (e: CustomEndpoint[]) => void
}

const inputCls =
  'panel-inset px-2.5 py-1.5 text-xs bg-transparent text-foreground focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] w-full'
const ghostBtn =
  'btn-console !min-h-8 px-2.5 border border-[hsl(var(--border))] text-muted-foreground hover:text-foreground disabled:opacity-40'
const primaryBtn =
  'btn-console !min-h-8 px-2.5 border border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--primary)/0.1)] disabled:opacity-40'
const iconBtn =
  'size-8 shrink-0 inline-flex items-center justify-center text-muted-foreground/60 hover:text-[hsl(var(--err))] cursor-pointer'

/** Оценка размера модели в байтах из подсказки вида «~1.1 GB» / «~400 MB». */
function sizeHintBytes(hint: string): number {
  const m = hint.match(/([\d.,]+)\s*(GB|MB)/i)
  if (!m) return 0
  const n = parseFloat(m[1].replace(',', '.'))
  return /GB/i.test(m[2]) ? n * 1024 ** 3 : n * 1024 ** 2
}

function buildRows(t: TFn): ModelRow[] {
  const noBuild = () => new Error(t('dl.err.noBuild'))
  return [
    ...LOCAL_MODELS.map((m): ModelRow => {
      const variants = async () => whisperVariants(!!m.needsWebGPU, await detectGpu())
      return {
        id: modelJobId(m.hfId),
        label: `${m.label} · ${t('set.dl.kind.asr')}`,
        sizeHint: m.size,
        markers: [m.hfId.split('/')[1]],
        repos: [m.hfId],
        plan: async () => {
          const p = await planDownload(m.hfId, await variants())
          if (!p) throw noBuild()
          return p.files
        },
        stored: async () => storedDownloadPlan(m.hfId, await variants()),
      }
    }),
    {
      id: DIARIZE_JOB_ID,
      label: `${t('set.dl.kind.dia')} · pyannote + WeSpeaker`,
      sizeHint: '~45 MB',
      markers: ['pyannote', 'wespeaker', 'voxceleb'],
      repos: ['onnx-community/pyannote-segmentation-3.0', 'Wespeaker/wespeaker-voxceleb-resnet34-LM'],
      plan: () => diarizeFiles(),
      stored: () => diarizeFiles().catch(() => undefined),
    },
    ...LLM_MODELS.map((m): ModelRow => {
      const variants = async () => llmVariants(await detectGpu())
      return {
        id: llmJobId(m.id),
        label: `${t('set.dl.kind.llm')} · ${m.label}`,
        sizeHint: m.size,
        markers: [m.id.split('/')[1].toLowerCase()],
        repos: [m.id],
        plan: async () => {
          const p = await planDownload(m.id, await variants())
          if (!p) throw noBuild()
          return p.files
        },
        stored: async () => storedDownloadPlan(m.id, await variants()),
      }
    }),
  ]
}

function ProgressBar({ value, tone }: { value: number; tone: 'primary' | 'muted' | 'err' }) {
  const color =
    tone === 'err' ? 'hsl(var(--err))' : tone === 'muted' ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary))'
  return (
    <div className="h-1 rounded-sm overflow-hidden" style={{ background: 'hsl(var(--track))' }}>
      <div
        className="h-full rounded-sm transition-[width] duration-300"
        style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }}
      />
    </div>
  )
}

/** Кнопки и прогресс идущей/приостановленной загрузки — общие для моделей и «по ссылке». */
function JobControls({
  job,
  t,
  onResume,
  onCancel,
}: {
  job: JobState
  t: TFn
  onResume: () => void
  onCancel: () => void
}) {
  const pct = job.total > 0 ? Math.floor((job.loaded / job.total) * 100) : 0
  return (
    <>
      {job.status === 'running' && (
        <>
          <span className="font-mono text-[11px] tabular-nums" style={{ color: 'hsl(var(--primary))' }}>
            {pct}%
          </span>
          <button type="button" onClick={() => pauseDownload(job.id)} className={ghostBtn}>
            <Pause className="size-3.5" aria-hidden="true" />
            {t('dl.pause')}
          </button>
        </>
      )}
      {job.status === 'queued' && (
        <span className="font-mono text-[11px] text-muted-foreground">{t('dl.queued')}</span>
      )}
      {(job.status === 'paused' || job.status === 'error') && (
        <button
          type="button"
          onClick={onResume}
          className={primaryBtn}
          style={{ color: 'hsl(var(--primary))' }}
        >
          <Play className="size-3.5" aria-hidden="true" />
          {job.status === 'error' ? t('common.retry') : t('dl.resume')}
        </button>
      )}
      <button type="button" onClick={onCancel} aria-label={t('dl.cancel')} title={t('dl.cancel')} className={iconBtn}>
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </>
  )
}

function jobLine(job: JobState, t: TFn): string {
  const bytes = `${formatBytes(job.loaded)} / ${formatBytes(job.total)}`
  if (job.status === 'paused') return `${t('dl.paused')} · ${bytes}`
  if (job.status === 'error') return job.error ?? t('task.error')
  if (job.status === 'queued') return t('dl.queuedNote')
  const phase =
    job.phase === 'verify' ? t('dl.verifying') : job.phase === 'retry' ? t('dl.reconnecting') : job.file
  return `${bytes} · ${phase}`
}

export function SettingsModal({
  open,
  onClose,
  settings,
  glossaries,
  endpoints,
  onSettings,
  onGlossaries,
  onEndpoints,
}: SettingsModalProps) {
  const t = useT()
  const rows = useMemo(() => buildRows(t), [t])
  const downloads = useDownloads()

  const [tab, setTab] = useState<TabId>('general')
  const [info, setInfo] = useState<Record<string, RowInfo>>({})
  /** ошибка подготовки загрузки (не удалось получить список файлов) */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [preparing, setPreparing] = useState<Record<string, boolean>>({})
  /** прогресс проверки целостности по id модели */
  const [verifying, setVerifying] = useState<Record<string, { file: string; done: number; total: number }>>({})
  /** итог последней проверки по id модели */
  const [verifyNotes, setVerifyNotes] = useState<Record<string, { ok: boolean; text: string }>>({})
  /** занято/лимит хранилища браузера (для предупреждений перед большими закачками) */
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null)
  /** модель, ожидающая подтверждения скачивания (null — окно закрыто) */
  const [confirming, setConfirming] = useState<ModelRow | null>(null)
  /** места не хватит — подтверждение становится предупреждением */
  const [confirmTight, setConfirmTight] = useState(false)

  // --- загрузка по ссылке ---
  const [urlInput, setUrlInput] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [urlBusy, setUrlBusy] = useState(false)

  // --- свои сервисы ---
  const [epStatus, setEpStatus] = useState<
    Record<string, { busy?: boolean; error?: string; note?: string }>
  >({})
  const [epFilter, setEpFilter] = useState<Record<string, string>>({})
  const [epManual, setEpManual] = useState<Record<string, string>>({})
  const [epManualKind, setEpManualKind] = useState<Record<string, EndpointModelKind>>({})

  // --- LLM-кнопки ---
  const builtinButtons = useCallback(
    (): LlmButton[] => AI_ACTIONS.map((a) => ({ id: a.id, label: t(a.labelKey), prompt: a.prompt })),
    [t],
  )
  const [savedButtons, setSavedButtons] = useState<LlmButton[] | null>(loadLlmButtons)
  const buttons = savedButtons ?? builtinButtons()

  const persistButtons = (list: LlmButton[]) => {
    setSavedButtons(list)
    saveLlmButtons(list)
  }

  const refresh = useCallback(async () => {
    const next: Record<string, RowInfo> = {}
    for (const m of rows) {
      const files = await m.stored().catch(() => undefined)
      if (files) {
        const r = await inspectFiles(files)
        next[m.id] = { cached: r.cached, partial: r.partial, complete: r.complete }
      } else {
        // список файлов ещё не запрашивали — оцениваем по содержимому кэша
        let bytes = 0
        for (const marker of m.markers) bytes += await cacheSizeFor(marker)
        next[m.id] = { cached: bytes, partial: 0, complete: bytes > 1024 ? null : false }
      }
    }
    setInfo(next)
  }, [rows])

  useEffect(() => {
    if (!open) return
    void refresh()
    void storageQuota().then((q) => setQuota(q && q.reliable ? q : null))
  }, [open, refresh])

  // загрузка завершилась/остановилась — пересчитываем, что лежит на диске
  const statusKey = Object.values(downloads)
    .map((j) => `${j.id}:${j.status}`)
    .join('|')
  useEffect(() => {
    if (open) void refresh()
  }, [statusKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Проверка целостности по хэшам HF: битые файлы перекачиваются заново,
   * целые и отсутствующие не трогаем.
   */
  const verifyModel = useCallback(
    async (m: ModelRow) => {
      setVerifyNotes((n) => {
        const next = { ...n }
        delete next[m.id]
        return next
      })
      let totalChecked = 0
      let totalFixed = 0
      const failed: string[] = []
      const note = (ok: boolean, text: string) =>
        setVerifyNotes((n) => ({ ...n, [m.id]: { ok, text } }))
      try {
        for (const repo of m.repos) {
          const r = await verifyAndRepairRepo(repo, (file, done, total) =>
            setVerifying((v) => ({ ...v, [m.id]: { file, done, total } })),
          )
          totalChecked += r.checked
          totalFixed += r.fixed
          failed.push(...r.failed)
        }
        if (failed.length > 0) note(false, t('set.ver.failed', { files: failed.join(', ') }))
        else if (totalChecked === 0) note(true, t('set.ver.none'))
        else if (totalFixed > 0) note(true, t('set.ver.fixed', { n: totalChecked, fixed: totalFixed }))
        else note(true, t('set.ver.ok', { n: totalChecked }))
      } catch (e) {
        note(false, t('set.ver.error', { detail: e instanceof Error ? e.message : String(e) }))
      } finally {
        setVerifying((v) => {
          const next = { ...v }
          delete next[m.id]
          return next
        })
        void refresh()
      }
    },
    [t, refresh],
  )

  /**
   * Клик «Скачать» не начинает закачку сразу: сначала окно подтверждения
   * (размер, свободное место). Если места не хватает — предупреждение в том же окне.
   */
  const requestDownload = async (m: ModelRow) => {
    const need = sizeHintBytes(m.sizeHint)
    let tight = false
    if (need > 300 * 1024 ** 2) {
      const q = await storageQuota()
      // на время сборки файл лежит и кусками, и в кэше — нужен двойной запас
      if (q && q.reliable) tight = need * 2 > (q.quota - q.usage) * 0.9
    }
    setConfirmTight(tight)
    setConfirming(m)
  }

  /** Поставить модель в очередь менеджера загрузок (или продолжить недокачанную). */
  const begin = async (m: ModelRow) => {
    setRowErrors((e) => {
      const next = { ...e }
      delete next[m.id]
      return next
    })
    setPreparing((p) => ({ ...p, [m.id]: true }))
    try {
      const files = await m.plan()
      void startDownload(m.id, m.label, files).catch(() => undefined)
    } catch (e) {
      setRowErrors((x) => ({ ...x, [m.id]: e instanceof Error ? e.message : String(e) }))
    } finally {
      setPreparing((p) => {
        const next = { ...p }
        delete next[m.id]
        return next
      })
    }
  }

  const resume = (m: ModelRow) => {
    if (downloads[m.id]) resumeDownload(m.id)
    else void begin(m) // после перезагрузки страницы задачи нет, но куски на диске остались
  }

  const cancel = async (m: ModelRow) => {
    await cancelDownload(m.id)
    for (const marker of m.markers) await clearPartialsMatching(marker)
    await refresh()
  }

  const remove = async (m: ModelRow) => {
    await cancelDownload(m.id)
    for (const marker of m.markers) {
      await deleteCacheEntriesMatching(marker)
      await clearPartialsMatching(marker)
    }
    forgetDownload(m.id)
    await refresh()
  }

  const downloadByUrl = async () => {
    const repo = parseRepoUrl(urlInput)
    if (!repo) {
      setUrlError(t('set.url.bad'))
      return
    }
    setUrlError(null)
    setUrlBusy(true)
    try {
      const files = await repoFileSpecs(repo)
      void startDownload(`url:${repo}`, repo, files).catch(() => undefined)
      setUrlInput('')
    } catch (e) {
      setUrlError(e instanceof Error ? e.message : String(e))
    } finally {
      setUrlBusy(false)
    }
  }
  const urlJobs = Object.values(downloads).filter((j) => j.id.startsWith('url:'))

  // --- свои сервисы ---
  const patchEndpoint = (id: string, patch: Partial<CustomEndpoint>) =>
    onEndpoints(endpoints.map((e) => (e.id === id ? { ...e, ...patch } : e)))

  const addEndpoint = () =>
    onEndpoints([
      ...endpoints,
      {
        id: crypto.randomUUID(),
        name: t('set.ep.defaultName', { n: endpoints.length + 1 }),
        baseUrl: '',
        apiKey: '',
        viaProxy: false,
        convertAudio: true,
        models: [],
        available: [],
      },
    ])

  const loadModels = async (ep: CustomEndpoint) => {
    const baseUrl = normalizeBaseUrl(ep.baseUrl)
    if (!/^https?:\/\/[^/]+/i.test(baseUrl)) {
      setEpStatus((s) => ({ ...s, [ep.id]: { error: t('set.ep.badUrl') } }))
      return
    }
    setEpStatus((s) => ({ ...s, [ep.id]: { busy: true } }))
    try {
      const fetched = await fetchEndpointModels({ ...ep, baseUrl })
      // добавленные вручную модели (у whisper.cpp нет /models) не теряем
      const available = [...new Set([...fetched, ...ep.models.map((m) => m.id)])]
      patchEndpoint(ep.id, { baseUrl, available })
      setEpStatus((s) => ({ ...s, [ep.id]: { note: t('set.ep.found', { n: fetched.length }) } }))
    } catch (e) {
      setEpStatus((s) => ({
        ...s,
        [ep.id]: { error: e instanceof Error ? e.message : String(e) },
      }))
    }
  }

  const addManualModel = (ep: CustomEndpoint) => {
    const id = (epManual[ep.id] ?? '').trim()
    if (!id) return
    patchEndpoint(ep.id, {
      available: ep.available.includes(id) ? ep.available : [...ep.available, id],
      // вручную добавляют чаще распознавание (у whisper.cpp нет /models): по умолчанию «распознавание»
      models: ep.models.some((m) => m.id === id)
        ? ep.models.map((m) => (m.id === id ? { ...m, kind: epManualKind[ep.id] ?? 'asr' } : m))
        : [...ep.models, { id, kind: epManualKind[ep.id] ?? 'asr' }],
    })
    setEpManual((m) => ({ ...m, [ep.id]: '' }))
  }

  const testAsr = async (ep: CustomEndpoint) => {
    setEpStatus((s) => ({ ...s, [ep.id]: { busy: true } }))
    try {
      await probeTranscribe({ ...ep, baseUrl: normalizeBaseUrl(ep.baseUrl) }, ep.models.find((m) => m.kind === 'asr')?.id ?? '')
      setEpStatus((s) => ({ ...s, [ep.id]: { note: t('set.ep.testOk') } }))
    } catch (e) {
      setEpStatus((s) => ({ ...s, [ep.id]: { error: e instanceof Error ? e.message : String(e) } }))
    }
  }

  const toggleModel = (ep: CustomEndpoint, id: string, on: boolean) =>
    patchEndpoint(ep.id, {
      models: on
        ? [...ep.models, { id, kind: guessModelKind(id) }]
        : ep.models.filter((m) => m.id !== id),
    })

  const setModelKind = (ep: CustomEndpoint, id: string, kind: EndpointModelKind) =>
    patchEndpoint(ep.id, { models: ep.models.map((m) => (m.id === id ? { ...m, kind } : m)) })

  // --- редакторы справочников и кнопок ---
  const csvInput = useRef<HTMLInputElement | null>(null)
  const csvTarget = useRef<string | null>(null)

  const addGlossary = () =>
    onGlossaries([
      ...glossaries,
      { id: crypto.randomUUID(), name: t('set.gl.defaultName', { n: glossaries.length + 1 }), terms: [] },
    ])

  const patchGlossary = (id: string, patch: Partial<Glossary>) =>
    onGlossaries(glossaries.map((g) => (g.id === id ? { ...g, ...patch } : g)))

  const addButton = () =>
    persistButtons([
      ...buttons,
      {
        id: crypto.randomUUID(),
        label: t('set.btn.defaultName', { n: buttons.length + 1 }),
        prompt: '',
        glossaryId: null,
      },
    ])

  const patchButton = (id: string, patch: Partial<LlmButton>) =>
    persistButtons(buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)))

  const resetButtons = () => persistButtons(builtinButtons())

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
      aria-label={t('set.title')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="panel w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl shadow-black/40">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))]">
          <h2 className="chrome-label">{t('set.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="size-9 inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div
          className="flex flex-wrap gap-1 px-4 pt-3 pb-2 border-b border-[hsl(var(--border))]"
          role="tablist"
          aria-label={t('set.tabs')}
        >
          {tabBtn('general', t('set.tab.general'), <Globe className="size-3.5" aria-hidden="true" />)}
          {tabBtn('downloads', t('set.tab.downloads'), <Download className="size-3.5" aria-hidden="true" />)}
          {tabBtn('endpoints', t('set.tab.endpoints'), <Plug className="size-3.5" aria-hidden="true" />)}
          {tabBtn('llm-buttons', t('set.tab.buttons'), <Sparkles className="size-3.5" aria-hidden="true" />)}
          {tabBtn('glossaries', t('set.tab.glossaries'), <BookMarked className="size-3.5" aria-hidden="true" />)}
        </div>

        <div className="overflow-y-auto p-4 flex flex-col gap-2">
          {tab === 'general' && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="chrome-label !text-[10px]">{t('set.lang')}</span>
                <select
                  value={settings.uiLang}
                  onChange={(e) => onSettings({ ...settings, uiLang: e.target.value })}
                  className="panel-inset px-3 py-2.5 text-sm text-foreground bg-transparent focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))]"
                >
                  {UI_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code} className="bg-[hsl(var(--popover))]">
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-muted-foreground/80 leading-snug">{t('set.langNote')}</p>
            </>
          )}

          {tab === 'downloads' && (
            <>
              <p className="text-xs text-muted-foreground leading-relaxed">{t('set.dl.intro')}</p>
              {quota && (
                <div className="panel-inset px-3 py-2 flex items-center gap-3">
                  <span className="font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                    {t('set.dl.storage')}: {formatBytes(quota.usage)} / {formatBytes(quota.quota)}
                  </span>
                  <div className="flex-1">
                    <ProgressBar
                      value={(quota.usage / quota.quota) * 100}
                      tone={quota.usage / quota.quota > 0.85 ? 'err' : 'primary'}
                    />
                  </div>
                  {quota.usage / quota.quota > 0.85 && (
                    <span className="text-[10px]" style={{ color: 'hsl(var(--err))' }}>
                      {t('set.dl.low')}
                    </span>
                  )}
                </div>
              )}
              {confirming && (
                <div
                  className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
                  role="dialog"
                  aria-modal="true"
                  aria-label={t('set.dl.confirmTitle')}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setConfirming(null)
                  }}
                >
                  <div className="panel w-full max-w-md p-4 flex flex-col gap-3 shadow-xl shadow-black/50">
                    <h3 className="chrome-label">{t('set.dl.confirmTitle')}</h3>
                    <p className="text-sm text-foreground/90 leading-relaxed">
                      {confirming.label} · {confirming.sizeHint}. {t('set.dl.confirmText')}
                    </p>
                    {quota && (
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {t('set.dl.free')}: ~{formatBytes(Math.max(0, quota.quota - quota.usage))} /{' '}
                        {formatBytes(quota.quota)}
                      </p>
                    )}
                    {confirmTight && (
                      <p className="text-xs leading-snug" style={{ color: 'hsl(var(--warn))' }}>
                        {t('set.dl.tight')}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground/80 leading-snug">
                      {t('set.dl.queueNote')}
                    </p>
                    <div className="flex gap-2 justify-end">
                      <button type="button" onClick={() => setConfirming(null)} className={`${ghostBtn} !min-h-9 px-4`}>
                        {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const m = confirming
                          setConfirming(null)
                          void begin(m)
                        }}
                        className="btn-console !min-h-9 px-4 border bg-[hsl(var(--primary)/0.1)] border-[hsl(var(--primary)/0.5)] hover:bg-[hsl(var(--primary)/0.18)]"
                        style={{ color: 'hsl(var(--primary))' }}
                      >
                        <Download className="size-3.5" aria-hidden="true" />
                        {confirmTight ? t('set.dl.anyway') : t('set.dl.download')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {rows.map((m) => {
                const st = info[m.id]
                const liveJob = downloads[m.id]
                // завершённая задача ничем не отличается от «скачано» — показываем по кэшу
                const job = liveJob && liveJob.status !== 'done' ? liveJob : null
                const ver = verifying[m.id]
                const note = verifyNotes[m.id]
                const present = !job && !!st && st.cached > 1024 && st.complete !== false
                const leftover = !job && !!st && !present && (st.partial > 0 || st.cached > 1024)
                const busyRow = !!job || !!ver || !!preparing[m.id]
                return (
                  <div key={m.id} className="panel-inset px-3 py-2.5 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] text-foreground/90 flex-1 min-w-0 truncate">
                        {m.label}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                        {present && st ? formatBytes(st.cached) : m.sizeHint}
                      </span>
                      {present && (
                        <Check
                          className="size-3.5 shrink-0"
                          style={{ color: 'hsl(var(--ok))' }}
                          aria-label={t('set.dl.present')}
                        />
                      )}
                      {job ? (
                        <JobControls job={job} t={t} onResume={() => resume(m)} onCancel={() => void cancel(m)} />
                      ) : ver || preparing[m.id] ? (
                        <span
                          className="btn-console !min-h-8 px-2.5 border border-[hsl(var(--primary)/0.4)] inline-flex"
                          style={{ color: 'hsl(var(--primary))' }}
                        >
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          {ver ? t('set.ver.checking') : t('set.dl.preparing')}
                        </span>
                      ) : (
                        <>
                          {present && (
                            <button
                              type="button"
                              onClick={() => void verifyModel(m)}
                              title={t('set.ver.title')}
                              className={ghostBtn}
                            >
                              <ShieldCheck className="size-3.5" aria-hidden="true" />
                              {t('set.ver.btn')}
                            </button>
                          )}
                          {leftover ? (
                            <button
                              type="button"
                              onClick={() => resume(m)}
                              className={primaryBtn}
                              style={{ color: 'hsl(var(--primary))' }}
                            >
                              <Play className="size-3.5" aria-hidden="true" />
                              {t('dl.resume')}
                            </button>
                          ) : (
                            !present && (
                              <button
                                type="button"
                                onClick={() => void requestDownload(m)}
                                className={primaryBtn}
                                style={{ color: 'hsl(var(--primary))' }}
                              >
                                <Download className="size-3.5" aria-hidden="true" />
                                {t('set.dl.download')}
                              </button>
                            )
                          )}
                        </>
                      )}
                      {(present || leftover) && !busyRow && (
                        <button
                          type="button"
                          onClick={() => void remove(m)}
                          aria-label={`${t('common.delete')} ${m.label}`}
                          className={iconBtn}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    {job && (
                      <>
                        {job.total > 0 && (
                          <ProgressBar
                            value={(job.loaded / job.total) * 100}
                            tone={job.status === 'error' ? 'err' : job.status === 'running' ? 'primary' : 'muted'}
                          />
                        )}
                        <span
                          className="font-mono text-[10px] truncate"
                          style={{
                            color: job.status === 'error' ? 'hsl(var(--err))' : 'hsl(var(--muted-foreground))',
                          }}
                        >
                          {jobLine(job, t)}
                        </span>
                      </>
                    )}
                    {leftover && st && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {t('set.dl.partial', { size: formatBytes(st.cached + st.partial) })}
                      </span>
                    )}
                    {ver && (
                      <span className="font-mono text-[10px] text-muted-foreground truncate">
                        {ver.total > 0 ? `${ver.file} · ${ver.done}/${ver.total}` : t('set.ver.fetching')}
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
                    {rowErrors[m.id] && (
                      <span className="text-[11px]" style={{ color: 'hsl(var(--err))' }}>
                        {rowErrors[m.id]}
                      </span>
                    )}
                  </div>
                )
              })}

              {/* Загрузка модели по ссылке */}
              <div className="panel-inset px-3 py-3 flex flex-col gap-2 mt-1">
                <span className="chrome-label !text-[10px] flex items-center gap-1.5">
                  <Link2 className="size-3.5" aria-hidden="true" /> {t('set.url.title')}
                </span>
                <div className="flex gap-2">
                  <input
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX"
                    className={inputCls}
                    disabled={urlBusy}
                  />
                  <button
                    type="button"
                    onClick={() => void downloadByUrl()}
                    disabled={urlBusy || urlInput.trim().length < 10}
                    className={`${primaryBtn} px-3 shrink-0`}
                    style={{ color: 'hsl(var(--primary))' }}
                  >
                    {urlBusy ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="size-3.5" aria-hidden="true" />
                    )}
                    {t('set.dl.download')}
                  </button>
                </div>
                {urlError && (
                  <span className="text-[11px]" style={{ color: 'hsl(var(--err))' }}>
                    {urlError}
                  </span>
                )}
                {urlJobs.map((job) => (
                  <div key={job.id} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-foreground/90 flex-1 min-w-0 truncate">
                        {job.label}
                      </span>
                      {job.status === 'done' ? (
                        <>
                          <Check className="size-3.5" style={{ color: 'hsl(var(--ok))' }} aria-hidden="true" />
                          <button
                            type="button"
                            onClick={() => forgetDownload(job.id)}
                            aria-label={t('common.close')}
                            className={iconBtn}
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </button>
                        </>
                      ) : (
                        <JobControls
                          job={job}
                          t={t}
                          onResume={() => resumeDownload(job.id)}
                          onCancel={() => void cancelDownload(job.id)}
                        />
                      )}
                    </div>
                    {job.status !== 'done' && (
                      <>
                        {job.total > 0 && (
                          <ProgressBar
                            value={(job.loaded / job.total) * 100}
                            tone={job.status === 'error' ? 'err' : job.status === 'running' ? 'primary' : 'muted'}
                          />
                        )}
                        <span className="font-mono text-[10px] text-muted-foreground truncate">
                          {jobLine(job, t)}
                        </span>
                      </>
                    )}
                  </div>
                ))}
                <p className="text-[11px] text-muted-foreground/80 leading-snug">{t('set.url.note')}</p>
              </div>

              <p className="text-[11px] text-muted-foreground/80 leading-snug">{t('set.dl.footer')}</p>
            </>
          )}

          {tab === 'endpoints' && (
            <>
              <p className="text-xs text-muted-foreground leading-relaxed">{t('set.ep.intro')}</p>
              {endpoints.map((ep) => {
                const st = epStatus[ep.id] ?? {}
                const filter = (epFilter[ep.id] ?? '').toLowerCase()
                const selected = new Map(ep.models.map((m) => [m.id, m.kind]))
                const shown = ep.available.filter((id) => !filter || id.toLowerCase().includes(filter))
                return (
                  <div key={ep.id} className="panel-inset px-3 py-2.5 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={ep.name}
                        onChange={(e) => patchEndpoint(ep.id, { name: e.target.value })}
                        placeholder={t('set.ep.name')}
                        className={inputCls}
                      />
                      <button
                        type="button"
                        onClick={() => onEndpoints(endpoints.filter((x) => x.id !== ep.id))}
                        aria-label={`${t('common.delete')} ${ep.name}`}
                        className={iconBtn}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    <input
                      value={ep.baseUrl}
                      onChange={(e) => patchEndpoint(ep.id, { baseUrl: e.target.value })}
                      placeholder="https://api.example.com/v1"
                      spellCheck={false}
                      className={`${inputCls} font-mono`}
                    />
                    <input
                      type="password"
                      autoComplete="off"
                      value={ep.apiKey}
                      onChange={(e) => patchEndpoint(ep.id, { apiKey: e.target.value.trim() })}
                      placeholder={t('set.ep.token')}
                      className={`${inputCls} font-mono`}
                    />
                    <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={ep.viaProxy}
                        onChange={(e) => patchEndpoint(ep.id, { viaProxy: e.target.checked })}
                        className="size-4 accent-[hsl(var(--primary))]"
                      />
                      {t('set.ep.proxy')}
                    </label>
                    <label className="flex items-start gap-2 text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={!!ep.convertAudio}
                        onChange={(e) => patchEndpoint(ep.id, { convertAudio: e.target.checked })}
                        className="size-4 mt-0.5 accent-[hsl(var(--primary))]"
                      />
                      <span>
                        {t('set.ep.convert')}
                        <span className="block text-muted-foreground/70">{t('set.ep.convertNote')}</span>
                      </span>
                    </label>
                    <input
                      value={ep.asrPath ?? ''}
                      onChange={(e) => patchEndpoint(ep.id, { asrPath: e.target.value })}
                      placeholder={t('set.ep.asrPath')}
                      disabled={ep.viaProxy}
                      spellCheck={false}
                      className={`${inputCls} font-mono disabled:opacity-50`}
                    />
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => void loadModels(ep)}
                        disabled={st.busy || ep.baseUrl.trim().length < 8}
                        className={primaryBtn}
                        style={{ color: 'hsl(var(--primary))' }}
                      >
                        {st.busy ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <RefreshCw className="size-3.5" aria-hidden="true" />
                        )}
                        {t('set.ep.fetch')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void testAsr(ep)}
                        disabled={st.busy || ep.baseUrl.trim().length < 8}
                        className={primaryBtn}
                        style={{ color: 'hsl(var(--primary))' }}
                      >
                        {t('set.ep.testAsr')}
                      </button>
                      {st.note && (
                        <span className="text-[11px]" style={{ color: 'hsl(var(--ok))' }}>
                          {st.note}
                        </span>
                      )}
                      {ep.models.length > 0 && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {t('set.ep.selected', { n: ep.models.length })}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                    <input
                      value={epManual[ep.id] ?? ''}
                      onChange={(e) => setEpManual((m) => ({ ...m, [ep.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addManualModel(ep)
                        }
                      }}
                      placeholder={t('set.ep.addModel')}
                      spellCheck={false}
                      className={`${inputCls} font-mono flex-1 min-w-0`}
                    />
                      <select
                        value={epManualKind[ep.id] ?? 'asr'}
                        onChange={(e) => setEpManualKind((k) => ({ ...k, [ep.id]: e.target.value as EndpointModelKind }))}
                        title={t('set.ep.kind')}
                        className="panel-inset px-1.5 py-2 text-[11px] bg-transparent text-foreground shrink-0 focus:outline-none"
                      >
                        <option value="asr">{t('set.ep.kind.asr')}</option>
                        <option value="llm">{t('set.ep.kind.llm')}</option>
                      </select>
                    </div>
                    {st.error && (
                      <span className="text-[11px] break-words" style={{ color: 'hsl(var(--err))' }}>
                        {st.error}
                      </span>
                    )}
                    {ep.available.length > 0 && (
                      <>
                        {ep.available.length > 8 && (
                          <input
                            value={epFilter[ep.id] ?? ''}
                            onChange={(e) => setEpFilter((f) => ({ ...f, [ep.id]: e.target.value }))}
                            placeholder={t('set.ep.filter')}
                            className={inputCls}
                          />
                        )}
                        <ul className="flex flex-col max-h-48 overflow-y-auto pr-1">
                          {shown.map((id) => {
                            const kind = selected.get(id)
                            return (
                              <li
                                key={id}
                                className="flex items-center gap-2 py-1 border-t first:border-t-0 border-[hsl(var(--border))]"
                              >
                                <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={kind !== undefined}
                                    onChange={(e) => toggleModel(ep, id, e.target.checked)}
                                    className="size-4 shrink-0 accent-[hsl(var(--primary))]"
                                  />
                                  <span className="font-mono text-[11px] text-foreground/90 truncate" title={id}>
                                    {id}
                                  </span>
                                </label>
                                {kind !== undefined && (
                                  <select
                                    value={kind}
                                    onChange={(e) => setModelKind(ep, id, e.target.value as EndpointModelKind)}
                                    title={t('set.ep.kind')}
                                    className="panel-inset px-1.5 py-1 text-[11px] bg-transparent text-foreground shrink-0 focus:outline-none"
                                  >
                                    <option value="asr">{t('set.ep.kind.asr')}</option>
                                    <option value="llm">{t('set.ep.kind.llm')}</option>
                                  </select>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </>
                    )}
                  </div>
                )
              })}
              <button
                type="button"
                onClick={addEndpoint}
                className={`${primaryBtn} px-3 self-start`}
                style={{ color: 'hsl(var(--primary))' }}
              >
                <Plus className="size-3.5" aria-hidden="true" /> {t('set.ep.add')}
              </button>
              <p className="text-[11px] text-muted-foreground/80 leading-snug">{t('set.ep.note')}</p>
            </>
          )}

          {tab === 'llm-buttons' && (
            <>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('set.btn.intro')}
              </p>
              {buttons.map((b) => (
                <div key={b.id} className="panel-inset px-3 py-2.5 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Pencil className="size-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                    <input
                      value={b.label}
                      onChange={(e) => patchButton(b.id, { label: e.target.value })}
                      placeholder={t('set.btn.name')}
                      className={inputCls}
                    />
                    <select
                      value={b.glossaryId ?? ''}
                      onChange={(e) => patchButton(b.id, { glossaryId: e.target.value || null })}
                      title={t('set.btn.glossary')}
                      className="panel-inset px-2 py-1.5 text-xs bg-transparent text-foreground shrink-0 max-w-40 focus:outline-none"
                    >
                      <option value="">{t('set.btn.noGlossary')}</option>
                      {glossaries.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => persistButtons(buttons.filter((x) => x.id !== b.id))}
                      aria-label={`${t('common.delete')} ${b.label}`}
                      className="size-8 shrink-0 inline-flex items-center justify-center text-muted-foreground/60 hover:text-[hsl(var(--err))] cursor-pointer"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <textarea
                    value={b.prompt}
                    onChange={(e) => patchButton(b.id, { prompt: e.target.value })}
                    rows={3}
                    placeholder={t('set.btn.prompt')}
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
                  <Plus className="size-3.5" aria-hidden="true" /> {t('set.btn.add')}
                </button>
                <button
                  type="button"
                  onClick={resetButtons}
                  className="btn-console !min-h-8 px-3 border border-[hsl(var(--border))] text-muted-foreground hover:text-foreground"
                >
                  {t('set.btn.reset')}
                </button>
              </div>
            </>
          )}

          {tab === 'glossaries' && (
            <>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('set.gl.intro')}
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
                      title={t('set.gl.send')}
                      className="size-4 accent-[hsl(var(--primary))]"
                    />
                    <input
                      value={g.name}
                      onChange={(e) => patchGlossary(g.id, { name: e.target.value })}
                      placeholder={t('set.gl.name')}
                      className={inputCls}
                    />
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {g.terms.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => onGlossaries(glossaries.filter((x) => x.id !== g.id))}
                      aria-label={`${t('common.delete')} ${g.name}`}
                      className="size-8 shrink-0 inline-flex items-center justify-center text-muted-foreground/60 hover:text-[hsl(var(--err))] cursor-pointer"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <TermsEditor
                    terms={g.terms}
                    onChange={(terms) => patchGlossary(g.id, { terms })}
                    placeholder={'Keycloak\nJWT\nК-клок = Keycloak\n…'}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        csvTarget.current = g.id
                        csvInput.current?.click()
                      }}
                      className="btn-console !min-h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      <Upload className="size-3" aria-hidden="true" /> {t('set.gl.csvAdd')}
                    </button>
                    <button
                      type="button"
                      disabled={g.terms.length === 0}
                      onClick={() => downloadFile(`${g.name || 'glossary'}.csv`, termsToCsv(g.terms), 'text/csv')}
                      className="btn-console !min-h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-40"
                    >
                      <Download className="size-3" aria-hidden="true" /> {t('set.gl.csvExport')}
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={addGlossary}
                className="btn-console !min-h-8 px-3 border border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--primary)/0.1)] self-start"
                style={{ color: 'hsl(var(--primary))' }}
              >
                <Plus className="size-3.5" aria-hidden="true" /> {t('set.gl.add')}
              </button>
              <button
                type="button"
                onClick={() => {
                  csvTarget.current = null
                  csvInput.current?.click()
                }}
                className="btn-console !min-h-8 px-3 self-start text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <Upload className="size-3.5" aria-hidden="true" /> {t('set.gl.csvNew')}
              </button>
              <input
                ref={csvInput}
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  const terms = termsFromCsv(await f.text())
                  const target = csvTarget.current
                  if (target) {
                    const g = glossaries.find((x) => x.id === target)
                    if (g) patchGlossary(g.id, { terms: [...new Set([...g.terms, ...terms])] })
                  } else {
                    onGlossaries([
                      ...glossaries,
                      { id: crypto.randomUUID(), name: f.name.replace(/\.[^.]+$/, '') || t('set.gl.defaultName', { n: glossaries.length + 1 }), terms },
                    ])
                  }
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
