// Модель этапов обработки: конвертация, загрузка модели, распознавание,
// диаризация, LLM. Home ведёт список, TaskList рисует, AiPanel пишет
// свои задачи через тот же TaskApi.

export type TaskState = 'run' | 'done' | 'error' | 'cancelled'

export interface TaskItem {
  id: string
  label: string
  /** уточнение этапа: «загрузка моделей», «генерация», «таймаут»… */
  detail?: string
  /** 0..100; null — индетерминированный прогресс (бегущая полоса) */
  pct: number | null
  state: TaskState
}

export interface TaskApi {
  start: (id: string, label: string, detail?: string) => void
  /** обновляет только выполняющуюся задачу */
  update: (id: string, patch: Partial<Omit<TaskItem, 'id' | 'state'>>) => void
  done: (id: string, detail?: string) => void
  fail: (id: string, detail?: string) => void
  /** все незавершённые задачи → error (при общем сбое операции) */
  failRunning: () => void
  /** все незавершённые задачи → cancelled (пользователь нажал «Отмена») */
  cancelRunning: () => void
  reset: () => void
}
