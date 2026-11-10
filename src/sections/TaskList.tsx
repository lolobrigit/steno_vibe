import { AlertTriangle, Check, ListChecks, Loader2 } from 'lucide-react'
import type { TaskItem } from '@/lib/tasks'

/**
 * Список выполняемых задач с процентами: конвертация, загрузка модели,
 * распознавание речи, диаризация, LLM. pct=null → бегущая полоса.
 */
export function TaskList({ tasks }: { tasks: TaskItem[] }) {
  if (tasks.length === 0) return null
  return (
    <div className="flex flex-col gap-2" aria-label="Выполняемые задачи" aria-live="polite">
      <span className="chrome-label !text-[10px] flex items-center gap-1.5">
        <ListChecks className="size-3" aria-hidden="true" />
        Задачи
      </span>
      <ol className="flex flex-col gap-1.5">
        {tasks.map((t) => (
          <li key={t.id} className="flex flex-col gap-1">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 items-baseline">
              {t.state === 'run' ? (
                <Loader2
                  className="size-3.5 animate-spin self-center"
                  style={{ color: 'hsl(var(--primary))' }}
                  aria-hidden="true"
                />
              ) : t.state === 'done' ? (
                <Check
                  className="size-3.5 self-center"
                  style={{ color: 'hsl(var(--ok))' }}
                  aria-hidden="true"
                />
              ) : (
                <AlertTriangle
                  className="size-3.5 self-center"
                  style={{ color: 'hsl(var(--err))' }}
                  aria-hidden="true"
                />
              )}
              <span className="font-mono text-[11px] text-foreground/90 truncate">
                {t.label}
                {t.detail ? (
                  <span className="text-muted-foreground"> · {t.detail}</span>
                ) : null}
              </span>
              <span
                className="font-mono text-[11px] tabular-nums"
                style={{
                  color:
                    t.state === 'error'
                      ? 'hsl(var(--err))'
                      : t.state === 'done'
                        ? 'hsl(var(--ok))'
                        : 'hsl(var(--primary))',
                }}
              >
                {t.state === 'error'
                  ? 'ошибка'
                  : t.pct === null
                    ? t.state === 'done'
                      ? '100%'
                      : '…'
                    : `${t.pct}%`}
              </span>
            </div>
            <div
              className="h-1 rounded-sm overflow-hidden"
              style={{ background: 'hsl(var(--track))' }}
              role="progressbar"
              aria-valuenow={t.pct ?? undefined}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              {t.pct === null && t.state === 'run' ? (
                <div
                  className="h-full w-1/3 rounded-sm task-bar-slide"
                  style={{ background: 'hsl(var(--primary))' }}
                />
              ) : (
                <div
                  className="h-full rounded-sm transition-[width] duration-300"
                  style={{
                    width: `${t.pct ?? 100}%`,
                    background:
                      t.state === 'error' ? 'hsl(var(--err))' : t.state === 'done' ? 'hsl(var(--ok))' : 'hsl(var(--primary))',
                  }}
                />
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
