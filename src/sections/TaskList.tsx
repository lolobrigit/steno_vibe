import { AlertTriangle, Ban, Check, ListChecks, Loader2 } from 'lucide-react'
import { useT } from '@/i18n'
import type { TaskItem } from '@/lib/tasks'

/**
 * Список выполняемых задач с процентами: конвертация, загрузка модели,
 * распознавание речи, диаризация, LLM. pct=null → бегущая полоса.
 */
export function TaskList({ tasks }: { tasks: TaskItem[] }) {
  const t = useT()
  if (tasks.length === 0) return null
  return (
    <div className="flex flex-col gap-2" aria-label={t('task.aria')} aria-live="polite">
      <span className="chrome-label !text-[10px] flex items-center gap-1.5">
        <ListChecks className="size-3" aria-hidden="true" />
        {t('task.title')}
      </span>
      <ol className="flex flex-col gap-1.5">
        {tasks.map((task) => (
          <li key={task.id} className="flex flex-col gap-1">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 items-baseline">
              {task.state === 'run' ? (
                <Loader2
                  className="size-3.5 animate-spin self-center"
                  style={{ color: 'hsl(var(--primary))' }}
                  aria-hidden="true"
                />
              ) : task.state === 'done' ? (
                <Check
                  className="size-3.5 self-center"
                  style={{ color: 'hsl(var(--ok))' }}
                  aria-hidden="true"
                />
              ) : task.state === 'cancelled' ? (
                <Ban className="size-3.5 self-center text-muted-foreground" aria-hidden="true" />
              ) : (
                <AlertTriangle
                  className="size-3.5 self-center"
                  style={{ color: 'hsl(var(--err))' }}
                  aria-hidden="true"
                />
              )}
              <span className="font-mono text-[11px] text-foreground/90 truncate">
                {task.label}
                {task.detail ? (
                  <span className="text-muted-foreground"> · {task.detail}</span>
                ) : null}
              </span>
              <span
                className="font-mono text-[11px] tabular-nums"
                style={{
                  color:
                    task.state === 'error'
                      ? 'hsl(var(--err))'
                      : task.state === 'cancelled'
                        ? 'hsl(var(--muted-foreground))'
                        : task.state === 'done'
                        ? 'hsl(var(--ok))'
                        : 'hsl(var(--primary))',
                }}
              >
                {task.state === 'error'
                  ? t('task.error')
                  : task.state === 'cancelled'
                    ? t('task.cancelled')
                    : task.pct === null
                    ? task.state === 'done'
                      ? '100%'
                      : '…'
                    : `${task.pct}%`}
              </span>
            </div>
            <div
              className="h-1 rounded-sm overflow-hidden"
              style={{ background: 'hsl(var(--track))' }}
              role="progressbar"
              aria-valuenow={task.pct ?? undefined}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              {task.pct === null && task.state === 'run' ? (
                <div
                  className="h-full w-1/3 rounded-sm task-bar-slide"
                  style={{ background: 'hsl(var(--primary))' }}
                />
              ) : (
                <div
                  className="h-full rounded-sm transition-[width] duration-300"
                  style={{
                    width: `${task.pct ?? 100}%`,
                    background:
                      task.state === 'error'
                        ? 'hsl(var(--err))'
                        : task.state === 'cancelled'
                          ? 'hsl(var(--muted-foreground))'
                          : task.state === 'done'
                            ? 'hsl(var(--ok))'
                            : 'hsl(var(--primary))',
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
