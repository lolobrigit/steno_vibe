import type { Segment } from '@/types'

function srtTime(sec: number, sep: ',' | '.'): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.round((s % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}${sep}${String(ms).padStart(3, '0')}`
}

export function toTxt(segments: Segment[], fallback: string): string {
  if (segments.length === 0) return fallback
  return segments.map((s) => s.text).join('\n')
}

function hhmmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** Текст с таймкодами и именами спикеров: «[00:12] Иван: реплика». */
export function toTxtStamped(
  segments: Segment[],
  fallback: string,
  speakerName?: (speaker: string) => string,
): string {
  if (segments.length === 0) return fallback
  return segments
    .map((s) => {
      const who = s.speaker ? ` ${speakerName ? speakerName(s.speaker) : s.speaker}:` : ''
      return `[${hhmmss(s.start)}]${who} ${s.text}`
    })
    .join('\n')
}

export function toSrt(segments: Segment[]): string {
  return segments
    .map(
      (s, i) =>
        `${i + 1}\n${srtTime(s.start, ',')} --> ${srtTime(s.end, ',')}\n${s.text}\n`,
    )
    .join('\n')
}

export function toVtt(segments: Segment[]): string {
  const body = segments
    .map((s) => `${srtTime(s.start, '.')} --> ${srtTime(s.end, '.')}\n${s.text}\n`)
    .join('\n')
  return `WEBVTT\n\n${body}`
}

export function downloadFile(name: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// ── Документ со скриншотами (Markdown / HTML) ────────────────────

export interface DocShot {
  /** секунда видео */
  time: number
  /** изображение как data: URL */
  dataUrl: string
}

export interface DocOptions {
  title: string
  segments: Segment[]
  fallbackText: string
  nameOf: (speaker: string) => string
  shots: DocShot[]
  /** подпись «Заметка» в нужном языке */
  noteLabel: string
}

/** Скриншот вставляется после реплики, с которой он начинается (последняя с start ≤ время кадра). */
function shotsByIndex(segments: Segment[], shots: DocShot[]): Map<number, DocShot[]> {
  const map = new Map<number, DocShot[]>()
  for (const sh of [...shots].sort((a, b) => a.time - b.time)) {
    let idx = 0
    segments.forEach((s, i) => {
      if (s.start <= sh.time + 0.01) idx = i
    })
    map.set(idx, [...(map.get(idx) ?? []), sh])
  }
  return map
}

export function toMarkdown(o: DocOptions): string {
  const lines: string[] = [`# ${o.title}`, '']
  if (o.segments.length === 0) return lines.join('\n') + o.fallbackText + '\n'
  const at = shotsByIndex(o.segments, o.shots)
  let prev: string | undefined
  o.segments.forEach((s, i) => {
    if (s.speaker && s.speaker !== prev) lines.push(`**${o.nameOf(s.speaker)}**`, '')
    prev = s.speaker
    lines.push(`\`${hhmmss(s.start)}\` ${s.mark ? '★ ' : ''}${s.text}`, '')
    if (s.note) lines.push(`> ${o.noteLabel}: ${s.note.replace(/\n+/g, ' ')}`, '')
    for (const sh of at.get(i) ?? []) lines.push(`![${hhmmss(sh.time)}](${sh.dataUrl})`, '')
  })
  return lines.join('\n')
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Самодостаточный HTML: открывается в браузере и в Word (с картинками внутри). */
export function toHtml(o: DocOptions): string {
  const at = shotsByIndex(o.segments, o.shots)
  let prev: string | undefined
  const body = o.segments
    .map((s, i) => {
      const who = s.speaker && s.speaker !== prev ? `<p class="who">${esc(o.nameOf(s.speaker))}</p>` : ''
      prev = s.speaker
      const note = s.note ? `<p class="note">${esc(o.noteLabel)}: ${esc(s.note)}</p>` : ''
      const imgs = (at.get(i) ?? [])
        .map((sh) => `<p><img src="${sh.dataUrl}" alt="${hhmmss(sh.time)}" style="max-width:100%"><br><small>${hhmmss(sh.time)}</small></p>`)
        .join('')
      return `${who}<p><code>${hhmmss(s.start)}</code> ${s.mark ? '★ ' : ''}${esc(s.text)}</p>${note}${imgs}`
    })
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.title)}</title>
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem}code{color:#0a6;font-size:12px}.who{font-weight:700;margin:1.2rem 0 .2rem}.note{color:#666;font-style:italic;margin:.1rem 0 .6rem 1rem}</style>
</head><body><h1>${esc(o.title)}</h1>
${o.segments.length ? body : `<p>${esc(o.fallbackText)}</p>`}
</body></html>`
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}
