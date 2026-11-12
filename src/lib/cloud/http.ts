import { CloudError } from './types'

export interface HttpResult {
  status: number
  /** text или blob — по responseType */
  body: string | Blob
  header: (name: string) => string | null
}

/**
 * XMLHttpRequest вместо fetch: только он отдаёт прогресс загрузки на сервер.
 * Статусы не-2xx не бросают исключение — решает вызывающий; бросает только
 * сетевая ошибка (в браузере к ней же относится и запрет CORS).
 */
export function xhr(o: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: Blob | string | null
  responseType?: 'text' | 'blob'
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest()
    req.open(o.method, o.url)
    req.responseType = o.responseType ?? 'text'
    for (const [k, v] of Object.entries(o.headers ?? {})) req.setRequestHeader(k, v)
    if (o.onProgress) {
      req.upload.onprogress = (e) => e.lengthComputable && o.onProgress!(e.loaded / e.total)
      req.onprogress = (e) => {
        if (o.responseType === 'blob' && e.lengthComputable) o.onProgress!(e.loaded / e.total)
      }
    }
    req.onload = () =>
      resolve({
        status: req.status,
        body: req.response as string | Blob,
        header: (n) => req.getResponseHeader(n),
      })
    req.onerror = () => reject(new CloudError('network'))
    req.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    const abort = () => req.abort()
    if (o.signal) {
      if (o.signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
      o.signal.addEventListener('abort', abort, { once: true })
      req.onloadend = () => o.signal!.removeEventListener('abort', abort)
    }
    req.send(o.body ?? null)
  })
}

/** Разобрать JSON-ответ или бросить понятную ошибку по статусу. */
export async function json<T>(res: HttpResult): Promise<T> {
  const text = typeof res.body === 'string' ? res.body : await (res.body as Blob).text()
  if (res.status === 401) throw new CloudError('auth', '', 401)
  if (res.status < 200 || res.status >= 300) {
    let detail = text.slice(0, 200)
    try {
      const j = JSON.parse(text) as { error?: unknown; error_summary?: string; message?: string }
      detail =
        j.error_summary ??
        j.message ??
        (typeof j.error === 'string' ? j.error : ((j.error as { message?: string })?.message ?? detail))
    } catch {
      /* не JSON */
    }
    throw new CloudError('http', detail, res.status)
  }
  return (text ? JSON.parse(text) : {}) as T
}

export function ok(res: HttpResult): void {
  if (res.status === 401) throw new CloudError('auth', '', 401)
  if (res.status < 200 || res.status >= 300) throw new CloudError('http', '', res.status)
}
