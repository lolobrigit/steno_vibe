import { useState } from 'react'
import { Cpu, Cloud, ExternalLink, Eye, EyeOff, Users, BookMarked } from 'lucide-react'
import {
  CLOUD_MODELS,
  LANGUAGES,
  LOCAL_MODELS,
  PROVIDER_INFO,
} from '@/lib/models'
import type { CloudProvider } from '@/types'
import type { ApiKeys, AppSettings, Glossary } from '@/lib/storage'

interface EnginePanelProps {
  settings: AppSettings
  keys: ApiKeys
  hasWebGPU: boolean
  decodeFailed: boolean
  busy: boolean
  glossaries: Glossary[]
  onSettings: (s: AppSettings) => void
  onKeys: (k: ApiKeys) => void
}

function QualityDots({ n }: { n: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`качество ${n} из 5`}>
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
  const [showKeys, setShowKeys] = useState(false)

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    p.onSettings({ ...settings, [k]: v })

  const cloudModel = CLOUD_MODELS.find((m) => m.id === settings.cloudModel) ?? CLOUD_MODELS[0]
  const provider: CloudProvider = cloudModel.provider
  const info = PROVIDER_INFO[provider]
  const localModel = LOCAL_MODELS.find((m) => m.id === settings.localModel) ?? LOCAL_MODELS[0]

  const translateSupported = settings.mode === 'local' || provider !== 'deepgram'

  return (
    <section className="panel p-4 flex flex-col gap-4" aria-label="Движок распознавания">
      <h2 className="chrome-label">02 · Движок</h2>

      <div className="grid grid-cols-2 gap-1 p-1 panel-inset" role="tablist" aria-label="Режим">
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
          Локально
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
          Сервисы
        </button>
      </div>

      {settings.mode === 'local' ? (
        <>
          {p.decodeFailed && (
            <p className="text-xs text-[hsl(var(--err))] border-l-2 border-[hsl(var(--err))] bg-[hsl(var(--err)/0.08)] px-3 py-2">
              Этот файл браузер не смог декодировать — локальный режим недоступен.
              Переключитесь на «Сервисы» или конвертируйте файл в wav/mp3.
            </p>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="chrome-label !text-[10px]">Модель Whisper (на устройстве)</span>
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
                {localModel.params} параметров · {localModel.qualityLabel}
              </span>
              <QualityDots n={localModel.quality} />
            </div>
            <p className="text-muted-foreground leading-relaxed">{localModel.bestFor}</p>
            {localModel.needsWebGPU && !p.hasWebGPU && (
              <p className="text-[hsl(var(--warn))]">
                WebGPU недоступен — эта модель будет очень медленной. Откройте Chrome/Edge
                или выберите Small.
              </p>
            )}
            {!p.hasWebGPU && !localModel.needsWebGPU && (
              <p className="text-muted-foreground/80">
                WebGPU не обнаружен — пойдёт через CPU (WASM), медленнее.
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="chrome-label !text-[10px]">Сервис и модель</span>
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
            </select>
          </label>
          <div className="panel-inset px-3 py-2.5 text-xs flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="chrome-label !text-[10px]">{cloudModel.price}</span>
              <QualityDots n={cloudModel.quality} />
            </div>
            <p className="text-muted-foreground leading-relaxed">{cloudModel.note}</p>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="chrome-label !text-[10px] flex items-center justify-between">
              API-ключ {info.label}
              <a
                href={info.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[hsl(var(--primary))] hover:underline normal-case tracking-normal"
              >
                получить <ExternalLink className="size-3" aria-hidden="true" />
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
                aria-label={showKeys ? 'Скрыть ключ' : 'Показать ключ'}
                className="absolute right-1 top-1/2 -translate-y-1/2 size-9 inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {showKeys ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </label>
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
          {settings.diarize ? 'Спикеры: разделять' : 'Спикеры: без разделения'}
        </button>
        {settings.diarize && !(settings.mode === 'cloud' && provider === 'deepgram') && (
          <p className="text-[11px] text-muted-foreground leading-relaxed px-1">
            Локально в браузере: pyannote + WeSpeaker (~45 МБ моделей при первом
            запуске, дальше из кэша). Точность ниже, чем у Deepgram, — короткие
            реплики и перебивания могут путаться.
          </p>
        )}
      </div>

      {/* Справочники терминов: уходят в Whisper (initial_prompt) и в LLM */}
      {p.glossaries.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="chrome-label !text-[10px] flex items-center gap-1.5">
            <BookMarked className="size-3" aria-hidden="true" />
            Справочники в Whisper · {settings.glossaryIds.length} из {p.glossaries.length}
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
                  title={`${g.terms.length} терминов: ${g.terms.slice(0, 5).join(', ')}${g.terms.length > 5 ? '…' : ''}`}
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
            Термины улетают в Whisper как словарная подсказка — редкие слова и
            аббревиатуры распознаются точнее. Те же термины подмешиваются в LLM-промпты.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="chrome-label !text-[10px]">Язык речи</span>          <select
            value={settings.language}
            disabled={p.busy}
            onChange={(e) => set('language', e.target.value)}
            className="w-full min-w-0 panel-inset px-3 py-2.5 text-sm text-foreground bg-transparent focus:outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] disabled:opacity-50"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code} className="bg-[hsl(var(--popover))]">
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="chrome-label !text-[10px]">Задача</span>
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
            {settings.translate && translateSupported ? 'Перевод → EN' : 'Транскрипция'}
          </button>
        </label>
      </div>
    </section>
  )
}
