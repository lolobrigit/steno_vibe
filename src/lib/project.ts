// Файл проекта «.steno»: одна или несколько записей истории (все версии
// расшифровки, имена спикеров) вместе с исходным аудио/видео. Нужен для
// переноса между браузерами и устройствами — через файл или через облачный
// диск (см. lib/cloud). Без зависимостей от DOM и React: тот же формат читают
// нативные клиенты (docs/NATIVE_APPS.md).
//
// Раскладка байтов:
//   "STENOPRJ1\n" (10 байт, ASCII)
//   длина заголовка, u32 little-endian
//   заголовок — JSON UTF-8 (HistoryItem[] + описание вложений)
//   вложения подряд, в порядке записей; размеры — в заголовке

import type { HistoryItem } from '../types'

const MAGIC = 'STENOPRJ1\n'
const MAGIC_LEN = MAGIC.length
export const PROJECT_EXT = '.steno'

export interface ProjectEntry {
  item: HistoryItem
  audio?: Blob | null
}

interface AudioMeta {
  name: string
  type: string
  size: number
}

interface ProjectHeader {
  format: 'steno-project'
  version: 1
  exportedAt: number
  entries: Array<{ item: HistoryItem; audio?: AudioMeta }>
}

/** Собрать файл проекта. `withAudio=false` — только тексты и версии (маленький файл). */
export function buildProject(entries: ProjectEntry[], withAudio: boolean, now = Date.now()): Blob {
  const header: ProjectHeader = {
    format: 'steno-project',
    version: 1,
    exportedAt: now,
    entries: entries.map(({ item, audio }) => {
      const keep = withAudio && audio ? audio : null
      return {
        item: { ...item, hasAudio: !!keep },
        audio: keep ? { name: item.sourceName, type: keep.type, size: keep.size } : undefined,
      }
    }),
  }
  const json = new TextEncoder().encode(JSON.stringify(header))
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, json.byteLength, true)
  const parts: BlobPart[] = [MAGIC, len, json]
  if (withAudio) for (const e of entries) if (e.audio) parts.push(e.audio)
  return new Blob(parts, { type: 'application/x-steno-project' })
}

function isItem(x: unknown): x is HistoryItem {
  const i = x as Partial<HistoryItem> | null
  return (
    !!i &&
    typeof i.id === 'string' &&
    typeof i.sourceName === 'string' &&
    typeof i.text === 'string' &&
    Array.isArray(i.segments)
  )
}

/** Прочитать файл проекта. Бросает Error с понятным кодом при повреждении. */
export async function parseProject(file: Blob): Promise<ProjectEntry[]> {
  if (file.size < MAGIC_LEN + 4) throw new Error('not-a-project')
  const head = new Uint8Array(await file.slice(0, MAGIC_LEN + 4).arrayBuffer())
  if (new TextDecoder().decode(head.slice(0, MAGIC_LEN)) !== MAGIC) throw new Error('not-a-project')
  const headerLen = new DataView(head.buffer, head.byteOffset + MAGIC_LEN, 4).getUint32(0, true)
  const bodyStart = MAGIC_LEN + 4 + headerLen
  if (headerLen === 0 || bodyStart > file.size) throw new Error('corrupt-project')

  let header: ProjectHeader
  try {
    header = JSON.parse(
      new TextDecoder().decode(await file.slice(MAGIC_LEN + 4, bodyStart).arrayBuffer()),
    ) as ProjectHeader
  } catch {
    throw new Error('corrupt-project')
  }
  if (header.format !== 'steno-project' || header.version !== 1 || !Array.isArray(header.entries)) {
    throw new Error('not-a-project')
  }

  const out: ProjectEntry[] = []
  let offset = bodyStart
  for (const e of header.entries) {
    if (!isItem(e.item)) throw new Error('corrupt-project')
    let audio: Blob | undefined
    if (e.audio) {
      const size = Number(e.audio.size)
      if (!Number.isFinite(size) || size < 0 || offset + size > file.size) throw new Error('corrupt-project')
      audio = file.slice(offset, offset + size, e.audio.type || 'application/octet-stream')
      offset += size
    }
    out.push({ item: { ...e.item, hasAudio: !!audio }, audio })
  }
  return out
}

/** Имя файла: «имя записи.steno» или «steno-проекты-2026-11-12.steno». */
export function projectFileName(entries: ProjectEntry[], now = new Date()): string {
  const clean = (s: string) =>
    s
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|\n\r]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
  if (entries.length === 1) return `${clean(entries[0].item.sourceName) || 'steno'}${PROJECT_EXT}`
  return `steno-projects-${now.toISOString().slice(0, 10)}${PROJECT_EXT}`
}
