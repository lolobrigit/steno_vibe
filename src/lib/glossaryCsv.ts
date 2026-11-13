// Справочники терминов ⇄ CSV. Один термин — одна строка; пара «слово → расшифровка»
// хранится как «слово = расшифровка» (так её понимают Whisper-подсказка и LLM).

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

const HEADERS = new Set(['term', 'terms', 'word', 'термин', 'слово', 'термины'])

/** Строки CSV → термины. Первая колонка — термин, вторая (если есть) — расшифровка; заголовок пропускается. */
export function termsFromCsv(text: string): string[] {
  const rows = parseCsv(text)
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some(Boolean))
  if (rows.length && HEADERS.has(rows[0][0].toLowerCase())) rows.shift()
  const out: string[] = []
  for (const r of rows) {
    const term = r[0]
    if (!term) continue
    out.push(r[1] ? `${term} = ${r[1]}` : term)
  }
  return [...new Set(out)]
}

function cell(v: string): string {
  return /[",;\n\r\t]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** Термины → CSV (две колонки: term, replacement). */
export function termsToCsv(terms: string[]): string {
  const lines = ['term,replacement']
  for (const t of terms) {
    const i = t.indexOf(' = ')
    lines.push(i > 0 ? `${cell(t.slice(0, i).trim())},${cell(t.slice(i + 3).trim())}` : cell(t))
  }
  return lines.join('\r\n') + '\r\n'
}
