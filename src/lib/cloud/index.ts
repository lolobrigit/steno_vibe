import { dropbox } from './dropbox'
import { gdrive } from './gdrive'
import { yandex } from './yandex'
import type { CloudId, CloudProvider } from './types'

export const PROVIDERS: Record<CloudId, CloudProvider> = { gdrive, yandex, dropbox }
export const PROVIDER_LIST: CloudProvider[] = [gdrive, yandex, dropbox]
export { handleOAuthRedirect, redirectUri } from './oauth'
export { CloudError } from './types'
export type { CloudFile, CloudId, CloudProvider, CloudErrorCode } from './types'
