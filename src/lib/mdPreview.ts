// Минимальный показ Markdown, который выдаёт toMarkdown (заголовок, жирный, код,
// цитата, картинка, абзацы). Это не универсальный парсер Markdown — только для
// предпросмотра собственного экспорта.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

export function mdToHtml(md: string): string {
  const out: string[] = []
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    if (!line) continue
    const img = /^!\[(.*?)\]\((.+)\)$/.exec(line)
    if (img) {
      out.push(`<p><img src="${img[2].replace(/"/g, '%22')}" alt="${esc(img[1])}" style="max-width:100%"><br><small>${esc(img[1])}</small></p>`)
    } else if (line.startsWith('# ')) out.push(`<h1>${inline(line.slice(2))}</h1>`)
    else if (line.startsWith('> ')) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`)
    else out.push(`<p>${inline(line)}</p>`)
  }
  return `<!doctype html><meta charset="utf-8"><style>body{font:15px/1.55 system-ui,sans-serif;max-width:820px;margin:1.5rem auto;padding:0 1rem;color:#222}code{color:#0a6;font-size:12px}blockquote{margin:.1rem 0 .6rem 1rem;color:#666;font-style:italic;border-left:3px solid #ccc;padding-left:.6rem}</style>${out.join('\n')}`
}

/** Для показа исходника: длинные data:-адреса картинок сокращаются. */
export function shortenDataUrls(s: string): string {
  return s.replace(/data:[^)"'\s]{60,}/g, (m) => m.slice(0, 40) + '…')
}
