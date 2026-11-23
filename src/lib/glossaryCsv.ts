// Справочники терминов ⇄ CSV. Запись — три колонки: term, replacement, note.
// Совместимо со старым форматом «слово = расшифровка» в одной строке: при
// загрузке мигрирует в { term, replacement }, note остаётся пустым.

import type { GlossaryEntry } from './storage'

/** Простой разбор CSV с кавычками; разделитель определяется по первой строке (, ; или табуляция). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const first = src.split(/\r?\n/, 1)[0] ?? ''
  const count = (c: string) => first.split(c).length - 1
  const delim = [';', '\t', ','].reduce((best, c) => (count(c) > count(best) ? c : best), ',')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delim) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

const TERM_HEADERS = new Set(['term', 'terms', 'word', 'термин', 'слово', 'термины'])
const REPLACEMENT_HEADERS = new Set([
  'replacement', 'transcription', 'transcribe', 'canonical', 'расшифровка',
  'замена', 'канон', 'вариант',
])
const NOTE_HEADERS = new Set([
  'note', 'notes', 'comment', 'description', 'context', 'category', 'definition',
  'пояснение', 'комментарий', 'описание', 'категория', 'определение', 'пример',
])

/** Плоская строка «a = b» (или просто «a») → запись. */
export function flatToEntry(flat: string): GlossaryEntry {
  const s = flat.trim()
  const i = s.indexOf(' = ')
  if (i > 0) return { term: s.slice(0, i).trim(), replacement: s.slice(i + 3).trim() || undefined }
  return { term: s }
}

/** Запись → плоская строка «term = replacement» (или просто «term»). note теряется. */
export function entryToFlat(e: GlossaryEntry): string {
  const term = e.term.trim()
  const repl = e.replacement?.trim()
  return repl ? `${term} = ${repl}` : term
}

/**
 * CSV → записи. Поддерживает заголовки (term/replacement/note, включая
 * русские синонимы); без заголовка первая колонка — term, вторая — replacement,
 * третья — note. Лишние колонки игнорируются.
 */
export function entriesFromCsv(text: string): GlossaryEntry[] {
  const rows = parseCsv(text).map((r) => r.map((c) => c.trim()))
  let termIdx = 0
  let replIdx = 1
  let noteIdx = 2
  // первая непустая строка может быть заголовком
  const firstNonEmpty = rows.find((r) => r.some(Boolean))
  if (firstNonEmpty) {
    const lower = firstNonEmpty.map((c) => c.toLowerCase())
    const isHeader = lower.some((c) =>
      TERM_HEADERS.has(c) || REPLACEMENT_HEADERS.has(c) || NOTE_HEADERS.has(c),
    )
    if (isHeader) {
      termIdx = lower.findIndex((c) => TERM_HEADERS.has(c))
      replIdx = lower.findIndex((c) => REPLACEMENT_HEADERS.has(c))
      noteIdx = lower.findIndex((c) => NOTE_HEADERS.has(c))
      if (termIdx < 0) termIdx = 0
      if (replIdx < 0) replIdx = -1
      if (noteIdx < 0) noteIdx = -1
      // отбрасываем строку заголовка
      const headerRowIdx = rows.indexOf(firstNonEmpty)
      rows.splice(headerRowIdx, 1)
    }
  }
  const out: GlossaryEntry[] = []
  for (const r of rows) {
    if (!r.some(Boolean)) continue
    const term = r[termIdx] ?? ''
    if (!term) continue
    const replacement = replIdx >= 0 ? (r[replIdx] ?? '').trim() : ''
    const note = noteIdx >= 0 ? (r[noteIdx] ?? '').trim() : ''
    out.push({
      term,
      replacement: replacement || undefined,
      note: note || undefined,
    })
  }
  return out
}

function cell(v: string): string {
  return /[",;\n\r\t]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** Записи → CSV (заголовок term,replacement,note + строки; пустые ячейки пустые). */
export function entriesToCsv(entries: GlossaryEntry[]): string {
  const lines = ['term,replacement,note']
  for (const e of entries) {
    lines.push([cell(e.term), cell(e.replacement ?? ''), cell(e.note ?? '')].join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

// ── Совместимость со старым API (плоские строки «a = b») ──────────
// Используется только тестами и переходным кодом; новый UI работает с записями.

/** @deprecated используйте entriesFromCsv */
export function termsFromCsv(text: string): string[] {
  return entriesFromCsv(text).map(entryToFlat)
}

/** @deprecated используйте entriesToCsv */
export function termsToCsv(terms: string[]): string {
  return entriesToCsv(terms.map(flatToEntry))
}
