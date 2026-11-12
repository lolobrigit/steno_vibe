import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Play, RotateCcw, Square } from 'lucide-react'
import { Rail, type Flyout } from '@/sections/Rail'
import { MediaPane } from '@/sections/MediaPane'
import type { PlayerHandle } from '@/lib/player'
import { Maximize2, Minimize2 } from 'lucide-react'
import { ProjectsModal } from '@/sections/ProjectsModal'
import { useTranscriptDoc } from '@/hooks/useTranscriptDoc'
import { AiPanel, type AiApply } from '@/sections/AiPanel'
import { plainText, joinWithPrevious, mergeSpeakerNames, mergeSpeakers, nextSpeakerId, NEW_SPEAKER, splitSegment, versionNumber } from '@/lib/transcript'
import { Header } from '@/sections/Header'
import { SourcePanel } from '@/sections/SourcePanel'
import { EnginePanel } from '@/sections/EnginePanel'
import { TranscriptView } from '@/sections/TranscriptView'
import { HistoryPanel, StoragePanel } from '@/sections/Panels'
import { SettingsModal } from '@/sections/SettingsModal'
import { FileConfirmModal } from '@/sections/FileConfirmModal'
import { TaskList } from '@/sections/TaskList'
import type { TaskApi, TaskItem } from '@/lib/tasks'
import { Waveform } from '@/components/Waveform'
import { decodeAudio, formatBytes, formatDurationShort, type DecodedAudio } from '@/lib/audio'
import { decodeWithFfmpeg } from '@/lib/ffmpegDecode'
import { transcribeCloud } from '@/lib/cloudEngines'
import {
  customTranscribe,
  loadEndpoints,
  parseCustomRef,
  saveEndpoints,
} from '@/lib/customEndpoints'
import {
  deviceLabel,
  hasWebGPU,
  loadLocalModel,
  localDeviceLabel,
  modelJobId,
  transcribeLocal,
} from '@/lib/localEngine'
import { assignSpeakers, diarizeLocal, resetDiarizeWorker } from '@/lib/diarize'
import { DIARIZE_JOB_ID } from '@/lib/modelPlan'
import { isAbort } from '@/lib/gpu'
import { deleteAudio, getAudio, getConvertedWav, saveAudio, saveConvertedWav } from '@/lib/audioStore'
import { CLOUD_MODELS, LOCAL_MODELS, PROVIDER_INFO } from '@/lib/models'
import {
  addHistory,
  glossaryPromptText,
  loadGlossaries,
  loadHistory,
  loadKeys,
  loadSettings,
  removeHistory,
  saveGlossaries,
  saveKeys,
  saveSettings,
} from '@/lib/storage'
import { useRecorder, type RecordSource } from '@/hooks/useRecorder'
import { useFolderWatch } from '@/hooks/useFolderWatch'
import { useDownloads } from '@/hooks/useDownloads'
import { getLanguage, initialLanguage, setLanguage, t, useT } from '@/i18n'
import type { HistoryItem, QueueItem, TranscriptResult, TranscribePhase } from '@/types'

interface AudioSource {
  blob: Blob
  name: string
  decoded: DecodedAudio | null
  decodeError: string | null
  /** запись истории, созданная при загрузке файла (дополняется после транскрипции) */
  historyId?: string
}

interface UiCallbacks {
  phase: (p: TranscribePhase) => void
  status: (t: string) => void
  /** список задач с процентами (конвертация/модель/ASR/диаризация) */
  task?: TaskApi
}

const EMPTY_LEVELS = new Array(96).fill(0.04)

/** Расширение файла записи по MIME, который выбрал MediaRecorder. */
function recordingExt(type: string): string {
  if (type.includes('mp4')) return 'mp4'
  if (type.includes('ogg')) return 'ogg'
  return 'webm'
}

export default function Home() {
  const tr = useT()
  const [settings, setSettings] = useState(() => {
    const s = loadSettings()
    return { ...s, uiLang: initialLanguage(s.uiLang) }
  })
  const [keys, setKeys] = useState(loadKeys)
  const [history, setHistory] = useState(loadHistory)
  const [glossaries, setGlossaries] = useState(loadGlossaries)
  const [endpoints, setEndpoints] = useState(loadEndpoints)
  const [audio, setAudio] = useState<AudioSource | null>(null)
  const [phase, setPhase] = useState<TranscribePhase>('idle')
  const [statusText, setStatusText] = useState('')
  /** документ расшифровки: версии записи; показываем активную */
  const doc = useTranscriptDoc(setHistory)
  const { result, speakerNames } = doc
  const [resultName, setResultName] = useState('transcript')
  const [flyout, setFlyout] = useState<Flyout | null>(null)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const playerRef = useRef<PlayerHandle | null>(null)
  const [playerState, setPlayerState] = useState({ playing: false, time: 0, duration: 0 })
  /** LLM работает или есть результат — видео сужается */
  const [aiActive, setAiActive] = useState(false)
  /** видео развёрнуто на всё место, панель AI скрыта */
  const [mediaExpanded, setMediaExpanded] = useState(false)
  /** результат LLM развёрнут вверх на место видео (десктоп) */
  const [aiExpanded, setAiExpanded] = useState(false)
  /** прокрутка результата LLM и расшифровки связана */
  const [syncOn, setSyncOn] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [queueBusy, setQueueBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const startedRef = useRef(0)
  /** отмена текущего распознавания (кнопка «Отмена») */
  const abortRef = useRef<AbortController | null>(null)
  const resultRef = useRef<TranscriptResult | null>(null)
  resultRef.current = result

  // адрес для просмотра загруженного видео прямо в блоке «Источник»
  const audioBlobRef = audio?.blob
  useEffect(() => {
    if (!audioBlobRef) {
      setMediaUrl(null)
      return
    }
    const u = URL.createObjectURL(audioBlobRef)
    setMediaUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [audioBlobRef])
  const downloads = useDownloads()

  // единый API списка задач: этапы транскрипции пишет Home, LLM — AiPanel
  const taskApi = useMemo<TaskApi>(
    () => ({
      start: (id, label, detail) =>
        setTasks((ts) => [
          ...ts.filter((x) => x.id !== id),
          { id, label, detail, pct: null, state: 'run' as const },
        ]),
      update: (id, patch) =>
        setTasks((ts) => {
          const row = ts.find((x) => x.id === id)
          if (!row || row.state !== 'run') return ts
          const next = { ...row, ...patch }
          if (next.pct === row.pct && next.detail === row.detail && next.label === row.label) return ts
          return ts.map((x) => (x.id === id ? next : x))
        }),
      done: (id, detail) =>
        setTasks((ts) =>
          ts.map((x) =>
            x.id === id && x.state === 'run' ? { ...x, pct: 100, state: 'done' as const, detail } : x,
          ),
        ),
      fail: (id, detail) =>
        setTasks((ts) =>
          ts.map((x) =>
            x.id === id && x.state === 'run' ? { ...x, state: 'error' as const, detail } : x,
          ),
        ),
      failRunning: () =>
        setTasks((ts) =>
          ts.map((x) => (x.state === 'run' ? { ...x, state: 'error' as const } : x)),
        ),
      cancelRunning: () =>
        setTasks((ts) =>
          ts.map((x) => (x.state === 'run' ? { ...x, state: 'cancelled' as const } : x)),
        ),
      reset: () => setTasks([]),
    }),
    [],
  )

  const busy = phase === 'loading-model' || phase === 'transcribing'

  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => saveKeys(keys), [keys])
  useEffect(() => saveGlossaries(glossaries), [glossaries])
  useEffect(() => saveEndpoints(endpoints), [endpoints])

  // тема оформления
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // язык интерфейса
  useEffect(() => {
    if (getLanguage() !== settings.uiLang) void setLanguage(settings.uiLang)
  }, [settings.uiLang])

  // смена режима сбрасывает ошибку предыдущей попытки
  useEffect(() => {
    setError(null)
    if (phase === 'error') setPhase('idle')
  }, [settings.mode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!busy) return
    startedRef.current = Date.now()
    setElapsed(0)
    const timer = window.setInterval(
      () => setElapsed((Date.now() - startedRef.current) / 1000),
      500,
    )
    return () => window.clearInterval(timer)
  }, [busy])

  const customAsr = useMemo(
    () => parseCustomRef(settings.cloudModel, endpoints),
    [settings.cloudModel, endpoints],
  )
  const cloudModel = useMemo(
    () => CLOUD_MODELS.find((m) => m.id === settings.cloudModel) ?? CLOUD_MODELS[0],
    [settings.cloudModel],
  )
  const localModel = useMemo(
    () => LOCAL_MODELS.find((m) => m.id === settings.localModel) ?? LOCAL_MODELS[1],
    [settings.localModel],
  )

  // Прогресс скачивания моделей приходит из менеджера загрузок (байты, а не
  // среднее процентов по файлам) и зеркалится в строки задач.
  const modelJob = downloads[modelJobId(localModel.hfId)]
  const diaJob = downloads[DIARIZE_JOB_ID]
  useEffect(() => {
    if (!busy && !queueBusy) return
    const sync = (taskId: string, job: typeof modelJob) => {
      if (!job || job.status !== 'running' || job.total <= 0) return
      taskApi.update(taskId, {
        pct: Math.min(99, Math.floor((job.loaded / job.total) * 100)),
        detail:
          job.phase === 'verify'
            ? t('dl.verifying')
            : job.phase === 'retry'
              ? t('dl.reconnecting')
              : `${formatBytes(job.loaded)} / ${formatBytes(job.total)}`,
      })
    }
    sync('model', modelJob)
    sync('dia', diaJob)
  }, [modelJob, diaJob, busy, queueBusy, taskApi])

  /** Нативное декодирование, при неудаче — ffmpeg.wasm (m4a/aac и прочие). */
  const decodeSmart = useCallback(
    async (
      blob: Blob,
      name: string,
      ui?: UiCallbacks,
    ): Promise<{ decoded: DecodedAudio; wav: Blob | null }> => {
      ui?.task?.start('audio', t('task.decode'))
      try {
        const out = await decodeAudio(blob)
        ui?.task?.done('audio')
        return { decoded: out, wav: null }
      } catch {
        ui?.phase('loading-model')
        ui?.status(t('st.converting'))
        ui?.task?.update('audio', { label: t('task.convert'), pct: null })
        try {
          const { decoded, wav } = await decodeWithFfmpeg(
            blob,
            name,
            (text) => ui?.status(text),
            (pct) =>
              ui?.task?.update('audio', {
                pct,
                detail: pct === null ? t('task.d.loadConverter') : undefined,
              }),
          )
          ui?.task?.done('audio')
          return { decoded, wav }
        } catch (e) {
          ui?.task?.fail('audio')
          throw e
        }
      }
    },
    [],
  )

  /** Файл попадает в историю сразу при загрузке (вместе с аудио). */
  const ingestBlob = useCallback(
    async (blob: Blob, name: string) => {
      doc.reset()
      setError(null)
      setPhase('idle')
      setStatusText('')
      taskApi.reset()
      setFileLoading(true)
      try {
        const { decoded, wav } = await decodeSmart(blob, name, {
          phase: setPhase,
          status: setStatusText,
          task: taskApi,
        })
        const id = crypto.randomUUID()
        doc.reset(id)
        void saveAudio(id, blob, name)
        // сконвертированный вариант тоже кладём в хранилище: при повторном
        // открытии из истории декодируем WAV нативно, без ffmpeg
        if (wav) void saveConvertedWav(id, wav)
        setHistory(
          addHistory({
            id,
            createdAt: Date.now(),
            sourceName: name,
            engineLabel: '',
            modelLabel: '',
            language: '—',
            durationSec: decoded.durationSec,
            elapsedSec: 0,
            text: '',
            segments: [],
            hasAudio: true,
          }),
        )
        setAudio({ blob, name, decoded, decodeError: null, historyId: id })
      } catch {
        setAudio({ blob, name, decoded: null, decodeError: t('src.decodeFailed') })
      } finally {
        setPhase('idle')
        setStatusText('')
        setFileLoading(false)
        setPendingFile(null)
      }
    },
    [decodeSmart, taskApi, doc],
  )

  const recorder = useRecorder(
    useCallback(
      (blob: Blob) => {
        const stamp = new Date().toLocaleString(getLanguage(), {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
        // «:» и «/» в имени файла недопустимы — оно уходит в экспорт TXT/SRT
        const safe = stamp.replace(/[/:]/g, '-')
        void ingestBlob(blob, `${t('rec.fileName')} ${safe}.${recordingExt(blob.type)}`)
      },
      [ingestBlob],
    ),
    { silenceStop: settings.silenceStop },
  )

  const pushHistory = useCallback(
    (res: TranscriptResult, sourceName: string, language: string, blob?: Blob): string => {
      const id = crypto.randomUUID()
      if (blob) void saveAudio(id, blob, sourceName)
      setHistory(
        addHistory({
          id,
          createdAt: Date.now(),
          sourceName,
          engineLabel: res.engineLabel,
          modelLabel: res.modelLabel,
          language,
          durationSec: res.durationSec,
          elapsedSec: res.elapsedSec,
          text: res.text,
          segments: res.segments,
          hasAudio: !!blob,
        }),
      )
      return id
    },
    [],
  )

  /**
   * Локальная диаризация с ограничением по времени. Она опциональна: сбой,
   * зависание WASM-рантайма или отмена не должны ронять сам транскрипт.
   */
  const startDiarization = useCallback(
    (decoded: DecodedAudio, ui: UiCallbacks | undefined, signal: AbortSignal) => {
      let settled = false
      ui?.task?.start('dia', t('task.dia'))
      const promise = diarizeLocal(
        decoded.samples,
        {
          onStage: (stage) =>
            ui?.task?.update('dia', {
              pct: stage === 'analyze' ? 0 : null,
              detail: t(stage === 'analyze' ? 'task.d.analyze' : 'task.d.prepareModels'),
            }),
          onProgress: (p) => ui?.task?.update('dia', { pct: p }),
        },
        signal,
      )
        .then((d) => {
          settled = true
          ui?.task?.done('dia', d.length ? undefined : t('task.d.noSpeakers'))
          return d
        })
        .catch((e: unknown) => {
          settled = true
          if (!isAbort(e)) ui?.task?.fail('dia', t('task.d.skipped'))
          return null
        })
      return {
        isSettled: () => settled,
        wait: async () => {
          // страховка от зависшего WASM-рантайма: ждём диаризацию ограниченно
          const timeoutMs = Math.min(45 * 60_000, 60_000 + decoded.durationSec * 2000)
          let timer = 0
          const dia = await Promise.race([
            promise,
            new Promise<null>((r) => {
              timer = window.setTimeout(() => r(null), timeoutMs)
            }),
          ])
          window.clearTimeout(timer)
          if (!settled) {
            resetDiarizeWorker()
            ui?.task?.fail('dia', t('task.d.timeout'))
          }
          return dia
        },
      }
    },
    [],
  )

  const runTranscription = useCallback(
    async (
      blob: Blob,
      name: string,
      decodedHint: DecodedAudio | null | undefined,
      ui: UiCallbacks | undefined,
      signal: AbortSignal,
    ): Promise<{ res: TranscriptResult; language: string }> => {
      const lang = settings.language === 'auto' ? null : settings.language
      const t0 = performance.now()
      // термины выбранных справочников улетают в Whisper (точнее имена/термины)
      const glossHint = glossaryPromptText(glossaries, settings.glossaryIds)

      let decoded: DecodedAudio | null
      if (decodedHint !== undefined) {
        decoded = decodedHint
      } else {
        try {
          decoded = (await decodeSmart(blob, name, ui)).decoded
        } catch {
          decoded = null
        }
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

      if (settings.mode === 'local') {
        if (!decoded) throw new Error(t('err.cannotDecode', { name }))
        ui?.phase('loading-model')
        ui?.status(t('st.checkingStorage'))
        ui?.task?.start('model', t('task.model'), localModel.label)
        await loadLocalModel(
          localModel,
          {
            onStage: (stage, dev) => {
              if (stage === 'storage') {
                // модель уже есть в браузере — сеть не нужна
                ui?.status(t('st.loadingFromStorage'))
                ui?.task?.update('model', { detail: t('task.d.fromStorage') })
              } else if (stage === 'download') {
                ui?.status(t('st.downloadingModel'))
              } else {
                ui?.status(t('st.initModel', { device: deviceLabel(dev) }))
                ui?.task?.update('model', { pct: null, detail: deviceLabel(dev) })
              }
            },
          },
          signal,
        )
        ui?.task?.done('model')
        ui?.phase('transcribing')
        ui?.status(t('st.transcribing'))
        ui?.task?.start('asr', t('task.asr'), localModel.label)
        // диаризация идёт параллельно распознаванию в отдельном worker
        const dia = settings.diarize ? startDiarization(decoded, ui, signal) : null
        const out = await transcribeLocal(
          decoded.samples,
          lang,
          settings.translate ? 'translate' : 'transcribe',
          { onProgress: (p) => ui?.task?.update('asr', { pct: p }) },
          glossHint || undefined,
          signal,
        )
        ui?.task?.done('asr')
        if (dia && !dia.isSettled()) ui?.status(t('st.diarizing'))
        const speakers = dia ? await dia.wait() : null
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const segments =
          speakers && speakers.length ? assignSpeakers(out.segments, speakers) : out.segments
        return {
          language: settings.translate ? 'en' : (lang ?? 'auto'),
          res: {
            text: out.text,
            segments,
            durationSec: decoded.durationSec,
            elapsedSec: out.elapsedSec,
            engineLabel: `${t('eng.local')} · ${localDeviceLabel()}`,
            modelLabel: localModel.label,
          },
        }
      }

      // ── облако: встроенный провайдер или свой OpenAI-совместимый сервис ──
      const modelLabel = customAsr
        ? `${customAsr.endpoint.name} · ${customAsr.modelId}`
        : cloudModel.label
      const serviceDiarize = !customAsr && cloudModel.provider === 'deepgram'
      if (!customAsr && !keys[cloudModel.provider]) {
        throw new Error(t('err.needKey', { provider: PROVIDER_INFO[cloudModel.provider].label }))
      }
      ui?.phase('transcribing')
      ui?.status(t('st.sending', { service: modelLabel }))
      // облачный запрос без процента — бегущая полоса до ответа сервера
      ui?.task?.start('asr', t('task.asr'), modelLabel)
      const out = customAsr
        ? await customTranscribe(customAsr.endpoint, customAsr.modelId, {
            file: blob,
            fileName: name,
            language: lang,
            translate: settings.translate,
            prompt: glossHint || undefined,
            signal,
          })
        : await transcribeCloud({
            provider: cloudModel.provider,
            apiModel: cloudModel.apiModel,
            apiKey: keys[cloudModel.provider],
            file: blob,
            fileName: name,
            language: lang,
            translate: settings.translate && !serviceDiarize,
            diarize: settings.diarize && serviceDiarize,
            prompt: glossHint || undefined,
            signal,
          })
      ui?.task?.done('asr')
      // спикеров возвращает только Deepgram — остальным доразмечаем локально
      let segments = out.segments
      if (settings.diarize && !serviceDiarize && decoded && segments.length > 0) {
        ui?.status(t('st.diarizing'))
        const speakers = await startDiarization(decoded, ui, signal).wait()
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if (speakers && speakers.length) segments = assignSpeakers(segments, speakers)
      }
      return {
        language: out.language ?? settings.language,
        res: {
          text: out.text,
          segments,
          language: out.language,
          durationSec: decoded?.durationSec ?? 0,
          elapsedSec: (performance.now() - t0) / 1000,
          engineLabel: t('eng.cloud'),
          modelLabel,
        },
      }
    },
    [settings, keys, localModel, cloudModel, customAsr, decodeSmart, glossaries, startDiarization],
  )

  const transcribe = useCallback(async () => {
    if (!audio) return
    setError(null)
    // старый результат НЕ прячем: он остаётся на экране до готовности нового
    taskApi.reset()
    const ctl = new AbortController()
    abortRef.current = ctl
    try {
      const { res, language } = await runTranscription(
        audio.blob,
        audio.name,
        audio.decoded,
        { phase: setPhase, status: setStatusText, task: taskApi },
        ctl.signal,
      )
      setResultName(audio.name)
      // запись истории существует с момента загрузки файла; иначе создаём её сейчас
      const hid = audio.historyId ?? pushHistory(res, audio.name, language, audio.blob)
      if (!audio.historyId) setAudio((a) => (a ? { ...a, historyId: hid } : a))
      doc.addVersion(
        {
          kind: 'asr',
          label: res.modelLabel || res.engineLabel,
          text: res.text,
          segments: res.segments,
          speakerNames: {},
          language,
          durationSec: res.durationSec,
          elapsedSec: res.elapsedSec,
          engineLabel: res.engineLabel,
          modelLabel: res.modelLabel,
        },
        hid,
      )
      setPhase('done')
    } catch (e) {
      if (isAbort(e) || ctl.signal.aborted) {
        // отмена — не ошибка: возвращаемся к прежнему результату, если он был
        taskApi.cancelRunning()
        setPhase(resultRef.current ? 'done' : 'idle')
      } else {
        taskApi.failRunning()
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    } finally {
      if (abortRef.current === ctl) abortRef.current = null
      setStatusText('')
    }
  }, [audio, runTranscription, pushHistory, taskApi, doc])

  /** Кнопка «Отмена»: прерывает скачивание модели, распознавание и диаризацию. */
  const cancelTranscription = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // очередь из отслеживаемой папки: по одному файлу, пока свободны
  useEffect(() => {
    const next = queue.find((q) => q.status === 'pending')
    if (!next || queueBusy || busy || recorder.recording) return
    setQueueBusy(true)
    setQueue((qs) => qs.map((q) => (q.id === next.id ? { ...q, status: 'processing' } : q)))
    taskApi.reset()
    const ctl = new AbortController()
    abortRef.current = ctl
    // этапы файла из папки видны в общем списке задач, как и у ручного запуска
    runTranscription(
      next.file,
      next.name,
      undefined,
      { phase: () => undefined, status: setStatusText, task: taskApi },
      ctl.signal,
    )
      .then(({ res, language }) => {
        pushHistory(res, next.name, language, next.file)
        setQueue((qs) => qs.map((q) => (q.id === next.id ? { ...q, status: 'done' } : q)))
      })
      .catch((e: unknown) => {
        const cancelled = isAbort(e) || ctl.signal.aborted
        if (cancelled) taskApi.cancelRunning()
        else taskApi.failRunning()
        const msg = cancelled ? t('task.cancelled') : e instanceof Error ? e.message : String(e)
        setQueue((qs) => qs.map((q) => (q.id === next.id ? { ...q, status: 'error', error: msg } : q)))
      })
      .finally(() => {
        if (abortRef.current === ctl) abortRef.current = null
        setStatusText('')
        setQueueBusy(false)
      })
  }, [queue, queueBusy, busy, recorder.recording, runTranscription, pushHistory, taskApi])

  const folder = useFolderWatch(
    useCallback((file: File) => {
      setQueue((qs) => [
        ...qs,
        { id: crypto.randomUUID(), name: file.name, file, status: 'pending' },
      ])
    }, []),
  )

  const clearAll = useCallback(() => {
    setAudio(null)
    doc.reset()
    setError(null)
    setPhase('idle')
    setFlyout(null)
    taskApi.reset()
  }, [taskApi, doc])

  const openHistory = useCallback(
    (item: HistoryItem) => {
      setError(null)
      setFlyout(null)
      setResultName(item.sourceName)
      doc.reset(item.id)
      if (item.text) {
        void doc.open(item)
        setPhase('done')
      } else {
        setPhase('idle')
      }
      // подтягиваем сохранённое аудио, чтобы можно было распознать/переслушать
      if (item.hasAudio) {
        taskApi.reset()
        void (async () => {
          const blob = await getAudio(item.id)
          if (!blob) return
          const base = { blob, name: item.sourceName, historyId: item.id }
          try {
            // если файл изначально требовал конвертации — берём готовый WAV,
            // повторный прогон ffmpeg.wasm не нужен
            const wav = await getConvertedWav(item.id)
            if (wav) {
              setAudio({ ...base, decoded: await decodeAudio(wav), decodeError: null })
            } else {
              const { decoded, wav: freshWav } = await decodeSmart(blob, item.sourceName, {
                phase: setPhase,
                status: setStatusText,
                task: taskApi,
              })
              // впервые открыли старую запись — докладываем WAV на будущее
              if (freshWav) void saveConvertedWav(item.id, freshWav)
              setAudio({ ...base, decoded, decodeError: null })
            }
          } catch {
            setAudio({ ...base, decoded: null, decodeError: t('src.decodeFailedShort') })
          } finally {
            // decodeSmart мог перевести фазу в «загрузка» — возвращаем как было
            setPhase(item.text ? 'done' : 'idle')
            setStatusText('')
          }
        })()
      } else {
        setAudio(null)
      }
    },
    [decodeSmart, taskApi, doc],
  )

  const removeHistoryEntry = useCallback(
    (id: string) => {
      void deleteAudio(id)
      setHistory(removeHistory(id))
      // удалили открытую запись — возвращаемся на стартовый экран
      if (audio?.historyId === id) clearAll()
    },
    [audio?.historyId, clearAll],
  )

  /** Переименование спикера: имя хранится отдельно, сегменты не трогаем. */
  const renameSpeaker = useCallback(
    (speaker: string, name: string) =>
      doc.update((v) => {
        const names = { ...v.speakerNames }
        if (name.trim()) names[speaker] = name.trim()
        else delete names[speaker]
        return { ...v, speakerNames: names }
      }),
    [doc],
  )

  /** Ручное переназначение спикера у реплики (если диаризация ошиблась). */
  const reassignSegment = useCallback(
    (index: number, speaker: string) =>
      doc.update((v) => ({
        ...v,
        segments: v.segments.map((s, i) => (i === index ? { ...s, speaker } : s)),
      })),
    [doc],
  )

  /** Объединить двух спикеров в расшифровке. */
  const mergeSpeakersInDoc = useCallback(
    (from: string, into: string) =>
      doc.update((v) => ({
        ...v,
        segments: mergeSpeakers(v.segments, from, into),
        speakerNames: mergeSpeakerNames(v.speakerNames, from, into),
      })),
    [doc],
  )

  /** Разделить длинную реплику: вторая часть — другому (или новому) спикеру. */
  const splitInDoc = useCallback(
    (index: number, offset: number, speaker: string) =>
      doc.update((v) => {
        const sp = speaker === NEW_SPEAKER ? nextSpeakerId(v.segments) : speaker
        const segments = splitSegment(v.segments, index, offset, sp)
        return segments === v.segments ? v : { ...v, segments }
      }),
    [doc],
  )

  const joinInDoc = useCallback(
    (index: number) =>
      doc.update((v) => {
        const segments = joinWithPrevious(v.segments, index)
        return segments === v.segments ? v : { ...v, segments }
      }),
    [doc],
  )

  /** Результат LLM — новая версия расшифровки (исходная остаётся). */
  const applyAi = useCallback(
    (a: AiApply) => {
      const base = doc.active
      if (!base) return
      doc.addVersion({
        kind: 'llm',
        label: a.label,
        parentId: base.id,
        text: a.text,
        segments: a.segments,
        speakerNames: { ...base.speakerNames, ...a.newNames },
        language: base.language,
        durationSec: base.durationSec,
        elapsedSec: base.elapsedSec,
        engineLabel: base.engineLabel,
        modelLabel: a.model || base.modelLabel,
      })
    },
    [doc],
  )

  /** Правка текста реплики; время и спикер не меняются. */
  const editSegment = useCallback(
    (index: number, text: string) =>
      doc.update((v) => {
        const segments = v.segments.map((s, i) => (i === index ? { ...s, text } : s))
        return { ...v, segments, text: plainText(segments) }
      }),
    [doc],
  )

  const duplicateVersion = useCallback(() => {
    const base = doc.active
    if (!base) return
    doc.addVersion({
      kind: 'edit',
      label: base.label,
      parentId: base.id,
      text: base.text,
      segments: base.segments,
      speakerNames: base.speakerNames,
      language: base.language,
      durationSec: base.durationSec,
      elapsedSec: base.elapsedSec,
      engineLabel: base.engineLabel,
      modelLabel: base.modelLabel,
    })
  }, [doc])

  // доля скачивания модели — для полосы на волне
  const loadFraction =
    modelJob && modelJob.status === 'running' && modelJob.total > 0
      ? modelJob.loaded / modelJob.total
      : undefined

  const cloudReady = customAsr ? true : keys[cloudModel.provider].length > 8
  const canRun =
    !!audio &&
    !busy &&
    !queueBusy &&
    !recorder.recording &&
    (settings.mode === 'local' ? !audio.decodeError : cloudReady)

  const headerStatus = recorder.recording
    ? 'rec'
    : phase === 'loading-model'
      ? 'load'
      : phase === 'transcribing'
        ? 'proc'
        : 'idle'

  const waveLevels = recorder.recording
    ? recorder.levels
    : audio?.decoded
      ? audio.decoded.peaks
      : EMPTY_LEVELS

  const startRec = useCallback(
    (source: RecordSource) => void recorder.start(source),
    [recorder],
  )

  /** Выбор файла → модальное подтверждение → загрузка. */
  const requestFile = useCallback((f: File) => {
    setPendingFile(f)
  }, [])

  const confirmFile = useCallback(() => {
    if (!pendingFile) return
    void ingestBlob(pendingFile, pendingFile.name)
  }, [pendingFile, ingestBlob])

  const cancelFile = useCallback(() => {
    if (!fileLoading) setPendingFile(null)
  }, [fileLoading])

  const stage: 'start' | 'prepare' | 'work' = recorder.recording
    ? 'prepare'
    : result || busy || error
      ? 'work'
      : audio || fileLoading
        ? 'prepare'
        : 'start'

  const sourcePanel = (
    <SourcePanel
      fileName={audio?.name ?? null}
      fileSize={audio ? audio.blob.size : null}
      durationSec={audio?.decoded?.durationSec ?? null}
      decodeError={audio?.decodeError ?? null}
      recording={recorder.recording}
      recSource={recorder.source}
      recElapsed={recorder.elapsed}
      recError={recorder.error}
      recPreview={recorder.preview}
      media={
        stage === 'prepare' && mediaUrl && audio
          ? { url: mediaUrl, kind: audio.blob.type.startsWith('video') ? 'video' : 'audio' }
          : null
      }
      micMixed={recorder.micMixed}
      busy={busy || queueBusy}
      silenceStop={settings.silenceStop}
      folder={{
        supported: folder.supported,
        folderName: folder.folderName,
        watching: folder.watching,
        error: folder.error,
      }}
      queue={queue}
      fileLoading={fileLoading}
      onFile={requestFile}
      onStartRec={startRec}
      onStopRec={recorder.stop}
      onClear={clearAll}
      onToggleSilence={() => setSettings((s) => ({ ...s, silenceStop: !s.silenceStop }))}
      onPickFolder={() => void folder.pick()}
      onStopFolder={folder.stop}
      onClearQueueFinished={() =>
        setQueue((qs) => qs.filter((q) => q.status === 'pending' || q.status === 'processing'))
      }
    />
  )

  const enginePanel = (
    <EnginePanel
      settings={settings}
      keys={keys}
      endpoints={endpoints}
      hasWebGPU={hasWebGPU()}
      decodeFailed={!!audio?.decodeError}
      busy={busy || queueBusy}
      glossaries={glossaries}
      onSettings={setSettings}
      onKeys={setKeys}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  )

  const historyPanel = (
    <HistoryPanel
      items={history}
      onOpen={openHistory}
      onRemove={removeHistoryEntry}
      onProjects={() => setProjectsOpen(true)}
    />
  )

  /** Запуск: кнопки, статус, список задач, ошибка. */
  const runBar = (compact: boolean) => (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void transcribe()}
          disabled={!canRun}
          className="btn-console px-6 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] font-semibold hover:brightness-110 active:scale-[0.98] disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:brightness-100"
        >
          <Play className="size-4" aria-hidden="true" />
          {tr('main.transcribe')}
        </button>

        {(busy || queueBusy) && (
          <button
            type="button"
            onClick={cancelTranscription}
            className="btn-console px-4 border bg-[hsl(var(--err)/0.1)] border-[hsl(var(--err)/0.5)] text-[hsl(var(--err))] hover:bg-[hsl(var(--err)/0.18)]"
          >
            <Square className="size-3.5" aria-hidden="true" />
            {tr('common.cancel')}
          </button>
        )}

        {busy && (
          <span className="font-mono text-[12px] tabular-nums" style={{ color: 'hsl(var(--primary))' }}>
            {statusText} · {formatDurationShort(elapsed)}
          </span>
        )}
        {compact && busy && result && (
          <div className="flex-1 min-w-[120px]">{wave(24, true)}</div>
        )}
        {phase === 'loading-model' && loadFraction !== undefined && (
          <span className="font-mono text-[12px] tabular-nums" style={{ color: 'hsl(var(--warn))' }}>
            {Math.floor(loadFraction * 100)}%
          </span>
        )}
        {queueBusy && !busy && (
          <span className="font-mono text-[12px]" style={{ color: 'hsl(var(--warn))' }}>
            {tr('main.queueBusy')}
            {statusText ? ` · ${statusText}` : ''}
          </span>
        )}
        {!busy && !queueBusy && !audio && (
          <span className="text-sm text-muted-foreground">{tr('main.hint')}</span>
        )}
        {!busy && audio && settings.mode === 'cloud' && !cloudReady && (
          <span className="text-sm" style={{ color: 'hsl(var(--warn))' }}>
            {tr('main.needKey', { provider: PROVIDER_INFO[cloudModel.provider].label })}
          </span>
        )}
      </div>

      {compact && result ? (
        busy && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{tr('run.details')}</summary>
            <div className="mt-2">
              <TaskList tasks={tasks} />
            </div>
          </details>
        )
      ) : (
        <TaskList tasks={tasks} />
      )}

      {error && (
        <div
          role="alert"
          className="border-l-2 bg-[hsl(var(--err)/0.08)] px-3 py-2.5 flex items-start gap-2.5 rounded-r-lg"
          style={{ borderColor: 'hsl(var(--err))' }}
        >
          <AlertTriangle
            className="size-4 mt-0.5 shrink-0"
            style={{ color: 'hsl(var(--err))' }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm text-foreground/90 break-words">{error}</p>
            <button
              type="button"
              onClick={() => void transcribe()}
              className="btn-console !min-h-8 mt-1.5 px-2 hover:text-foreground"
              style={{ color: 'hsl(var(--primary))' }}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {tr('common.retry')}
            </button>
          </div>
        </div>
      )}
    </div>
  )

  const wave = (height: number, bare = false) => (
    <div className={`${bare ? '' : 'panel-inset px-3 py-2'} ${phase === 'transcribing' ? 'scanline-active' : ''}`}>
      <Waveform
        levels={waveLevels}
        live={recorder.recording}
        progress={phase === 'loading-model' ? (loadFraction ?? 0) : undefined}
        height={height}
      />
    </div>
  )

  const showAi = !!result && phase === 'done' && !busy
  const expanded = mediaExpanded && showAi
  const llmOpen = aiExpanded && showAi && aiActive

  // Связанная прокрутка: расшифровка и результат LLM едут к одному и тому же таймкоду.
  useEffect(() => {
    if (!syncOn) return
    let off: (() => void) | null = null
    const timer = window.setTimeout(() => {
      const a = document.querySelector<HTMLElement>('[data-sync="transcript"]')
      const b = document.querySelector<HTMLElement>('[data-sync="llm"]')
      if (!a || !b) return
      let lock = false
      const link = (src: HTMLElement, dst: HTMLElement) => () => {
        if (lock) return
        const rows = Array.from(src.children) as HTMLElement[]
        const first = rows.find((r) => r.offsetTop + r.offsetHeight > src.scrollTop)
        if (!first) return
        const start = Number(first.dataset.start)
        const frac = Math.max(0, Math.min(1, (src.scrollTop - first.offsetTop) / (first.offsetHeight || 1)))
        const targets = Array.from(dst.children) as HTMLElement[]
        let t = targets[0]
        for (const r of targets) if (Number(r.dataset.start) <= start) t = r
        if (!t) return
        lock = true
        dst.scrollTop = t.offsetTop + frac * t.offsetHeight
        window.setTimeout(() => (lock = false), 90)
      }
      const ab = link(a, b)
      const ba = link(b, a)
      a.addEventListener('scroll', ab, { passive: true })
      b.addEventListener('scroll', ba, { passive: true })
      off = () => {
        a.removeEventListener('scroll', ab)
        b.removeEventListener('scroll', ba)
      }
    }, 0)
    return () => {
      window.clearTimeout(timer)
      off?.()
    }
  }, [syncOn, aiActive, llmOpen, doc.activeId, phase])
  const activeVersionNo = doc.activeId ? versionNumber(doc.versions, doc.activeId) : 1

  return (
    <div className={`flex flex-col min-h-dvh ${stage === 'work' ? 'lg:h-dvh lg:overflow-hidden' : ''}`}>
      <Header
        status={headerStatus}
        mode={settings.mode}
        deviceLabel={localDeviceLabel()}
        theme={settings.theme}
        onTheme={(theme) => setSettings((s) => ({ ...s, theme, themeChosen: true }))}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        glossaries={glossaries}
        endpoints={endpoints}
        onSettings={setSettings}
        onGlossaries={setGlossaries}
        onEndpoints={setEndpoints}
      />
      <FileConfirmModal
        file={pendingFile}
        loading={fileLoading}
        loadingText={statusText || undefined}
        onConfirm={confirmFile}
        onCancel={cancelFile}
      />
      {projectsOpen && (
        <ProjectsModal
          items={history}
          currentId={audio?.historyId ?? null}
          onClose={() => setProjectsOpen(false)}
          onImported={setHistory}
        />
      )}

      {stage !== 'work' ? (
        // Старт и подготовка: всё по центру, блоки появляются по шагам — Источник → Движок → Запуск
        <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-6 flex flex-col gap-4 min-w-0">
          {stage === 'start' && (
            <h1 className="text-center text-xl md:text-2xl font-semibold tracking-tight pt-2 pb-1">
              {tr('start.title')}
              <span className="block text-sm font-normal text-muted-foreground mt-1">
                {tr('start.subtitle')}
              </span>
            </h1>
          )}
          {sourcePanel}
          {stage === 'prepare' && (
            <>
              {enginePanel}
              <section className="panel p-4 flex flex-col gap-4" aria-label={tr('main.aria')}>
                {wave(72)}
                {runBar(false)}
              </section>
            </>
          )}
          {stage === 'start' && (
            <div className="grid gap-4 md:grid-cols-2 items-start">
              {historyPanel}
              <StoragePanel />
            </div>
          )}
        </main>
      ) : (
        // Работа с расшифровкой: рейка | слева видео + AI | справа расшифровка почти на всю высоту
        <main className="flex-1 min-h-0 w-full max-w-[1760px] mx-auto px-4 py-4 grid gap-4 grid-cols-1 lg:grid-cols-[56px_minmax(0,1fr)_minmax(0,1fr)] lg:overflow-hidden">
          <Rail
            open={flyout}
            onOpen={setFlyout}
            onNew={clearAll}
            onProjects={() => setProjectsOpen(true)}
            busy={busy}
            flyout={
              flyout === 'source'
                ? sourcePanel
                : flyout === 'engine'
                  ? enginePanel
                  : flyout === 'history'
                    ? historyPanel
                    : flyout === 'storage'
                      ? <StoragePanel />
                      : null
            }
          />

          <div className="flex flex-col gap-3 min-w-0 min-h-0 lg:h-full lg:overflow-y-auto">
            <section className="panel p-3 shrink-0" aria-label={tr('main.aria')}>
              {runBar(true)}
            </section>

            {result && audio && (
              <section className={`panel p-3 shrink-0 ${llmOpen ? 'lg:hidden' : ''}`}>
                <MediaPane
                  blob={audio.blob}
                  sourceName={resultName}
                  segments={result.segments}
                  speakerNames={speakerNames}
                  durationSec={result.durationSec}
                  playerRef={playerRef}
                  onState={setPlayerState}
                  videoMaxHeight={expanded ? 'calc(100dvh - 300px)' : aiActive ? '24vh' : '38vh'}
                  extra={
                    showAi ? (
                      <button
                        type="button"
                        onClick={() => setMediaExpanded((v) => !v)}
                        aria-pressed={expanded}
                        title={expanded ? tr('media.shrink') : tr('media.expand')}
                        aria-label={expanded ? tr('media.shrink') : tr('media.expand')}
                        className="hidden lg:inline-flex size-8 shrink-0 items-center justify-center rounded-md cursor-pointer text-muted-foreground hover:text-foreground"
                      >
                        {expanded ? <Minimize2 className="size-4" aria-hidden="true" /> : <Maximize2 className="size-4" aria-hidden="true" />}
                      </button>
                    ) : null
                  }
                />
              </section>
            )}

            {!expanded && (
              <div className="min-h-[320px] lg:min-h-0 lg:flex-1">
                {showAi && result ? (
                  <AiPanel
                    fill
                    result={result}
                    speakerNames={speakerNames}
                    versionNumber={activeVersionNo}
                    onApply={applyAi}
                    onActive={setAiActive}
                    expanded={llmOpen}
                    onToggleExpand={() => setAiExpanded((v) => !v)}
                    syncOn={syncOn}
                    onToggleSync={() => setSyncOn((v) => !v)}
                    keys={keys}
                    settings={settings}
                    glossaries={glossaries}
                    endpoints={endpoints}
                    taskApi={taskApi}
                  />
                ) : (
                  <section className="panel p-4 text-sm text-muted-foreground h-full min-h-[120px] flex items-center justify-center text-center">
                    {tr('ai.placeholder')}
                  </section>
                )}
              </div>
            )}
          </div>

          <section
            className="panel p-3 md:p-4 flex flex-col gap-3 min-w-0 min-h-[70dvh] lg:min-h-0 lg:h-full"
            aria-label={tr('main.aria')}
          >
            {!result ? (
              <>
                {wave(72)}
                <TaskList tasks={tasks} />
              </>
            ) : (
              <div
                className={`flex-1 min-h-0 ${
                  busy
                    ? 'opacity-40 saturate-50 pointer-events-none transition-opacity duration-300'
                    : 'transition-opacity duration-300'
                }`}
                aria-busy={busy}
              >
                <TranscriptView
                  fill
                  result={result}
                  sourceName={resultName}
                  hasMedia={!!audio?.blob}
                  playerRef={playerRef}
                  playerState={playerState}
                  speakerNames={speakerNames}
                  versions={doc.versions}
                  activeVersionId={doc.activeId}
                  onSelectVersion={doc.select}
                  onDuplicateVersion={duplicateVersion}
                  onDeleteVersion={doc.remove}
                  onRenameSpeaker={renameSpeaker}
                  onReassignSegment={reassignSegment}
                  onMergeSpeakers={mergeSpeakersInDoc}
                  onSplitSegment={splitInDoc}
                  onJoinPrevious={joinInDoc}
                  onEditSegment={editSegment}
                />
              </div>
            )}
          </section>
        </main>
      )}

      <footer
        className={`hairline-b border-b-0 border-t border-[hsl(var(--border))] mt-auto ${stage === 'work' ? 'lg:hidden' : ''}`}
      >
        <div className="max-w-[1560px] mx-auto px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px] font-mono text-muted-foreground">
          <span>
            STENO v{__APP_VERSION__} · {tr('foot.tagline')}
          </span>
          <span>{tr('foot.engines')}</span>
          <span>{tr('foot.credits')}</span>
          <span>{tr('foot.privacy')}</span>
        </div>
      </footer>
    </div>
  )
}
