// Облачные диски для обмена проектами (.steno): Google Диск, Яндекс Диск, Dropbox.
// Всё работает прямо из браузера по OAuth: ключи приложения (Client ID / App key)
// задаются при сборке (VITE_*) или вводятся в окне экспорта; токены живут только
// в этом браузере и недолго.

export type CloudId = 'gdrive' | 'yandex' | 'dropbox'

export interface CloudFile {
  /** идентификатор для скачивания (у Яндекса — путь, у Dropbox/Google — id) */
  id: string
  name: string
  size: number
  modified?: string
}

export type CloudErrorCode =
  | 'no-credential' // не задан Client ID / App key
  | 'popup-blocked'
  | 'closed' // окно входа закрыто
  | 'denied' // пользователь отказал или провайдер вернул ошибку входа
  | 'auth' // токен недействителен или истёк
  | 'network' // сеть или CORS
  | 'http'
  | 'script' // не загрузился скрипт входа Google

export class CloudError extends Error {
  constructor(
    readonly code: CloudErrorCode,
    readonly detail = '',
    readonly status = 0,
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'CloudError'
  }
}

export type Progress = (fraction: number) => void

export interface CloudProvider {
  id: CloudId
  label: string
  /** как называется ключ приложения у провайдера */
  credentialLabel: string
  /** где его взять — ссылка на консоль разработчика */
  consoleUrl: string
  /** ключ приложения: из сборки или введённый пользователем */
  credential(): string
  setCredential(v: string): void
  /** вход выполняет сервер (его креды), ключ вводить не нужно */
  serverManaged?(): boolean
  connected(): boolean
  connect(): Promise<void>
  disconnect(): void
  upload(name: string, blob: Blob, onProgress?: Progress, signal?: AbortSignal): Promise<void>
  list(): Promise<CloudFile[]>
  download(file: CloudFile, onProgress?: Progress, signal?: AbortSignal): Promise<Blob>
}
