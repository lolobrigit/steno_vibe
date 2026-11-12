import type { HistoryItem } from '@/types'
import { getAudio, saveAudio } from './audioStore'
import { buildProject, parseProject, type ProjectEntry } from './project'
import { addHistoryMany, loadHistory } from './storage'
import { loadVersions, saveVersions } from './versionStore'

/** Собрать записи для экспорта: версии из IndexedDB, аудио — по желанию. */
export async function collectEntries(items: HistoryItem[], withAudio: boolean): Promise<ProjectEntry[]> {
  const out: ProjectEntry[] = []
  for (const it of items) {
    const stored = await loadVersions(it.id)
    const item: HistoryItem = { ...it, versions: stored?.versions, activeVersionId: stored?.activeVersionId ?? it.activeVersionId }
    const audio = withAudio && it.hasAudio ? await getAudio(it.id) : null
    out.push({ item, audio })
  }
  return out
}

export async function buildExport(items: HistoryItem[], withAudio: boolean): Promise<Blob> {
  return buildProject(await collectEntries(items, withAudio), withAudio)
}

/**
 * Импортировать файл проекта в историю. Записи получают новые id, если такие
 * уже есть (повторный импорт не затирает существующее). Возвращает новый список истории.
 */
export async function importProject(file: Blob): Promise<{ list: HistoryItem[]; count: number }> {
  const entries = await parseProject(file)
  const taken = new Set(loadHistory().map((i) => i.id))
  const added: HistoryItem[] = []
  for (const { item, audio } of entries) {
    const id = taken.has(item.id) ? crypto.randomUUID() : item.id
    taken.add(id)
    const { versions, ...rest } = item
    let hasAudio = false
    if (audio) {
      try {
        await saveAudio(id, audio, item.sourceName)
        hasAudio = true
      } catch {
        /* нет места — импортируем без аудио */
      }
    }
    if (versions?.length) {
      const activeVersionId = versions.some((v) => v.id === item.activeVersionId)
        ? item.activeVersionId!
        : versions[versions.length - 1].id
      await saveVersions({ id, versions, activeVersionId })
      added.push({ ...rest, id, hasAudio, activeVersionId })
    } else {
      added.push({ ...rest, id, hasAudio })
    }
  }
  return { list: addHistoryMany(added.reverse()), count: added.length }
}
