import { useState } from 'react'
import { AlertTriangle, Check, Copy, Loader2, Sparkles } from 'lucide-react'
import { AI_ACTIONS } from '@/lib/models'
import { aiProviderLabel, runAiPrompt, type AiProvider, AI_PROVIDERS, LLM_CLOUD_MODELS } from '@/lib/ai'
import { runLocalAi } from '@/lib/localAi'
import { hasWebGPU } from '@/lib/localEngine'
import type { TaskApi } from '@/lib/tasks'
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

interface AiPanelProps {
  sourceText: string
  keys: ApiKeys
  settings: AppSettings
  glossaries: Glossary[]
  /** общий список задач в панели транскрипции — LLM-этап пишется туда */
  taskApi?: TaskApi
}

type ProviderTab = AiProvider | 'local'

const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim()

export function AiPanel({ sourceText, keys, settings, glossaries, taskApi }: AiPanelProps) {
  const hasKey = (p: AiProvider) => keys[p].length > 8
  const [provider, setProvider] = useState<ProviderTab>('local')
  const [localModelId, setLocalModelIdState] = useState(loadLlmModel)
  const [cloudModelIds, setCloudModelIds] = useState<Record<AiProvider, string>>({
    groq: LLM_CLOUD_MODELS.groq[0].id,
    openai: LLM_CLOUD_MODELS.openai[0].id,
  })
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [statusText, setStatusText] = useState('')
  const [output, setOutput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // кнопки: пользовательские из настроек, иначе встроенный набор
  const buttons: LlmButton[] =
    loadLlmButtons() ?? AI_ACTIONS.map((a) => ({ id: a.id, label: a.label, prompt: a.prompt }))

  const setLocalModel = (id: string) => {
    setLocalModelIdState(id)
    saveLlmModel(id)
  }

  /** Промпт кнопки + термины её справочника (или справочников из «Движка»). */
  const withGlossary = (prompt: string, glossaryId?: string | null): string => {
    const hint = glossaryId
      ? glossaryPromptText(glossaries, [glossaryId]) ||
        glossaryPromptText(glossaries, settings.glossaryIds)
      : glossaryPromptText(glossaries, settings.glossaryIds)
    if (!hint) return prompt
    if (prompt.includes('{glossary}')) return prompt.replace('{glossary}', hint)
    return `${prompt}\n\nИспользуй справочник терминов: ${hint}`
  }

  const run = async (prompt: string, id: string, label: string, glossaryId?: string | null) => {
    if (provider !== 'local' && !hasKey(provider)) {
      setError(`Для ${aiProviderLabel(provider)} нужен API-ключ — введите его в панели движка`)
      return
    }
    setBusy(true)
    setActiveId(id)
    setError(null)
    setStatusText('')
    const modelName =
      provider === 'local'
        ? (LLM_MODELS.find((m) => m.id === localModelId)?.label ?? localModelId)
        : (LLM_CLOUD_MODELS[provider].find((m) => m.id === cloudModelIds[provider])?.label ??
          provider)
    taskApi?.start('ai', `LLM · ${label}`, modelName)
    const finalPrompt = withGlossary(prompt, glossaryId)
    try {
      if (provider === 'local') {
        setOutput(
          stripThinking(
            await runLocalAi(finalPrompt, sourceText, hasWebGPU(), localModelId, {
              onStatus: (t) => {
                setStatusText(t)
                // зеркалим статус в строку задачи: «(CPU/WASM)», «обрабатывает текст»…
                const dev = t.match(/\(([^)]+)\)/)?.[1] ?? t.replace(/…$/, '')
                taskApi?.update('ai', { detail: dev })
              },
              onLoadProgress: (f, p) => {
                setStatusText(`Загрузка модели: ${f.split('/').pop()} · ${p}%`)
              },
              onLoadTotal: (p) => {
                // агрегат по байтам всех файлов модели — один процент на всё
                taskApi?.update('ai', { pct: p, detail: 'загрузка модели' })
              },
              onProgress: (p) => taskApi?.update('ai', { pct: p, detail: 'генерация' }),
            }),
          ),
        )
      } else {
        // облачный запрос без процента — бегущая полоса до ответа
        setOutput(
          stripThinking(
            await runAiPrompt(provider, keys[provider], finalPrompt, sourceText, cloudModelIds[provider]),
          ),
        )
      }
      taskApi?.done('ai')
    } catch (e) {
      taskApi?.fail('ai')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
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

  const modelOptions =
    provider === 'local'
      ? LLM_MODELS.map((m) => ({ id: m.id, label: `${m.label} · ${m.size}` }))
      : LLM_CLOUD_MODELS[provider].map((m) => ({ id: m.id, label: m.label }))
  const modelValue = provider === 'local' ? localModelId : cloudModelIds[provider]

  return (
    <section className="panel p-4 md:p-5 flex flex-col gap-4" aria-label="AI-обработка текста">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="chrome-label flex items-center gap-2">
          <Sparkles className="size-3.5" style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />
          AI-обработка транскрипта
        </h2>
        <div className="flex gap-1 p-0.5 panel-inset" role="tablist" aria-label="AI-движок">
          {providerTab('local', 'Локально', false, 'Qwen3 в браузере, текст никуда не уходит')}
          {AI_PROVIDERS.map((p) =>
            providerTab(
              p,
              p === 'groq' ? 'Groq' : 'OpenAI',
              !hasKey(p),
              hasKey(p) ? aiProviderLabel(p) : `Нужен ключ ${p === 'groq' ? 'Groq' : 'OpenAI'}`,
            ),
          )}
        </div>
      </div>

      <select
        value={modelValue}
        disabled={busy}
        onChange={(e) =>
          provider === 'local'
            ? setLocalModel(e.target.value)
            : setCloudModelIds((m) => ({ ...m, [provider]: e.target.value }))
        }
        title="Модель LLM"
        className="panel-inset px-2.5 py-2 text-xs bg-transparent text-foreground focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] disabled:opacity-50"
      >
        {modelOptions.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>

      <p className="text-xs text-muted-foreground leading-relaxed -mt-1">
        {provider === 'local'
          ? 'Локальная модель в браузере (скачивается при первом запуске, дальше из кэша). Текст не покидает устройство; качество ниже облачных, длинные тексты обрезаются.'
          : `Текст транскрипта отправляется в ${aiProviderLabel(provider)}.`}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {buttons.map((b) => (
          <button
            key={b.id}
            type="button"
            disabled={busy}
            title={b.glossaryId ? 'Со справочником' : undefined}
            onClick={() => void run(b.prompt, b.id, b.label, b.glossaryId)}
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
          placeholder="Свой промпт: «перепиши как письмо клиенту», «выдели цитаты», «переведи на английский»…"
          className="panel-inset px-3 py-2.5 text-sm text-foreground bg-transparent resize-y min-h-16 focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] disabled:opacity-50"
        />
        <button
          type="button"
          disabled={busy || custom.trim().length < 3}
          onClick={() => void run(custom.trim(), 'custom', 'Свой промпт')}
          className="btn-console px-4 border bg-[hsl(var(--primary)/0.1)] border-[hsl(var(--primary)/0.5)] hover:bg-[hsl(var(--primary)/0.18)] disabled:opacity-40 disabled:cursor-not-allowed self-start"
          style={{ color: 'hsl(var(--primary))' }}
        >
          {busy && activeId === 'custom' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-4" aria-hidden="true" />
          )}
          Выполнить промпт
        </button>
      </div>

      {busy && statusText && (
        <p className="font-mono text-[12px]" style={{ color: 'hsl(var(--primary))' }}>
          {statusText}
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
              Результат · {provider === 'local' ? 'Локально' : aiProviderLabel(provider)}
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
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
          <p className="text-[15px] leading-relaxed text-foreground/90 whitespace-pre-wrap max-h-72 overflow-y-auto pr-1 panel-inset px-3 py-3">
            {output}
          </p>
        </div>
      )}
    </section>
  )
}
