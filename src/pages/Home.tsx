import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Play, RotateCcw } from 'lucide-react'
import { Header } from '@/sections/Header'
import { SourcePanel } from '@/sections/SourcePanel'
import { EnginePanel } from '@/sections/EnginePanel'
import { TranscriptView } from '@/sections/TranscriptView'
import { AiPanel } from '@/sections/AiPanel'
import { HistoryPanel, StoragePanel } from '@/sections/Panels'
import { SettingsModal } from '@/sections/SettingsModal'
import { FileConfirmModal } from '@/sections/FileConfirmModal'
import { TaskList } from '@/sections/TaskList'
import type { TaskApi, TaskItem } from '@/lib/tasks'
import { Waveform } from '@/components/Waveform'
import { decodeAudio, formatDurationShort, type DecodedAudio } from '@/lib/audio'
import { decodeWithFfmpeg } from '@/lib/ffmpegDecode'
import { transcribeCloud } from '@/lib/cloudEngines'
import {
  hasWebGPU,
  loadLocalModel,
  localDeviceLabel,
  transcribeLocal,
} from '@/lib/localEngine'
import { assignSpeakers, diarizeLocal, resetDiarizeWorker } from '@/lib/diarize'
import { deleteAudio, getAudio, getConvertedWav, saveAudio, saveConvertedWav } from '@/lib/audioStore'
import { CLOUD_MODELS, LOCAL_MODELS } from '@/lib/models'
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
  updateHistory,
} from '@/lib/storage'
import { useRecorder, type RecordSource } from '@/hooks/useRecorder'
import { useFolderWatch } from '@/hooks/useFolderWatch'
import type { QueueItem, TranscriptResult, TranscribePhase } from '@/types'

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
  load: (file: string, pct: number) => void
  /** список задач с процентами (конвертация/модель/ASR/диаризация) */
  task?: TaskApi
}

const EMPTY_LEVELS = new Array(96).fill(0.04)

export default function Home() {
  const [settings, setSettings] = useState(loadSettings)
  const [keys, setKeys] = useState(loadKeys)
  const [history, setHistory] = useState(loadHistory)
  const [glossaries, setGlossaries] = useState(loadGlossaries)
  const [audio, setAudio] = useState<AudioSource | null>(null)
  const [phase, setPhase] = useState<TranscribePhase>('idle')
  const [statusText, setStatusText] = useState('')
  const [loadFiles, setLoadFiles] = useState<Record<string, number>>({})
  const [result, setResult] = useState<TranscriptResult | null>(null)
  const [resultName, setResultName] = useState('transcript')
  /** переименования спикеров для текущего результата */
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [queueBusy, setQueueBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [tasks, setTasks] = useState<TaskItem[]>([])
  // агрегат скачивания ВСЕХ файлов модели по байтам (событие progress_total):
  // процент один на модель, а не среднее пофайловых процентов
  const [loadTotal, setLoadTotal] = useState<{ model: number | null; dia: number | null }>({
    model: null,
    dia: null,
  })
  const startedRef = useRef(0)

  // единый API списка задач: этапы транскрипции пишет Home, LLM — AiPanel
  const taskApi = useMemo<TaskApi>(
    () => ({
      start: (id, label, detail) =>
        setTasks((ts) => [
          ...ts.filter((t) => t.id !== id),
          { id, label, detail, pct: null, state: 'run' as const },
        ]),
      update: (id, patch) =>
        setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t))),
      done: (id, detail) =>
        setTasks((ts) =>
          ts.map((t) =>
            t.id === id && t.state === 'run' ? { ...t, pct: 100, state: 'done' as const, detail } : t,
          ),
        ),
      fail: (id, detail) =>
        setTasks((ts) =>
          ts.map((t) =>
            t.id === id && t.state === 'run' ? { ...t, state: 'error' as const, detail } : t,
          ),
        ),
      failRunning: () =>
        setTasks((ts) =>
          ts.map((t) => (t.state === 'run' ? { ...t, state: 'error' as const } : t)),
        ),
      reset: () => setTasks([]),
    }),
    [],
  )

  const busy = phase === 'loading-model' || phase === 'transcribing'

  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => saveKeys(keys), [keys])
  useEffect(() => saveGlossaries(glossaries), [glossaries])

  // тема оформления
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // смена режима сбрасывает ошибку предыдущей попытки
  useEffect(() => {
    setError(null)
    if (phase === 'error') setPhase('idle')
  }, [settings.mode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!busy) return
    startedRef.current = Date.now()
    setElapsed(0)
    const t = window.setInterval(
      () => setElapsed((Date.now() - startedRef.current) / 1000),
      500,
    )
    return () => window.clearInterval(t)
  }, [busy])

  const cloudModel = useMemo(
    () => CLOUD_MODELS.find((m) => m.id === settings.cloudModel) ?? CLOUD_MODELS[0],
    [settings.cloudModel],
  )
  const localModel = useMemo(
    () => LOCAL_MODELS.find((m) => m.id === settings.localModel) ?? LOCAL_MODELS[1],
    [settings.localModel],
  )

  /** Нативное декодирование, при неудаче — ffmpeg.wasm (m4a/aac и прочие). */
  const decodeSmart = useCallback(
    async (
      blob: Blob,
      name: string,
      ui?: UiCallbacks,
    ): Promise<{ decoded: DecodedAudio; wav: Blob | null }> => {
      ui?.task?.start('audio', 'Декодирование аудио')
      try {
        const out = await decodeAudio(blob)
        ui?.task?.done('audio')
        return { decoded: out, wav: null }
      } catch {
        ui?.phase('loading-model')
        ui?.status('Браузер не читает формат — конвертирую…')
        ui?.task?.update('audio', { label: 'Конвертация аудио (ffmpeg)', pct: null })
        try {
          const { decoded, wav } = await decodeWithFfmpeg(
            blob,
            name,
            (t) => ui?.status(t),
            (pct) =>
              ui?.task?.update('audio', {
                pct,
                detail: pct === null ? 'загрузка конвертера' : undefined,
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
      setResult(null)
      setSpeakerNames({})
      setError(null)
      setPhase('idle')
      setStatusText('')
      taskApi.reset()
      setLoadFiles({})
      setLoadTotal({ model: null, dia: null })
      setFileLoading(true)
      try {
        const { decoded, wav } = await decodeSmart(blob, name, {
          phase: setPhase,
          status: setStatusText,
          load: (f, p) => setLoadFiles((prev) => ({ ...prev, [f]: p })),
          task: taskApi,
        })
        const id = crypto.randomUUID()
        void saveAudio(id, blob, name)
        // сконвертированный вариант тоже кладём в хранилище: при повторном
        // открытии из истории декодируем WAV нативно, без ffmpeg
        if (wav) void saveConvertedWav(id, wav)
        setHistory(
          addHistory({
            id,
            createdAt: Date.now(),
            sourceName: name,
            engineLabel: 'Файл',
            modelLabel: 'загружен',
            language: '—',
            durationSec: decoded.durationSec,
            elapsedSec: 0,
            text: '',
            segments: [],
            hasAudio: true,
          }),
        )
        setAudio({ blob, name, decoded, decodeError: null, historyId: id })
        setPhase('idle')
        setStatusText('')
        setLoadFiles({})
      } catch {
        setPhase('idle')
        setStatusText('')
        setAudio({
          blob,
          name,
          decoded: null,
          decodeError: 'формат не читается даже после конвертации — доступен только облачный режим',
        })
      } finally {
        setFileLoading(false)
        setPendingFile(null)
      }
    },
    [decodeSmart],
  )

  const recorder = useRecorder(
    useCallback(
      (blob: Blob) => {
        const stamp = new Date().toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
        void ingestBlob(blob, `Запись ${stamp}.webm`)
      },
      [ingestBlob],
    ),
    { silenceStop: settings.silenceStop },
  )

  const pushHistory = useCallback(
    (res: TranscriptResult, sourceName: string, language: string, blob?: Blob) => {
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
    },
    [],
  )

  const runTranscription = useCallback(
    async (
      blob: Blob,
      name: string,
      decodedHint: DecodedAudio | null | undefined,
      ui?: UiCallbacks,
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

      if (settings.mode === 'local') {
        if (!decoded) {
          throw new Error(
            `«${name}»: файл нельзя декодировать в браузере — переключитесь на облачный режим или конвертируйте в wav/mp3`,
          )
        }
        ui?.phase('loading-model')
        ui?.status('Подготовка модели…')
        ui?.task?.start('model', 'Загрузка модели Whisper', localModel.label)
        await loadLocalModel(localModel.hfId, {
          onStatus: (t) => {
            ui?.status(t)
            // зеркалим статус в строку задачи: что в статус-строке, то и в списке
            const dev = t.match(/\(([^)]+)\)/)?.[1] ?? t.replace(/…$/, '')
            ui?.task?.update('model', { detail: dev })
          },
          onLoadProgress: (p) => ui?.load(p.file, p.progress),
          onLoadTotal: (p) => setLoadTotal((t) => ({ ...t, model: p })),
        })
        ui?.task?.done('model')
        ui?.phase('transcribing')
        ui?.status('Распознаём речь…')
        ui?.task?.start('asr', 'Распознавание речи', localModel.label)
        // Диаризация идёт параллельно распознаванию в отдельном worker.
        // Её статусы не показываем (иначе они затирают статус транскрипции),
        // а сбой/зависание не должны ронять или блокировать результат.
        let diaSettled = false
        if (settings.diarize) ui?.task?.start('dia', 'Диаризация (спикеры)')
        const diaPromise = settings.diarize
          ? diarizeLocal(decoded.samples, {
              onLoadProgress: (f, p) => ui?.load(f, p),
              onLoadTotal: (p) => setLoadTotal((t) => ({ ...t, dia: p })),
              onProgress: (p) => ui?.task?.update('dia', { pct: p, detail: 'анализ аудио' }),
            })
              .catch(() => {
                ui?.task?.fail('dia', 'ошибка — пропущена')
                return null
              })
              .then((d) => {
                diaSettled = true
                if (d) ui?.task?.done('dia', d.length ? undefined : 'спикеры не найдены')
                return d
              })
          : Promise.resolve(null)
        const out = await transcribeLocal(
          decoded.samples,
          lang,
          settings.translate ? 'translate' : 'transcribe',
          {
            onStatus: (t) => {
              ui?.status(t)
              ui?.task?.update('asr', { detail: t.replace(/…$/, '') })
            },
            onProgress: (p) => ui?.task?.update('asr', { pct: p }),
          },
          glossHint || undefined,
        )
        ui?.task?.done('asr')
        if (settings.diarize && !diaSettled) ui?.status('Определяем спикеров…')
        // страховка от зависшего WASM-рантайма: ждём диаризацию ограниченно
        const diaTimeoutMs = Math.min(45 * 60_000, 60_000 + decoded.durationSec * 2000)
        const dia = await Promise.race([
          diaPromise,
          new Promise<null>((r) => setTimeout(() => r(null), diaTimeoutMs)),
        ])
        if (!diaSettled) {
          resetDiarizeWorker()
          ui?.task?.fail('dia', 'таймаут — пропущена')
        }
        const segments = dia && dia.length ? assignSpeakers(out.segments, dia) : out.segments
        return {
          language: settings.translate ? 'en' : (lang ?? 'auto'),
          res: {
            text: out.text,
            segments,
            durationSec: decoded.durationSec,
            elapsedSec: out.elapsedSec,
            engineLabel: `Локально · ${localDeviceLabel()}`,
            modelLabel: localModel.label,
          },
        }
      }

      const key = keys[cloudModel.provider]
      if (!key) throw new Error(`Введите API-ключ ${cloudModel.label.split(' ')[0]} в панели движка`)
      ui?.phase('transcribing')
      ui?.status(`Отправляем в ${cloudModel.label}…`)
      // облачный запрос без процента — бегущая полоса до ответа сервера
      ui?.task?.start('asr', `Распознавание речи · ${cloudModel.label}`)
      const out = await transcribeCloud({
        provider: cloudModel.provider,
        apiModel: cloudModel.apiModel,
        apiKey: key,
        file: blob,
        fileName: name,
        language: lang,
        translate: settings.translate && cloudModel.provider !== 'deepgram',
        diarize: settings.diarize && cloudModel.provider === 'deepgram',
        prompt: glossHint || undefined,
      })
      ui?.task?.done('asr')
      // Groq/OpenAI спикеров не возвращают — доразмечаем локально в браузере
      let segments = out.segments
      if (
        settings.diarize &&
        cloudModel.provider !== 'deepgram' &&
        decoded &&
        !segments.some((s) => s.speaker)
      ) {
        try {
          ui?.status('Определяем спикеров локально…')
          ui?.task?.start('dia', 'Диаризация (спикеры)')
          const diaTimeoutMs = Math.min(45 * 60_000, 60_000 + decoded.durationSec * 2000)
          let diaSettled = false
          const dia = await Promise.race([
            diarizeLocal(decoded.samples, {
              onLoadProgress: (f, p) => ui?.load(f, p),
              onLoadTotal: (p) => setLoadTotal((t) => ({ ...t, dia: p })),
              onProgress: (p) => ui?.task?.update('dia', { pct: p, detail: 'анализ аудио' }),
            })
              .catch(() => {
                ui?.task?.fail('dia', 'ошибка — пропущена')
                return null
              })
              .then((d) => {
                diaSettled = true
                return d
              }),
            new Promise<null>((r) => setTimeout(() => r(null), diaTimeoutMs)),
          ])
          if (!diaSettled) {
            resetDiarizeWorker()
            ui?.task?.fail('dia', 'таймаут — пропущена')
          } else {
            ui?.task?.done('dia', dia && dia.length ? undefined : 'спикеры не найдены')
          }
          if (dia && dia.length) segments = assignSpeakers(segments, dia)
        } catch {
          // диаризация — опциональный слой, транскрипт важнее
        }
      }
      return {
        language: out.language ?? settings.language,
        res: {
          text: out.text,
          segments,
          language: out.language,
          durationSec: decoded?.durationSec ?? 0,
          elapsedSec: (performance.now() - t0) / 1000,
          engineLabel: 'Облако',
          modelLabel: cloudModel.label,
        },
      }
    },
    [settings, keys, localModel, cloudModel, decodeSmart, glossaries],
  )

  const transcribe = useCallback(async () => {
    if (!audio) return
    setError(null)
    // старый результат НЕ прячем: он остаётся на экране до готовности нового
    setLoadFiles({})
    setLoadTotal({ model: null, dia: null })
    taskApi.reset()
    try {
      const { res, language } = await runTranscription(audio.blob, audio.name, audio.decoded, {
        phase: setPhase,
        status: setStatusText,
        load: (f, p) => setLoadFiles((prev) => ({ ...prev, [f]: p })),
        task: taskApi,
      })
      setResult(res)
      setSpeakerNames({})
      setResultName(audio.name)
      if (audio.historyId) {
        // файл уже в истории — дополняем его запись транскрипцией
        setHistory(
          updateHistory(audio.historyId, {
            engineLabel: res.engineLabel,
            modelLabel: res.modelLabel,
            language,
            durationSec: res.durationSec,
            elapsedSec: res.elapsedSec,
            text: res.text,
            segments: res.segments,
          }),
        )
      } else {
        pushHistory(res, audio.name, language, audio.blob)
      }
      setPhase('done')
    } catch (e) {
      taskApi.failRunning()
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [audio, runTranscription, pushHistory, taskApi])

  // очередь из отслеживаемой папки: по одному файлу, пока свободны
  useEffect(() => {
    const next = queue.find((q) => q.status === 'pending')
    if (!next || queueBusy || busy || recorder.recording) return
    setQueueBusy(true)
    setQueue((qs) => qs.map((q) => (q.id === next.id ? { ...q, status: 'processing' } : q)))
    runTranscription(next.file, next.name, undefined)
      .then(({ res, language }) => {
        pushHistory(res, next.name, language, next.file)
        setQueue((qs) => qs.map((q) => (q.id === next.id ? { ...q, status: 'done' } : q)))
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        setQueue((qs) => qs.map((q) => (q.id === next.id ? { ...q, status: 'error', error: msg } : q)))
      })
      .finally(() => setQueueBusy(false))
  }, [queue, queueBusy, busy, recorder.recording, runTranscription, pushHistory])

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
    setResult(null)
    setSpeakerNames({})
    setError(null)
    setPhase('idle')
    setLoadFiles({})
    setLoadTotal({ model: null, dia: null })
    taskApi.reset()
  }, [taskApi])

  const openHistory = useCallback(
    (item: (typeof history)[number]) => {
      setError(null)
      setResultName(item.sourceName)
      setSpeakerNames(item.speakerNames ?? {})
      if (item.text) {
        setResult({
          text: item.text,
          segments: item.segments,
          durationSec: item.durationSec,
          elapsedSec: item.elapsedSec,
          engineLabel: item.engineLabel,
          modelLabel: item.modelLabel,
        })
        setPhase('done')
      } else {
        setResult(null)
        setPhase('idle')
      }
      // подтягиваем сохранённое аудио, чтобы можно было распознать/переслушать
      if (item.hasAudio) {
        taskApi.reset()
        setLoadFiles({})
        setLoadTotal({ model: null, dia: null })
        void (async () => {
          const blob = await getAudio(item.id)
          if (!blob) return
          try {
            // если файл изначально требовал конвертации — берём готовый WAV,
            // повторный прогон ffmpeg.wasm не нужен
            const wav = await getConvertedWav(item.id)
            if (wav) {
              const decoded = await decodeAudio(wav)
              setAudio({
                blob,
                name: item.sourceName,
                decoded,
                decodeError: null,
                historyId: item.id,
              })
            } else {
              const { decoded, wav: freshWav } = await decodeSmart(blob, item.sourceName, {
                phase: setPhase,
                status: setStatusText,
                load: (f, p) => setLoadFiles((prev) => ({ ...prev, [f]: p })),
                task: taskApi,
              })
              // впервые открыли старую запись — докладываем WAV на будущее
              if (freshWav) void saveConvertedWav(item.id, freshWav)
              setAudio({
                blob,
                name: item.sourceName,
                decoded,
                decodeError: null,
                historyId: item.id,
              })
            }
          } catch {
            setAudio({
              blob,
              name: item.sourceName,
              decoded: null,
              decodeError: 'формат не читается локально',
              historyId: item.id,
            })
          } finally {
            if (!item.text) {
              setPhase('idle')
              setStatusText('')
            }
            setLoadFiles({})
          }
        })()
      } else {
        setAudio(null)
      }
    },
    [decodeSmart, taskApi],
  )

  const removeHistoryEntry = useCallback((id: string) => {
    void deleteAudio(id)
    setHistory(removeHistory(id))
  }, [])

  /** Переименование спикера: имя хранится отдельно, сегменты не трогаем. */
  const renameSpeaker = useCallback(
    (speaker: string, name: string) => {
      setSpeakerNames((prev) => {
        const next = { ...prev }
        if (name.trim()) next[speaker] = name.trim()
        else delete next[speaker]
        if (audio?.historyId) setHistory(updateHistory(audio.historyId, { speakerNames: next }))
        return next
      })
    },
    [audio?.historyId],
  )

  /** Ручное переназначение спикера у реплики (если диаризация ошиблась). */
  const reassignSegment = useCallback(
    (index: number, speaker: string) => {
      setResult((r) => {
        if (!r) return r
        const segments = r.segments.map((s, i) => (i === index ? { ...s, speaker } : s))
        if (audio?.historyId) setHistory(updateHistory(audio.historyId, { segments }))
        return { ...r, segments }
      })
    },
    [audio?.historyId],
  )

  // общий процент для волны/статуса: агрегат по байтам, иначе пофайловое среднее
  const loadAggregate = useMemo(() => {
    if (loadTotal.model !== null) return loadTotal.model
    if (loadTotal.dia !== null) return loadTotal.dia
    const vals = Object.values(loadFiles)
    if (vals.length === 0) return 0
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
  }, [loadFiles, loadTotal])

  // Средний процент скачивания моделей по этапам: whisper-файлы без префикса,
  // диаризация — «diarize:…», локальная LLM — «ai:…».
  const loadByTask = useMemo(() => {
    const groups: Record<'model' | 'dia' | 'ai', number[]> = { model: [], dia: [], ai: [] }
    for (const [f, p] of Object.entries(loadFiles)) {
      if (f.startsWith('diarize:')) groups.dia.push(p)
      else if (f.startsWith('ai:')) groups.ai.push(p)
      else groups.model.push(p)
    }
    const avg = (a: number[]) =>
      a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null
    return { model: avg(groups.model), dia: avg(groups.dia), ai: avg(groups.ai) }
  }, [loadFiles])

  // Зеркалируем прогресс скачивания в задачи. Если строки нет (например,
  // список сбросили посреди загрузки) — создаём её: качается модель =
  // должна быть видна в списке. Приоритет — агрегат по байтам всех файлов
  // (progress_total), пофайловое среднее — только как запасной вариант.
  // Диаризацию в фазе «анализ аудио» не трогаем.
  useEffect(() => {
    setTasks((ts) => {
      let next = ts
      const apply = (
        id: string,
        label: string,
        pct: number | null,
        detail: string,
        keepDetail?: string,
      ) => {
        if (pct === null) return
        const row = next.find((t) => t.id === id)
        if (row) {
          if (row.state !== 'run') return
          if (keepDetail && row.detail === keepDetail) return
          if (row.pct === pct && row.detail === detail) return
          next = next.map((t) => (t.id === id ? { ...t, pct, detail } : t))
        } else {
          next = [...next, { id, label, pct, detail, state: 'run' as const }]
        }
      }
      apply('model', 'Загрузка модели Whisper', loadTotal.model ?? loadByTask.model, 'скачивание файлов')
      apply('dia', 'Диаризация (спикеры)', loadTotal.dia ?? loadByTask.dia, 'загрузка моделей', 'анализ аудио')
      return next
    })
  }, [loadByTask, loadTotal, tasks])

  const canRun =
    !!audio &&
    !busy &&
    !queueBusy &&
    !recorder.recording &&
    (settings.mode === 'local'
      ? !audio.decodeError
      : keys[cloudModel.provider].length > 8)

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

  return (
    <div className="min-h-100dvh flex flex-col">
      <Header
        status={headerStatus}
        mode={settings.mode}
        deviceLabel={localDeviceLabel()}
        theme={settings.theme}
        onTheme={(theme) => setSettings((s) => ({ ...s, theme }))}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        glossaries={glossaries}
        onSettings={setSettings}
        onGlossaries={setGlossaries}
        taskApi={taskApi}
      />
      <FileConfirmModal
        file={pendingFile}
        loading={fileLoading}
        loadingText={statusText || undefined}
        onConfirm={confirmFile}
        onCancel={cancelFile}
      />

      <main className="flex-1 w-full max-w-[1560px] mx-auto px-4 py-4 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)_330px] items-start">
        {/* Левая колонка */}
        <div className="flex flex-col gap-4 min-w-0">
          <SourcePanel
            fileName={audio?.name ?? null}
            fileSize={audio ? audio.blob.size : null}
            durationSec={audio?.decoded?.durationSec ?? null}
            decodeError={audio?.decodeError ?? null}
            recording={recorder.recording}
            recSource={recorder.source}
            recElapsed={recorder.elapsed}
            recError={recorder.error}
            micMixed={recorder.micMixed}
            busy={busy}
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
          <EnginePanel
            settings={settings}
            keys={keys}
            hasWebGPU={hasWebGPU()}
            decodeFailed={!!audio?.decodeError}
            busy={busy}
            glossaries={glossaries}
            onSettings={setSettings}
            onKeys={setKeys}
          />
        </div>

        {/* Центр: волна + запуск + результат + AI */}
        <div className="flex flex-col gap-4 min-w-0">
          <section className="panel p-4 md:p-5 flex flex-col gap-4" aria-label="Транскрипция">
            <div
              className={`panel-inset px-3 py-2 ${phase === 'transcribing' ? 'scanline-active' : ''}`}
            >
              <Waveform
                levels={waveLevels}
                live={recorder.recording}
                progress={phase === 'loading-model' ? loadAggregate / 100 : undefined}
                height={96}
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void transcribe()}
                disabled={!canRun}
                className="btn-console px-6 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] font-semibold hover:brightness-110 active:scale-[0.98] disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:brightness-100"
              >
                <Play className="size-4" aria-hidden="true" />
                Распознать
              </button>

              {busy && (
                <span
                  className="font-mono text-[12px] tabular-nums"
                  style={{ color: 'hsl(var(--primary))' }}
                >
                  {statusText} · {formatDurationShort(elapsed)}
                </span>
              )}
              {phase === 'loading-model' && (
                <span
                  className="font-mono text-[12px] tabular-nums"
                  style={{ color: 'hsl(var(--warn))' }}
                >
                  {loadAggregate}%
                </span>
              )}
              {queueBusy && !busy && (
                <span className="font-mono text-[12px]" style={{ color: 'hsl(var(--warn))' }}>
                  обрабатываю очередь из папки…
                </span>
              )}
              {!busy && !audio && (
                <span className="text-sm text-muted-foreground">
                  Загрузите файл, запишите голос или звук вкладки — затем «Распознать»
                </span>
              )}
              {!busy &&
                audio &&
                settings.mode === 'cloud' &&
                keys[cloudModel.provider].length <= 8 && (
                  <span className="text-sm" style={{ color: 'hsl(var(--warn))' }}>
                    Осталось ввести API-ключ {cloudModel.label.split(' ')[0]} слева
                  </span>
                )}
            </div>

            <TaskList tasks={tasks} />

            {error && (
              <div
                role="alert"
                className="border-l-2 bg-[hsl(var(--err)/0.08)] px-3 py-2.5 flex items-start gap-2.5"
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
                    Повторить
                  </button>
                </div>
              </div>
            )}

            {result && (phase === 'done' || busy) && (
              <div
                className={
                  busy
                    ? 'opacity-40 saturate-50 pointer-events-none transition-opacity duration-300'
                    : 'transition-opacity duration-300'
                }
                aria-busy={busy}
              >
                <TranscriptView
                  result={result}
                  sourceName={resultName}
                  audioBlob={audio?.blob ?? null}
                  speakerNames={speakerNames}
                  onRenameSpeaker={renameSpeaker}
                  onReassignSegment={reassignSegment}
                />
              </div>
            )}
          </section>

          {result && phase === 'done' && !busy && (
            <AiPanel
              sourceText={result.text}
              keys={keys}
              settings={settings}
              glossaries={glossaries}
              taskApi={taskApi}
            />
          )}
        </div>

        {/* Правая колонка */}
        <div className="flex flex-col gap-4 min-w-0">
          <StoragePanel />
          <HistoryPanel items={history} onOpen={openHistory} onRemove={removeHistoryEntry} />
        </div>
      </main>

      <footer className="hairline-b border-b-0 border-t border-[hsl(var(--border))] mt-auto">
        <div className="max-w-[1560px] mx-auto px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px] font-mono text-muted-foreground">
          <span>STENO v{__APP_VERSION__} · распознавание речи: локально и в облаке</span>
          <span>локально: Whisper + диаризация + AI на устройстве · облако: OpenAI / Groq / Deepgram</span>
          <span>спикеры: pyannote segmentation (MIT) + WeSpeaker ResNet34 (CC-BY-4.0)</span>
          <span>ключи, файлы и история — только в этом браузере</span>
        </div>
      </footer>
    </div>
  )
}
