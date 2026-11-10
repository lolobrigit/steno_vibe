import { useState } from 'react'
import { CircleHelp, CloudUpload, Moon, Palette, Settings, ShieldCheck, Sun } from 'lucide-react'
import { QUALITY_GUIDE } from '@/lib/models'
import type { ThemeName } from '@/lib/storage'

interface HeaderProps {
  status: 'idle' | 'rec' | 'load' | 'proc'
  mode: 'local' | 'cloud'
  deviceLabel?: string
  theme: ThemeName
  onTheme: (t: ThemeName) => void
  onOpenSettings: () => void
}

const STATUS: Record<HeaderProps['status'], { label: string; color: string; pulse: boolean }> = {
  idle: { label: 'ГОТОВ', color: 'hsl(var(--ok))', pulse: false },
  rec: { label: 'ЗАПИСЬ', color: 'hsl(var(--err))', pulse: true },
  load: { label: 'ЗАГРУЗКА МОДЕЛИ', color: 'hsl(var(--warn))', pulse: true },
  proc: { label: 'РАСПОЗНАВАНИЕ', color: 'hsl(var(--primary))', pulse: true },
}

const THEMES: Array<{ id: ThemeName; label: string }> = [
  { id: 'dark', label: 'Тёмная' },
  { id: 'light', label: 'Светлая' },
  { id: 'neutral', label: 'Нейтральная' },
]

export function Header({ status, mode, deviceLabel, theme, onTheme, onOpenSettings }: HeaderProps) {
  const s = STATUS[status]
  const [guideOpen, setGuideOpen] = useState(false)

  return (
    <header
      className="sticky top-0 z-40 h-12 hairline-b backdrop-blur-md"
      style={{ backgroundColor: 'hsl(var(--header-bg) / 0.85)' }}
    >
      <div className="h-full max-w-[1560px] mx-auto px-4 flex items-center gap-3">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: 'hsl(var(--err))' }} />
          <span className="size-2.5 rounded-full" style={{ backgroundColor: 'hsl(var(--warn))' }} />
          <span className="size-2.5 rounded-full" style={{ backgroundColor: 'hsl(var(--ok))' }} />
        </div>
        <div className="font-mono font-bold tracking-[0.28em] text-sm text-foreground pl-1">
          STENO
        </div>
        <div className="hidden md:block chrome-label !text-[10px] opacity-70">
          РЕЧЬ → ТЕКСТ
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {mode === 'local' && deviceLabel && (
            <span className="hidden sm:inline-flex chrome-label !text-[10px] px-2 py-1 panel-inset">
              {deviceLabel}
            </span>
          )}
          <span
            className="inline-flex items-center gap-2 px-2.5 py-1 panel-inset font-mono text-[11px] tracking-[0.12em]"
            role="status"
          >
            <span
              className={`led ${s.pulse ? 'led-pulse' : ''}`}
              style={{ color: s.color, backgroundColor: s.color }}
            />
            {s.label}
          </span>
          <span className="hidden lg:inline-flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
            {mode === 'local' ? (
              <>
                <ShieldCheck className="size-3.5" style={{ color: 'hsl(var(--ok))' }} />
                АУДИО НЕ ПОКИДАЕТ УСТРОЙСТВО
              </>
            ) : (
              <>
                <CloudUpload className="size-3.5" style={{ color: 'hsl(var(--warn))' }} />
                ФАЙЛ ОТПРАВЛЯЕТСЯ В СЕРВИС
              </>
            )}
          </span>

          {/* Гайд «Модель → качество»: попап по наведению/клику */}
          <div
            className="relative"
            onMouseEnter={() => setGuideOpen(true)}
            onMouseLeave={() => setGuideOpen(false)}
          >
            <button
              type="button"
              aria-label="Какую модель выбрать"
              aria-expanded={guideOpen}
              onClick={() => setGuideOpen((v) => !v)}
              className="size-9 inline-flex items-center justify-center rounded-[4px] text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <CircleHelp className="size-4.5" aria-hidden="true" />
            </button>
            {guideOpen && (
              <div className="absolute right-0 top-full pt-2 z-50 w-[min(24rem,calc(100vw-2rem))]">
                <div className="panel p-4 shadow-xl shadow-black/30">
                  <h2 className="chrome-label mb-3">Модель → качество</h2>
                  <ol className="flex flex-col max-h-[60vh] overflow-y-auto pr-1">
                    {QUALITY_GUIDE.map((g, i) => (
                      <li
                        key={g.tier}
                        className={`py-2.5 ${i > 0 ? 'border-t border-[hsl(var(--border))]' : ''}`}
                      >
                        <div className="flex items-baseline justify-between gap-2 flex-wrap">
                          <span className="text-[13px] font-semibold text-foreground">{g.tier}</span>
                          <span
                            className="font-mono text-[11px]"
                            style={{ color: 'hsl(var(--primary))' }}
                          >
                            {g.model}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                          {g.text}
                        </p>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            )}
          </div>

          {/* Окно настроек: модели и их предзагрузка */}
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Настройки и модели"
            title="Настройки и модели"
            className="size-9 inline-flex items-center justify-center rounded-[4px] text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <Settings className="size-4.5" aria-hidden="true" />
          </button>

          {/* Переключатель темы */}
          <div
            className="flex gap-0.5 p-0.5 panel-inset"
            role="group"
            aria-label="Тема оформления"
          >
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onTheme(t.id)}
                aria-pressed={theme === t.id}
                title={t.label}
                className={`size-8 inline-flex items-center justify-center rounded-[3px] cursor-pointer transition-colors ${
                  theme === t.id
                    ? 'text-foreground bg-[hsl(var(--accent))]'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.id === 'dark' ? (
                  <Moon className="size-3.5" aria-hidden="true" />
                ) : t.id === 'light' ? (
                  <Sun className="size-3.5" aria-hidden="true" />
                ) : (
                  <Palette className="size-3.5" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  )
}
