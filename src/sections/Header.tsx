import { useState } from 'react'
import { CircleHelp, CloudUpload, Moon, Palette, Settings, ShieldCheck, Sparkles, Sun, SunMedium } from 'lucide-react'
import { QUALITY_GUIDE } from '@/lib/models'
import type { ThemeName } from '@/lib/storage'
import { useT } from '@/i18n'

interface HeaderProps {
  status: 'idle' | 'rec' | 'load' | 'proc'
  mode: 'local' | 'cloud'
  deviceLabel?: string
  theme: ThemeName
  onTheme: (t: ThemeName) => void
  onOpenSettings: () => void
}

const STATUS: Record<HeaderProps['status'], { color: string; pulse: boolean }> = {
  idle: { color: 'hsl(var(--ok))', pulse: false },
  rec: { color: 'hsl(var(--err))', pulse: true },
  load: { color: 'hsl(var(--warn))', pulse: true },
  proc: { color: 'hsl(var(--primary))', pulse: true },
}

const THEMES: ThemeName[] = ['aurora', 'aurora-light', 'dark', 'light', 'neutral']

export function Header({ status, mode, deviceLabel, theme, onTheme, onOpenSettings }: HeaderProps) {
  const s = STATUS[status]
  const t = useT()
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
        <h1 className="font-mono font-bold tracking-[0.28em] text-sm text-foreground pl-1">
          STENO
          <span className="sr-only"> — {t('seo.h1')}</span>
        </h1>
        <div className="hidden md:block chrome-label !text-[10px] opacity-70">{t('hdr.tagline')}</div>

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
            {t(`hdr.status.${status}`)}
          </span>
          <span className="hidden lg:inline-flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
            {mode === 'local' ? (
              <>
                <ShieldCheck className="size-3.5" style={{ color: 'hsl(var(--ok))' }} />
                {t('hdr.private')}
              </>
            ) : (
              <>
                <CloudUpload className="size-3.5" style={{ color: 'hsl(var(--warn))' }} />
                {t('hdr.uploaded')}
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
              aria-label={t('hdr.guideAria')}
              aria-expanded={guideOpen}
              onClick={() => setGuideOpen((v) => !v)}
              className="size-9 inline-flex items-center justify-center rounded-[4px] text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <CircleHelp className="size-4.5" aria-hidden="true" />
            </button>
            {guideOpen && (
              <div className="absolute right-0 top-full pt-2 z-50 w-[min(24rem,calc(100vw-2rem))]">
                <div className="panel p-4 shadow-xl shadow-black/30">
                  <h2 className="chrome-label mb-3">{t('hdr.guideTitle')}</h2>
                  <ol className="flex flex-col max-h-[60vh] overflow-y-auto pr-1">
                    {QUALITY_GUIDE.map((g, i) => (
                      <li
                        key={g.n}
                        className={`py-2.5 ${i > 0 ? 'border-t border-[hsl(var(--border))]' : ''}`}
                      >
                        <div className="flex items-baseline justify-between gap-2 flex-wrap">
                          <span className="text-[13px] font-semibold text-foreground">{t(`guide.${g.n}.tier`)}</span>
                          <span
                            className="font-mono text-[11px]"
                            style={{ color: 'hsl(var(--primary))' }}
                          >
                            {g.model}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                          {t(`guide.${g.n}.text`)}
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
            aria-label={t('hdr.settings')}
            title={t('hdr.settings')}
            className="size-9 inline-flex items-center justify-center rounded-[4px] text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <Settings className="size-4.5" aria-hidden="true" />
          </button>

          {/* Переключатель темы */}
          <div
            className="flex gap-0.5 p-0.5 panel-inset"
            role="group"
            aria-label={t('hdr.theme')}
          >
            {THEMES.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onTheme(id)}
                aria-pressed={theme === id}
                title={t(`hdr.theme.${id}`)}
                className={`size-8 inline-flex items-center justify-center rounded-[3px] cursor-pointer transition-colors ${
                  theme === id
                    ? 'text-foreground bg-[hsl(var(--accent))]'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {id === 'aurora' ? (
                  <Sparkles className="size-3.5" aria-hidden="true" />
                ) : id === 'aurora-light' ? (
                  <SunMedium className="size-3.5" aria-hidden="true" />
                ) : id === 'dark' ? (
                  <Moon className="size-3.5" aria-hidden="true" />
                ) : id === 'light' ? (
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
