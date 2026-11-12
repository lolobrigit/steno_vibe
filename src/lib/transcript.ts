// Чистые функции над сегментами расшифровки: спикеры (слияние, разделение
// реплики), версии и текстовое представление диалога для LLM и обратно.
// Без зависимостей от React/DOM — переносится в нативные клиенты как есть
// (см. docs/NATIVE_APPS.md) и проверяется юнит-тестами.

import type { Segment, TranscriptVersion } from '../types'

// ── Спикеры ──────────────────────────────────────────────────────

/** Значение выбора «новый спикер» при разделении реплики. */
export const NEW_SPEAKER = '__new__'

/** Спикеры в порядке первого появления. */
export function speakersOf(segments: Segment[]): string[] {
  const seen: string[] = []
  for (const s of segments) if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker)
  return seen
}

/** Свободный идентификатор вида «S3»: формат тот же, что даёт диаризация. */
export function nextSpeakerId(segments: Segment[], reserved: string[] = []): string {
  const used = new Set([...speakersOf(segments), ...reserved])
  let n = 1
  while (used.has(`S${n}`)) n++
  return `S${n}`
}

/** Объединение спикеров: все реплики `from` переходят к `into`. */
export function mergeSpeakers(segments: Segment[], from: string, into: string): Segment[] {
  if (from === into) return segments
  return segments.map((s) => (s.speaker === from ? { ...s, speaker: into } : s))
}

/**
 * Имена после слияния: имя `into` остаётся; если у него имени не было, оно
 * наследует имя `from` (объединили «Иван» с безымянным S2 — остался «Иван»).
 */
export function mergeSpeakerNames(
  names: Record<string, string>,
  from: string,
  into: string,
): Record<string, string> {
  const next = { ...names }
  const fromName = next[from]
  delete next[from]
  if (!next[into] && fromName) next[into] = fromName
  return next
}

/** Границы слов, ближайшие к позиции: режем по пробелу, а не посреди слова. */
export function snapToWord(text: string, offset: number): number {
  const at = Math.max(0, Math.min(text.length, offset))
  if (at === 0 || at === text.length) return at
  if (/\s/.test(text[at - 1]) || /\s/.test(text[at])) return at
  let left = at
  while (left > 0 && !/\s/.test(text[left - 1])) left--
  let right = at
  while (right < text.length && !/\s/.test(text[right])) right++
  return at - left <= right - at ? left : right
}

/**
 * Разделить реплику на две в позиции `offset` текста. Время второй части —
 * пропорционально числу символов (слова распознавателя без пословных меток).
 * Вторая часть получает `speaker`. Пустую половину не создаём: возвращаем
 * исходный массив.
 */
export function splitSegment(
  segments: Segment[],
  index: number,
  offset: number,
  speaker: string,
): Segment[] {
  const seg = segments[index]
  if (!seg) return segments
  const cut = snapToWord(seg.text, offset)
  const head = seg.text.slice(0, cut).trim()
  const tail = seg.text.slice(cut).trim()
  if (!head || !tail) return segments
  const total = seg.text.length || 1
  const mid = seg.start + (seg.end - seg.start) * (cut / total)
  const first: Segment = { ...seg, text: head, end: mid }
  const second: Segment = { ...seg, text: tail, start: mid, speaker }
  return [...segments.slice(0, index), first, second, ...segments.slice(index + 1)]
}

/** Склеить реплику с предыдущей (отмена ошибочного разделения). */
export function joinWithPrevious(segments: Segment[], index: number): Segment[] {
  const cur = segments[index]
  const prev = segments[index - 1]
  if (!cur || !prev) return segments
  const joined: Segment = {
    ...prev,
    text: `${prev.text} ${cur.text}`.replace(/\s+/g, ' ').trim(),
    end: cur.end,
  }
  return [...segments.slice(0, index - 1), joined, ...segments.slice(index + 1)]
}

export function plainText(segments: Segment[]): string {
  return segments.map((s) => s.text).join(' ')
}

// ── Диалог для LLM и обратно ─────────────────────────────────────

export function hhmmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`
}

/**
 * Расшифровка построчно: «[00:12] Иван: реплика». Это та самая структура
 * разговора, которую получает LLM; без спикеров — «[00:12] реплика».
 */
export function toDialog(segments: Segment[], nameOf: (speaker: string) => string): string {
  return segments
    .map((s) => {
      const who = s.speaker ? ` ${nameOf(s.speaker).replace(/[:\n]/g, ' ').trim()}:` : ''
      return `[${hhmmss(s.start)}]${who} ${s.text.replace(/\s*\n\s*/g, ' ')}`
    })
    .join('\n')
}

const LINE_RE = /^\s*(?:[-*•]\s+)?\**\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]\**\s*(?:([^:\n[\]]{1,60}?)\s*:\s+)?(.*)$/

function tcSeconds(h: string | undefined, m: string, s: string): number {
  return (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s)
}

export interface ParsedDialog {
  segments: Segment[]
  /** спикеры, которых не было в исходнике (LLM придумал или переименовал) */
  newNames: Record<string, string>
}

/**
 * Разобрать ответ LLM обратно в сегменты. Возвращает null, если ответ не
 * похож на расшифровку (например, это краткое содержание) — тогда вызывающий
 * сохраняет его как «плоскую» версию.
 *
 * Время берётся у исходного сегмента с тем же таймкодом (с точностью до
 * секунды), поэтому доли секунды и конец реплики не теряются; незнакомые
 * таймкоды сохраняются как есть. Имена сопоставляются с `nameToId`.
 */
export function parseDialog(
  output: string,
  original: Segment[],
  nameToId: Record<string, string>,
  durationSec = 0,
): ParsedDialog | null {
  const rows: Array<{ tc: number; name: string | null; text: string }> = []
  let nonEmpty = 0
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) continue
    nonEmpty++
    const m = LINE_RE.exec(raw)
    if (m) {
      rows.push({ tc: tcSeconds(m[1], m[2], m[3]), name: m[4]?.trim() || null, text: m[5].trim() })
    } else if (rows.length) {
      // модель перенесла длинную реплику на следующую строку
      const last = rows[rows.length - 1]
      last.text = `${last.text} ${raw.trim()}`.trim()
    }
  }
  const parsed = rows.filter((r) => r.text)
  if (parsed.length === 0 || parsed.length < nonEmpty * 0.5) return null
  if (original.length >= 4 && parsed.length < original.length * 0.3) return null

  const byLower: Record<string, string> = {}
  for (const [name, id] of Object.entries(nameToId)) byLower[name.toLowerCase()] = id
  const newNames: Record<string, string> = {}
  const known = new Set(Object.values(nameToId))
  const pool: Segment[] = original.map((s) => ({ ...s }))
  const mapName = (name: string): string => {
    const hit = byLower[name.toLowerCase()]
    if (hit) return hit
    // имя, придуманное моделью, получает новый идентификатор (одно и то же — один раз)
    const existing = Object.entries(newNames).find(([, n]) => n.toLowerCase() === name.toLowerCase())
    if (existing) return existing[0]
    const id = nextSpeakerId(pool, [...known, ...Object.keys(newNames)])
    newNames[id] = name
    return id
  }

  let ptr = 0
  const out: Segment[] = []
  parsed.forEach((r) => {
    let j = -1
    for (let k = ptr; k < original.length; k++) {
      if (Math.floor(original[k].start) === r.tc) {
        j = k
        break
      }
      if (original[k].start > r.tc + 1) break
    }
    let start = r.tc
    let end = -1
    let speaker: string | undefined
    if (j >= 0) {
      start = original[j].start
      end = original[j].end
      speaker = original[j].speaker
      ptr = j + 1
    }
    if (r.name) speaker = mapName(r.name)
    else if (!speaker && out.length) speaker = out[out.length - 1].speaker
    const seg: Segment = { start, end, text: r.text }
    if (speaker) seg.speaker = speaker
    out.push(seg)
  })
  // конец реплик, которым не нашлось пары: начало следующей или конец записи
  const lastEnd = Math.max(durationSec, original.at(-1)?.end ?? 0)
  for (let i = 0; i < out.length; i++) {
    if (out[i].end >= out[i].start) continue
    const next = out[i + 1]?.start
    out[i].end = next !== undefined && next >= out[i].start ? next : Math.max(lastEnd, out[i].start)
  }
  return { segments: out, newNames }
}

/** Имя → идентификатор для разбора ответа LLM (по отображаемым именам). */
export function nameMap(segments: Segment[], nameOf: (speaker: string) => string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const id of speakersOf(segments)) map[nameOf(id).replace(/[:\n]/g, ' ').trim()] = id
  return map
}

// ── Правила для LLM ──────────────────────────────────────────────

/**
 * Дописка к системному промпту. `keepFormat` — результат должен остаться
 * расшифровкой (исправление, чистка); иначе ответ свободный (краткое
 * содержание, задачи), но структура диалога всё равно описана.
 */
export function formatRules(opts: { structured: boolean; hasSpeakers: boolean; keepFormat: boolean }): string {
  if (!opts.structured) return ''
  const shape = opts.hasSpeakers ? '[mm:ss] Speaker: text' : '[mm:ss] text'
  const intro = `The transcript is given line by line in the form “${shape}”${
    opts.hasSpeakers ? ', so you can see who says what' : ''
  }.`
  if (!opts.keepFormat) return `${intro} Use the speaker labels where they matter.`
  return (
    `${intro} Return it in EXACTLY the same form: one output line per input line, the same timecodes` +
    `${opts.hasSpeakers ? ', the same speaker names' : ''} and the same order. Change only the text of each line. ` +
    'Do not merge, split, add or drop lines, and add no headings, numbering or comments.'
  )
}

// ── Версии ───────────────────────────────────────────────────────

export const MAX_VERSIONS = 15

export function versionNumber(versions: TranscriptVersion[], id: string): number {
  return versions.findIndex((v) => v.id === id) + 1
}

/**
 * Добавить версию. При переполнении удаляется самая старая из тех, что не
 * активны и не являются родителем другой версии.
 */
export function pushVersion(
  versions: TranscriptVersion[],
  next: TranscriptVersion,
  cap = MAX_VERSIONS,
): TranscriptVersion[] {
  const list = [...versions, next]
  while (list.length > cap) {
    const parents = new Set(list.map((v) => v.parentId).filter(Boolean))
    const idx = list.findIndex((v) => v.id !== next.id && !parents.has(v.id))
    list.splice(idx >= 0 ? idx : 0, 1)
  }
  return list
}

/** Версия из «плоской» старой записи истории (до появления версий). */
export function legacyVersion(item: {
  id: string
  createdAt: number
  text: string
  segments: Segment[]
  speakerNames?: Record<string, string>
  language: string
  durationSec: number
  elapsedSec: number
  engineLabel: string
  modelLabel: string
}): TranscriptVersion {
  return {
    id: `${item.id}-v1`,
    createdAt: item.createdAt,
    kind: 'asr',
    label: item.modelLabel || item.engineLabel || 'ASR',
    text: item.text,
    segments: item.segments,
    speakerNames: item.speakerNames ?? {},
    language: item.language,
    durationSec: item.durationSec,
    elapsedSec: item.elapsedSec,
    engineLabel: item.engineLabel,
    modelLabel: item.modelLabel,
  }
}

// ── Поиск и замена ───────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Позиции всех вхождений запроса в тексте реплики. */
export function findInText(text: string, query: string, matchCase: boolean): { at: number; len: number }[] {
  if (!query) return []
  const re = new RegExp(escapeRe(query), matchCase ? 'g' : 'gi')
  const out: { at: number; len: number }[] = []
  for (const m of text.matchAll(re)) out.push({ at: m.index ?? 0, len: m[0].length })
  return out
}

/** Номера реплик, где встречается запрос (с числом вхождений). */
export function findMatches(segments: Segment[], query: string, matchCase: boolean): { index: number; count: number }[] {
  const out: { index: number; count: number }[] = []
  segments.forEach((s, index) => {
    const count = findInText(s.text, query, matchCase).length
    if (count) out.push({ index, count })
  })
  return out
}

/**
 * Заменить запрос на `replacement`: во всех репликах или только в `onlyIndex`.
 * Слова-метки реплики при изменении текста сбрасываются (они больше не совпадают с текстом).
 */
export function replaceInSegments(
  segments: Segment[],
  query: string,
  replacement: string,
  matchCase: boolean,
  onlyIndex?: number,
): { segments: Segment[]; count: number } {
  if (!query) return { segments, count: 0 }
  const re = new RegExp(escapeRe(query), matchCase ? 'g' : 'gi')
  let count = 0
  const next = segments.map((s, i) => {
    if (onlyIndex !== undefined && i !== onlyIndex) return s
    const n = findInText(s.text, query, matchCase).length
    if (!n) return s
    count += n
    const { words: _w, ...rest } = s
    return { ...rest, text: s.text.replace(re, () => replacement) }
  })
  return { segments: count ? next : segments, count }
}

// ── Слова-паразиты ───────────────────────────────────────────────

const FILLERS: Record<string, string[]> = {
  ru: ['э', 'ээ', 'эээ', 'эм', 'эмм', 'мм', 'ммм', 'ну', 'типа', 'как бы', 'так сказать', 'короче', 'значит'],
  en: ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'mm', 'you know', 'i mean', 'like'],
  de: ['äh', 'ähm', 'öh', 'hm', 'also', 'sozusagen'],
  es: ['eh', 'em', 'este', 'o sea', 'pues', 'bueno'],
  fr: ['euh', 'ben', 'bah', 'hein', 'genre', 'en fait'],
  pt: ['é', 'hum', 'tipo', 'né', 'então'],
  it: ['ehm', 'cioè', 'tipo', 'allora', 'insomma'],
  nl: ['eh', 'uh', 'ehm', 'zeg maar', 'nou'],
  pl: ['yyy', 'eee', 'no', 'jakby', 'wiesz', 'znaczy'],
  tr: ['ııı', 'eee', 'yani', 'işte', 'şey'],
  id: ['eh', 'em', 'anu', 'kan', 'gitu'],
}

/**
 * Убрать из реплик «эээ», «um», «как бы» и т. п. Работает только с короткими
 * однозначными междометиями и устойчивыми вставками; реплика, ставшая пустой, удаляется.
 * Язык — код ('ru') или любое слово, начинающееся с него.
 */
export function removeFillers(segments: Segment[], language?: string): { segments: Segment[]; count: number } {
  const code = (language ?? '').slice(0, 2).toLowerCase()
  const list = [...new Set([...(FILLERS[code] ?? []), ...(code === 'ru' || code === 'en' ? [] : [])])]
  if (list.length === 0) return { segments, count: 0 }
  // «длинные» вставки идут первыми, чтобы «как бы» не распалось на «как» + «бы»
  const alt = list.sort((a, b) => b.length - a.length).map(escapeRe).join('|')
  const re = new RegExp(`(^|[\\s,.;:!?—-])(?:${alt})(?=$|[\\s,.;:!?—-])[,]?`, 'giu')
  let count = 0
  const out: Segment[] = []
  for (const s of segments) {
    let hit = 0
    let text = s.text.replace(re, (_m, pre: string) => {
      hit++
      return pre
    })
    text = text.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/^[,.;:\s-]+/, '').trim()
    if (!hit) {
      out.push(s)
      continue
    }
    count += hit
    if (!/[\p{L}\p{N}]/u.test(text)) continue
    const { words: _w, ...rest } = s
    out.push({ ...rest, text: text.charAt(0).toUpperCase() === text.charAt(0) ? text : text.charAt(0).toUpperCase() + text.slice(1) })
  }
  return { segments: count ? out : segments, count }
}

// ── Сравнение версий ─────────────────────────────────────────────

export interface DiffOp {
  kind: 'same' | 'add' | 'del'
  text: string
}

/** Пословное сравнение двух текстов (LCS); подряд идущие слова одного вида склеиваются. */
export function diffWords(a: string, b: string): DiffOp[] {
  const x = a.split(/\s+/).filter(Boolean)
  const y = b.split(/\s+/).filter(Boolean)
  const n = x.length
  const m = y.length
  // защита от квадратичной памяти на очень длинных текстах
  if (n * m > 4_000_000) {
    return [
      { kind: 'del', text: a },
      { kind: 'add', text: b },
    ]
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops: DiffOp[] = []
  const push = (kind: DiffOp['kind'], word: string) => {
    const last = ops[ops.length - 1]
    if (last && last.kind === kind) last.text += ' ' + word
    else ops.push({ kind, text: word })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push('same', x[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', x[i++])
    else push('add', y[j++])
  }
  while (i < n) push('del', x[i++])
  while (j < m) push('add', y[j++])
  return ops
}

// ── Пословные метки → реплики ────────────────────────────────────

/** Собрать реплики из слов: конец — знак окончания фразы, пауза > gap с или слишком длинная реплика. */
export function segmentsFromWords(
  words: { text: string; start: number; end: number }[],
  gap = 0.9,
  maxWords = 28,
): Segment[] {
  const out: Segment[] = []
  let cur: { text: string; start: number; end: number }[] = []
  const flush = () => {
    if (!cur.length) return
    const text = cur.map((w) => w.text.trim()).join(' ').replace(/\s+([,.;:!?])/g, '$1').trim()
    if (text) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text, words: cur })
    cur = []
  }
  words.forEach((w, i) => {
    const prev = cur[cur.length - 1]
    if (prev && w.start - prev.end > gap) flush()
    cur.push(w)
    const next = words[i + 1]
    const ends = /[.!?…]$/.test(w.text.trim())
    if (ends || cur.length >= maxWords || (next && next.start - w.end > gap)) flush()
  })
  flush()
  return out
}
