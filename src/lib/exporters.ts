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
