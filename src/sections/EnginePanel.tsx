import { useState } from 'react'
import { Cpu, Cloud, ExternalLink, Eye, EyeOff, Plug, Users, BookMarked } from 'lucide-react'
import { CLOUD_MODELS, LOCAL_MODELS, PROVIDER_INFO, SPEECH_LANGUAGES } from '@/lib/models'
import { customModelRef, parseCustomRef, type CustomEndpoint } from '@/lib/customEndpoints'
import { languageName, useT } from '@/i18n'
import type { CloudProvider } from '@/types'
import type { ApiKeys, AppSettings, Glossary } from '@/lib/storage'

interface EnginePanelProps {
  settings: AppSettings
  keys: ApiKeys
  /** свои OpenAI-совместимые сервисы (настраиваются в окне настроек) */
  endpoints: CustomEndpoint[]
  hasWebGPU: boolean
  decodeFailed: boolean
  busy: boolean
  glossaries: Glossary[]
  onSettings: (s: AppSettings) => void
  onKeys: (k: ApiKeys) => void
  onOpenSettings: () => void
}

function QualityDots({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={label}>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={`size-1.5 rounded-full ${
            i < n ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--track))]'
          }`}
        />
      ))}
    </span>
  )
}

export function EnginePanel(p: EnginePanelProps) {
  const { settings, keys } = p
  const t = useT()
  const [showKeys, setShowKeys] = useState(false)

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    p.onSettings({ ...settings, [k]: v })

  const cloudModel = CLOUD_MODELS.find((m) => m.id === settings.cloudModel) ?? CLOUD_MODELS[0]
  const provider: CloudProvider = cloudModel.provider
  const info = PROVIDER_INFO[provider]
  const localModel = LOCAL_MODELS.find((m) => m.id === settings.localModel) ?? LOCAL_MODELS[0]

  const custom = parseCustomRef(settings.cloudModel, p.endpoints)
  const asrEndpoints = p.endpoints.filter((e) => e.models.some((m) => m.kind === 'asr'))
  const serviceDiarize = settings.mode === 'cloud' && !custom && provider === 'deepgram'
  const translateSupported = !serviceDiarize

  return (
    <section className="panel p-4 flex flex-col gap-4" aria-label={t('eng.aria')}>
      <h2 className="chrome-label">02 · {t('eng.title')}</h2>

      <div className="grid grid-cols-2 gap-1 p-1 panel-inset" role="tablist" aria-label={t('eng.mode')}>
        <button
          type="button"
          role="tab"
          aria-selected={settings.mode === 'local'}
          onClick={() => set('mode', 'local')}
          className={`btn-console !min-h-10 border ${
            settings.mode === 'local'
              ? 'bg-[hsl(var(--ok)/0.12)] border-[hsl(var(--ok)/0.5)] text-[hsl(var(--ok))]'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Cpu className="size-4" aria-hidden="true" />
          {t('eng.local')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={settings.mode === 'cloud'}
          onClick={() => set('mode', 'cloud')}
          className={`btn-console !min-h-10 border ${
            settings.mode === 'cloud'
              ? 'bg-[hsl(var(--primary)/0.12)] border-[hsl(var(--primary)/0.5)] text-[hsl(var(--accent-foreground))]'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Cloud className="size-4" aria-hidden="true" />
          {t('eng.cloud')}
        </button>
      </div>

      {settings.mode === 'local' ? (
        <>
          {p.decodeFailed && (
            <p className="text-xs text-[hsl(var(--err))] border-l-2 border-[hsl(var(--err))] bg-[hsl(var(--err)/0.08)] px-3 py-2">
              {t('eng.decodeFailed')}
            </p>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="chrome-label !text-[10px]">{t('eng.localModel')}</span>
            <select
              value={settings.localModel}
              disabled={p.busy}
              onChange={(e) => set('localModel', e.target.value)}
              className="panel-inset px-3 py-2.5 text-sm font-mono text-foreground bg-transparent focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] disabled:opacity-50"
            >
              {LOCAL_MODELS.map((m) => (
                <option key={m.id} value={m.id} className="bg-[hsl(var(--popover))]">
                  {m.label} · {m.size}
                </option>
              ))}
            </select>
          </label>
          <div className="panel-inset px-3 py-2.5 text-xs flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="chrome-label !text-[10px]">
                {localModel.params} · {t(`lm.${localModel.id}.q`)}
              </span>
              <QualityDots n={localModel.quality} label={t('eng.quality', { n: localModel.quality })} />
            </div>
            <p className="text-muted-foreground leading-relaxed">{t(`lm.${localModel.id}.best`)}</p>
            {localModel.needsWebGPU && !p.hasWebGPU && (
              <p className="text-[hsl(var(--warn))]">
                {t('eng.noGpuHeavy')}
              </p>
            )}
            {!p.hasWebGPU && !localModel.needsWebGPU && (
              <p className="text-muted-foreground/80">
                {t('eng.noGpu')}
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="chrome-label !text-[10px]">{t('eng.cloudModel')}</span>
            <select
              value={settings.cloudModel}
              disabled={p.busy}
              onChange={(e) => set('cloudModel', e.target.value)}
              className="panel-inset px-3 py-2.5 text-sm font-mono text-foreground bg-transparent focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] disabled:opacity-50"
            >
              {CLOUD_MODELS.map((m) => (
                <option key={m.id} value={m.id} className="bg-[hsl(var(--popover))]">
                  {m.label}
                </option>
              ))}
              {asrEndpoints.map((e) => (
                <optgroup key={e.id} label={e.name}>
                  {e.models
                    .filter((m) => m.kind === 'asr')
                    .map((m) => (
                      <option
                        key={m.id}
                        value={customModelRef(e.id, m.id)}
                        className="bg-[hsl(var(--popover))]"
                      >
                        {m.id}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          {custom ? (
            <div className="panel-inset px-3 py-2.5 text-xs flex flex-col gap-1.5">
              <span className="chrome-label !text-[10px] truncate" title={custom.endpoint.baseUrl}>
                {custom.endpoint.baseUrl}
              </span>
              <p className="text-muted-foreground leading-relaxed">{t('eng.customNote')}</p>
            </div>
          ) : (
            <div className="panel-inset px-3 py-2.5 text-xs flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="chrome-label !text-[10px]">{cloudModel.price}</span>
                <QualityDots n={cloudModel.quality} label={t('eng.quality', { n: cloudModel.quality })} />
              </div>
              <p className="text-muted-foreground leading-relaxed">{t(`cm.${cloudModel.id}`)}</p>
            </div>
          )}
          <button
            type="button"
            onClick={p.onOpenSettings}
            className="btn-console !min-h-8 px-2.5 !text-[10px] border border-[hsl(var(--border))] text-muted-foreground hover:text-foreground self-start"
          >
            <Plug className="size-3.5" aria-hidden="true" />
            {t('eng.addEndpoint')}
          </button>

          {!custom && (
          <label className="flex flex-col gap-1.5">
            <span className="chrome-label !text-[10px] flex items-center justify-between">
              {t('eng.apiKey', { provider: info.label })}
              <a
                href={info.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[hsl(var(--primary))] hover:underline normal-case tracking-normal"
              >
                {t('eng.getKey')} <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            </span>
            <div className="relative">
              <input
                type={showKeys ? 'text' : 'password'}
                autoComplete="off"
                value={keys[provider]}
                disabled={p.busy}
                placeholder={info.keyPlaceholder}
                onChange={(e) => p.onKeys({ ...keys, [provider]: e.target.value.trim() })}
                className="w-full panel-inset px-3 py-2.5 pr-11 text-sm font-mono text-foreground bg-transparent focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowKeys((v) => !v)}
                aria-label={showKeys ? t('eng.hideKey') : t('eng.showKey')}
                className="absolute right-1 top-1/2 -translate-y-1/2 size-9 inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {showKeys ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </label>
          )}
        </>
      )}

      {/* Разделение спикеров: у Deepgram — на стороне сервиса,
          у всех остальных режимов — локально в браузере */}
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={p.busy}
          onClick={() => set('diarize', !settings.diarize)}
          aria-pressed={settings.diarize}
          className={`btn-console !min-h-[42px] w-full border ${
            settings.diarize
              ? 'bg-[hsl(var(--ok)/0.1)] border-[hsl(var(--ok)/0.5)] text-[hsl(var(--ok))]'
              : 'panel-inset text-muted-foreground hover:text-foreground'
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          <Users className="size-4" aria-hidden="true" />
          {settings.diarize ? t('eng.diarOn') : t('eng.diarOff')}
        </button>
        {settings.diarize && !serviceDiarize && (
          <p className="text-[11px] text-muted-foreground leading-relaxed px-1">
            {t('eng.diarNote')}
          </p>
        )}
      </div>

      {settings.mode === 'local' && (
        <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer px-1">
          <input
            type="checkbox"
            className="mt-0.5"
            disabled={p.busy}
            checked={!!settings.wordTimestamps}
            onChange={(e) => set('wordTimestamps', e.target.checked)}
          />
          <span>
            {t('eng.words')}
            <span className="block text-[11px] opacity-80">{t('eng.wordsNote')}</span>
          </span>
        </label>
      )}

      {/* Справочники терминов: уходят в Whisper (initial_prompt) и в LLM */}
      {p.glossaries.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="chrome-label !text-[10px] flex items-center gap-1.5">
            <BookMarked className="size-3" aria-hidden="true" />
            {t('eng.glossaries')} · {settings.glossaryIds.length} / {p.glossaries.length}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {p.glossaries.map((g) => {
              const on = settings.glossaryIds.includes(g.id)
              return (
                <button
                  key={g.id}
                  type="button"
                  disabled={p.busy}
                  aria-pressed={on}
                  title={`${g.terms.slice(0, 5).join(', ')}${g.terms.length > 5 ? '…' : ''}`}
                  onClick={() =>
                    set(
                      'glossaryIds',
                      on
                        ? settings.glossaryIds.filter((id) => id !== g.id)
                        : [...settings.glossaryIds, g.id],
                    )
                  }
                  className={`btn-console !min-h-8 px-2.5 !text-[10px] border ${
                    on
                      ? 'bg-[hsl(var(--primary)/0.12)] border-[hsl(var(--primary)/0.5)]'
                      : 'border-[hsl(var(--border))] text-muted-foreground hover:text-foreground'
                  } disabled:opacity-40`}
                  style={on ? { color: 'hsl(var(--primary))' } : undefined}
                >
                  {g.name} · {g.terms.length}
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-muted-foreground/80 leading-snug">
            {t('eng.glossNote')}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="chrome-label !text-[10px]">{t('eng.speechLang')}</span>
          <select
            value={settings.language}
            disabled={p.busy}
            onChange={(e) => set('language', e.target.value)}
            className="w-full min-w-0 panel-inset px-3 py-2.5 text-sm text-foreground bg-transparent focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] disabled:opacity-50"
          >
            <option value="auto" className="bg-[hsl(var(--popover))]">
              {t('eng.langAuto')}
            </option>
            {SPEECH_LANGUAGES.map((code) => (
              <option key={code} value={code} className="bg-[hsl(var(--popover))]">
                {languageName(code)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="chrome-label !text-[10px]">{t('eng.task')}</span>
          <button
            type="button"
            disabled={p.busy || !translateSupported}
            onClick={() => set('translate', !settings.translate)}
            aria-pressed={settings.translate}
            className={`btn-console !min-h-[42px] w-full border ${
              settings.translate && translateSupported
                ? 'bg-[hsl(var(--primary)/0.12)] border-[hsl(var(--primary)/0.5)] text-[hsl(var(--accent-foreground))]'
                : 'panel-inset text-muted-foreground hover:text-foreground'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {settings.translate && translateSupported ? t('eng.translate') : t('eng.transcription')}
          </button>
        </label>
      </div>
    </section>
  )
}
