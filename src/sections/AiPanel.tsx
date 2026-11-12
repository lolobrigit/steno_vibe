import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, Layers, Loader2, Sparkles, Square } from 'lucide-react'
import { AI_ACTIONS } from '@/lib/models'
import { aiProviderLabel, runAiPrompt, type AiProvider, AI_PROVIDERS, LLM_CLOUD_MODELS } from '@/lib/ai'
import { customChat, type CustomEndpoint } from '@/lib/customEndpoints'
import { llmJobId, runLocalAi } from '@/lib/localAi'
import { deviceLabel } from '@/lib/localEngine'
import { isAbort } from '@/lib/gpu'
import { formatBytes } from '@/lib/audio'
import { useDownloads } from '@/hooks/useDownloads'
import { speakerLabel, useT } from '@/i18n'
import type { TaskApi } from '@/lib/tasks'
import type { Segment, TranscriptResult } from '@/types'
import {
  formatRules,
  nameMap,
  parseDialog,
  plainText,
  speakersOf,
  toDialog,
} from '@/lib/transcript'
import {
  glossaryPromptText,
  loadLlmButtons,
  loadLlmModel,
  saveLlmModel,
  LLM_MODELS,
  type ApiKeys,
  type AppSettings,
  type Glossary,
  type LlmButton,
} from '@/lib/storage'

/** Результат LLM, который пользователь сохраняет новой версией расшифровки. */
export interface AiApply {
  text: string
  /** пусто — «плоская» версия: ответ не в формате расшифровки */
  segments: Segment[]
  /** спикеры, которых LLM добавил или переименовал */
  newNames: Record<string, string>
  label: string
  model: string
}

interface AiPanelProps {
  /** показанная версия расшифровки: с ней и работает LLM */
  result: TranscriptResult
  speakerNames: Record<string, string>
  /** номер версии в списке — подпись «работаем с версией N» */
  versionNumber: number
  onApply: (a: AiApply) => void
  /** занять всю высоту колонки и прокручиваться внутри */
  fill?: boolean
  /** идёт обработка или есть результат — Home сужает видео */
  onActive?: (active: boolean) => void
  keys: ApiKeys
  settings: AppSettings
  glossaries: Glossary[]
  /** свои OpenAI-совместимые сервисы с выбранными текстовыми моделями */
  endpoints: CustomEndpoint[]
  /** общий список задач в панели транскрипции — LLM-этап пишется туда */
  taskApi?: TaskApi
}

/** 'local' | 'groq' | 'openai' | 'ep:<id>' (свой сервис) */
type ProviderTab = string

const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim()

export function AiPanel({
  result,
  speakerNames,
  versionNumber,
  onApply,
  fill = false,
  onActive,
  keys,
  settings,
  glossaries,
  endpoints,
  taskApi,
}: AiPanelProps) {
  const t = useT()
  const hasKey = (p: AiProvider) => keys[p].length > 8
  const llmEndpoints = endpoints.filter((e) => e.models.some((m) => m.kind === 'llm'))
  const [providerState, setProvider] = useState<ProviderTab>('local')
  const [localModelId, setLocalModelIdState] = useState(loadLlmModel)
  /** выбранная модель по вкладке провайдера */
  const [modelByTab, setModelByTab] = useState<Record<string, string>>({})
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [statusText, setStatusText] = useState('')
  const [output, setOutput] = useState<string | null>(null)
  const [outputFrom, setOutputFrom] = useState('')
  /** что именно спрашивали: подпись кнопки и вернуть ли формат расшифровки */
  const [outputMeta, setOutputMeta] = useState<{ label: string; keep: boolean; model: string } | null>(null)
  /** результат уже сохранён версией */
  const [applied, setApplied] = useState(false)
  /** просить LLM вернуть ответ в формате расшифровки (таймкоды и спикеры) */
  const [keepFormat, setKeepFormat] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const active = busy || output !== null
  useEffect(() => {
    onActive?.(active)
  }, [active, onActive])
  useEffect(() => () => onActive?.(false), [onActive])
  const abortRef = useRef<AbortController | null>(null)
  const downloads = useDownloads()

  const structured = result.segments.length > 0
  const nameOf = (sp: string) => speakerNames[sp]?.trim() || speakerLabel(sp)
  const hasSpeakers = structured && speakersOf(result.segments).length > 0

  // вкладка своего сервиса могла исчезнуть (сервис удалили в настройках)
  const endpoint = providerState.startsWith('ep:')
    ? (llmEndpoints.find((e) => `ep:${e.id}` === providerState) ?? null)
    : null
  const provider: ProviderTab =
    providerState.startsWith('ep:') && !endpoint ? 'local' : providerState
  const cloud: AiProvider | null = provider === 'groq' || provider === 'openai' ? provider : null

  // кнопки: пользовательские из настроек, иначе встроенный набор
  const buttons: LlmButton[] =
    loadLlmButtons() ?? AI_ACTIONS.map((a) => ({ id: a.id, label: t(a.labelKey), prompt: a.prompt }))

  const modelOptions: Array<{ id: string; label: string }> = endpoint
    ? endpoint.models.filter((m) => m.kind === 'llm').map((m) => ({ id: m.id, label: m.id }))
    : cloud
      ? LLM_CLOUD_MODELS[cloud].map((m) => ({ id: m.id, label: m.label }))
      : LLM_MODELS.map((m) => ({ id: m.id, label: `${m.label} · ${t(m.hintKey)} · ${m.size}` }))
  const modelValue =
    provider === 'local'
      ? localModelId
      : (modelOptions.find((m) => m.id === modelByTab[provider])?.id ?? modelOptions[0]?.id ?? '')
  const providerName = endpoint ? endpoint.name : cloud ? aiProviderLabel(cloud) : t('eng.local')

  const setModel = (id: string) => {
    if (provider === 'local') {
      setLocalModelIdState(id)
      saveLlmModel(id)
    } else {
      setModelByTab((m) => ({ ...m, [provider]: id }))
    }
  }

  /** Промпт кнопки + термины её справочника (или справочников из «Движка»). */
  const withGlossary = (prompt: string, glossaryId?: string | null): string => {
    const hint = glossaryId
      ? glossaryPromptText(glossaries, [glossaryId]) ||
        glossaryPromptText(glossaries, settings.glossaryIds)
      : glossaryPromptText(glossaries, settings.glossaryIds)
    if (!hint) return prompt
    if (prompt.includes('{glossary}')) return prompt.replace('{glossary}', hint)
    return `${prompt}\n\nGlossary of terms to use: ${hint}`
  }

  // скачивание локальной модели: байты из менеджера загрузок → статус и задача
  const llmJob = downloads[llmJobId(localModelId)]
  const downloadLine =
    busy && provider === 'local' && llmJob && llmJob.status === 'running' && llmJob.total > 0
      ? `${t('ai.downloading')} · ${formatBytes(llmJob.loaded)} / ${formatBytes(llmJob.total)}`
      : ''

  const run = async (
    prompt: string,
    id: string,
    label: string,
    glossaryId?: string | null,
    free = false,
  ) => {
    if (cloud && !hasKey(cloud)) {
      setError(t('ai.needKey', { provider: aiProviderLabel(cloud) }))
      return
    }
    setBusy(true)
    setActiveId(id)
    setError(null)
    setStatusText('')
    const modelName = modelOptions.find((m) => m.id === modelValue)?.label ?? modelValue
    taskApi?.start('ai', `LLM · ${label}`, modelName)
    // структура разговора (таймкоды и спикеры) уходит в LLM, если она есть
    const keep = structured && keepFormat && !free
    const rules = formatRules({ structured, hasSpeakers, keepFormat: keep })
    const finalPrompt = withGlossary(prompt, glossaryId) + (rules ? `\n\n${rules}` : '')
    const sourceText = structured ? toDialog(result.segments, nameOf) : result.text
    setApplied(false)
    const ctl = new AbortController()
    abortRef.current = ctl
    try {
      let raw: string
      if (endpoint) {
        raw = await customChat(endpoint, modelValue, finalPrompt, sourceText, ctl.signal)
      } else if (cloud) {
        // облачный запрос без процента — бегущая полоса до ответа
        raw = await runAiPrompt(cloud, keys[cloud], finalPrompt, sourceText, modelValue, ctl.signal)
      } else {
        const model = LLM_MODELS.find((m) => m.id === localModelId) ?? LLM_MODELS[0]
        raw = await runLocalAi(
          finalPrompt,
          sourceText,
          { id: model.id, label: model.label },
          {
            onStage: (stage, dev) => {
              const text =
                stage === 'storage'
                  ? t('ai.fromStorage')
                  : stage === 'download'
                    ? t('ai.downloading')
                    : stage === 'init'
                      ? t('st.initModel', { device: deviceLabel(dev ?? null) })
                      : t('ai.generating')
              setStatusText(text)
              taskApi?.update('ai', { pct: stage === 'generate' ? 0 : null, detail: text })
            },
            onProgress: (p) => taskApi?.update('ai', { pct: p }),
          },
          ctl.signal,
        )
      }
      setOutput(stripThinking(raw))
      setOutputFrom(providerName)
      setOutputMeta({ label, keep, model: modelName })
      taskApi?.done('ai')
    } catch (e) {
      if (isAbort(e) || ctl.signal.aborted) {
        taskApi?.cancelRunning()
      } else {
        taskApi?.fail('ai')
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      abortRef.current = null
      setBusy(false)
      setStatusText('')
    }
  }

  const copy = async () => {
    if (!output) return
    try {
      await navigator.clipboard.writeText(output)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* ignore */
    }
  }

  /** Ответ, разобранный обратно в реплики со спикерами (если модель сохранила формат). */
  const parsed = useMemo(
    () =>
      output && outputMeta?.keep
        ? parseDialog(output, result.segments, nameMap(result.segments, nameOf), result.durationSec)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [output, outputMeta, result.segments, speakerNames],
  )

  const apply = () => {
    if (!output || !outputMeta) return
    onApply({
      text: parsed ? plainText(parsed.segments) : output,
      segments: parsed ? parsed.segments : [],
      newNames: parsed ? parsed.newNames : {},
      label: outputMeta.label,
      model: outputMeta.model,
    })
    setApplied(true)
  }

  const actionBtn =
    'btn-console !min-h-10 px-3 border panel-inset text-muted-foreground hover:text-foreground hover:border-[hsl(var(--primary)/0.5)] disabled:opacity-40 disabled:cursor-not-allowed'

  const providerTab = (id: ProviderTab, label: string, disabled: boolean, title?: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={provider === id}
      disabled={busy || disabled}
      title={title}
      onClick={() => setProvider(id)}
      className={`btn-console !min-h-8 px-2.5 !text-[10px] border ${
        provider === id
          ? 'border-[hsl(var(--primary)/0.5)]'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      } disabled:opacity-35`}
      style={provider === id ? { color: 'hsl(var(--primary))' } : undefined}
    >
      {label}
    </button>
  )

  return (
    <section
      className={`panel p-4 md:p-5 flex flex-col gap-4 ${fill ? 'h-full min-h-0 overflow-y-auto' : ''}`}
      aria-label={t('ai.title')}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="chrome-label flex items-center gap-2">
          <Sparkles className="size-3.5" style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />
          {t('ai.title')}
        </h2>
        <span
          className="chrome-label !text-[10px] inline-flex items-center gap-1"
          title={t('ai.workingWith', { n: versionNumber })}
        >
          <Layers className="size-3" aria-hidden="true" />
          {t('ai.version', { n: versionNumber })}
          {structured ? ` · ${hasSpeakers ? t('ai.sendsDialog') : t('ai.sendsTimed')}` : ''}
        </span>
        <div className="flex gap-1 p-0.5 panel-inset flex-wrap" role="tablist" aria-label={t('ai.engine')}>
          {providerTab('local', t('eng.local'), false, t('ai.localTitle'))}
          {AI_PROVIDERS.map((p) =>
            providerTab(
              p,
              aiProviderLabel(p),
              !hasKey(p),
              hasKey(p) ? aiProviderLabel(p) : t('ai.needKeyShort', { provider: aiProviderLabel(p) }),
            ),
          )}
          {llmEndpoints.map((e) => providerTab(`ep:${e.id}`, e.name, false, e.baseUrl))}
        </div>
      </div>

      <select
        value={modelValue}
        disabled={busy}
        onChange={(e) => setModel(e.target.value)}
        title={t('ai.model')}
        className="panel-inset px-2.5 py-2 text-xs bg-transparent text-foreground focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] disabled:opacity-50"
      >
        {modelOptions.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>

      <p className="text-xs text-muted-foreground leading-relaxed -mt-1">
        {provider === 'local' ? t('ai.localNote') : t('ai.cloudNote', { provider: providerName })}
      </p>

      {structured && (
        <label className="flex items-start gap-2 text-xs text-muted-foreground leading-snug cursor-pointer -mt-1">
          <input
            type="checkbox"
            checked={keepFormat}
            disabled={busy}
            onChange={(e) => setKeepFormat(e.target.checked)}
            className="mt-0.5 accent-[hsl(var(--primary))]"
          />
          <span>{t('ai.keepFormat')}</span>
        </label>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {buttons.map((b) => (
          <button
            key={b.id}
            type="button"
            disabled={busy}
            title={b.glossaryId ? t('ai.withGlossary') : undefined}
            onClick={() =>
              void run(
                b.prompt,
                b.id,
                b.label,
                b.glossaryId,
                b.free ?? AI_ACTIONS.find((a) => a.id === b.id)?.free ?? false,
              )
            }
            className={actionBtn}
          >
            {busy && activeId === b.id ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {b.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <textarea
          value={custom}
          disabled={busy}
          onChange={(e) => setCustom(e.target.value)}
          rows={2}
          placeholder={t('ai.customPlaceholder')}
          className="panel-inset px-3 py-2.5 text-sm text-foreground bg-transparent resize-y min-h-16 focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] disabled:opacity-50"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || custom.trim().length < 3}
            onClick={() => void run(custom.trim(), 'custom', t('ai.customLabel'), null, false)}
            className="btn-console px-4 border bg-[hsl(var(--primary)/0.1)] border-[hsl(var(--primary)/0.5)] hover:bg-[hsl(var(--primary)/0.18)] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'hsl(var(--primary))' }}
          >
            {busy && activeId === 'custom' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-4" aria-hidden="true" />
            )}
            {t('ai.run')}
          </button>
          {busy && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="btn-console px-4 border bg-[hsl(var(--err)/0.1)] border-[hsl(var(--err)/0.5)] text-[hsl(var(--err))] hover:bg-[hsl(var(--err)/0.18)]"
            >
              <Square className="size-3.5" aria-hidden="true" />
              {t('common.cancel')}
            </button>
          )}
        </div>
      </div>

      {busy && (downloadLine || statusText) && (
        <p className="font-mono text-[12px]" style={{ color: 'hsl(var(--primary))' }}>
          {downloadLine || statusText}
        </p>
      )}

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
          <p className="text-sm text-foreground/90 break-words">{error}</p>
        </div>
      )}

      {output && (
        <div className="flex flex-col gap-2 border-t border-[hsl(var(--border))] pt-3">
          <div className="flex items-center justify-between">
            <span className="chrome-label !text-[10px]">
              {t('ai.result')} · {outputFrom}
            </span>
            <button
              type="button"
              onClick={() => void copy()}
              className="btn-console !min-h-8 px-2.5 border border-[hsl(var(--border))] text-muted-foreground hover:text-foreground"
            >
              {copied ? (
                <Check className="size-3.5" style={{ color: 'hsl(var(--ok))' }} aria-hidden="true" />
              ) : (
                <Copy className="size-3.5" aria-hidden="true" />
              )}
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
          <p
            className={`text-[15px] leading-relaxed text-foreground/90 whitespace-pre-wrap overflow-y-auto pr-1 panel-inset px-3 py-3 ${
              fill ? 'max-h-[42vh]' : 'max-h-72'
            }`}
          >
            {output}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={applied}
              onClick={apply}
              className={`btn-console !min-h-9 px-3 border disabled:opacity-50 disabled:cursor-default ${
                parsed
                  ? 'bg-[hsl(var(--primary)/0.1)] border-[hsl(var(--primary)/0.5)]'
                  : 'border-[hsl(var(--border))] text-muted-foreground hover:text-foreground'
              }`}
              style={parsed ? { color: 'hsl(var(--primary))' } : undefined}
            >
              {applied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Layers className="size-4" aria-hidden="true" />
              )}
              {applied ? t('ai.saved') : parsed ? t('ai.saveVersion') : t('ai.saveText')}
            </button>
            {outputMeta?.keep && (
              <span
                className="text-xs"
                style={{ color: parsed ? 'hsl(var(--ok))' : 'hsl(var(--warn))' }}
              >
                {parsed ? t('ai.formatKept', { n: parsed.segments.length }) : t('ai.formatLost')}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
