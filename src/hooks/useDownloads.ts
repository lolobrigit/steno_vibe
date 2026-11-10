import { useSyncExternalStore } from 'react'
import { downloadsSnapshot, subscribeDownloads, type JobState } from '@/lib/downloads'

/** Состояние всех загрузок моделей (обновляется не чаще 5 раз в секунду). */
export function useDownloads(): Record<string, JobState> {
  return useSyncExternalStore(subscribeDownloads, downloadsSnapshot, downloadsSnapshot)
}
