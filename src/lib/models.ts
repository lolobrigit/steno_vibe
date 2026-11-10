import type { CloudProvider } from '@/types'

export interface LocalModel {
  id: string
  hfId: string
  label: string
  params: string
  size: string
  speed: string
  quality: 1 | 2 | 3 | 4 | 5
  qualityLabel: string
  bestFor: string
  needsWebGPU?: boolean
}

export interface CloudModel {
  id: string
  provider: CloudProvider
  apiModel: string
  label: string
  quality: 1 | 2 | 3 | 4 | 5
  price: string
  note: string
}

/**
 * Локальные модели Whisper, запускаемые прямо в браузере через
 * transformers.js (ONNX, WebGPU/WASM). Порядок = от быстрой к точной.
 */
export const LOCAL_MODELS: LocalModel[] = [
  {
    id: 'tiny',
    hfId: 'onnx-community/whisper-tiny',
    label: 'Whisper Tiny',
    params: '39M',
    size: '~40 МБ',
    speed: 'очень быстро',
    quality: 1,
    qualityLabel: 'черновая',
    bestFor: 'Быстрые заметки и черновики на чистой речи. Имена и редкие слова путает.',
  },
  {
    id: 'base',
    hfId: 'onnx-community/whisper-base',
    label: 'Whisper Base',
    params: '74M',
    size: '~75 МБ',
    speed: 'быстро',
    quality: 2,
    qualityLabel: 'базовая',
    bestFor: 'Голосовые заметки, диктофон. Для русского всё ещё слабовата.',
  },
  {
    id: 'small',
    hfId: 'onnx-community/whisper-small',
    label: 'Whisper Small',
    params: '244M',
    size: '~250 МБ',
    speed: 'средне',
    quality: 3,
    qualityLabel: 'хорошая',
    bestFor: 'Оптимум для браузера: чистая речь, подкасты, лекции без сильного шума.',
  },
  {
    id: 'large-v3-turbo',
    hfId: 'onnx-community/whisper-large-v3-turbo',
    label: 'Whisper Large v3 Turbo',
    params: '809M',
    size: '~800 МБ',
    speed: 'медленно без GPU',
    quality: 4,
    qualityLabel: 'максимальная локально',
    bestFor: 'Лучшее качество на устройстве: шум, акценты, музыка. Нужен WebGPU (Chrome/Edge).',
    needsWebGPU: true,
  },
]

export const CLOUD_MODELS: CloudModel[] = [
  {
    id: 'groq-turbo',
    provider: 'groq',
    apiModel: 'whisper-large-v3-turbo',
    label: 'Groq · Large v3 Turbo',
    quality: 4,
    price: '~$0.04/час',
    note: 'Лучший баланс: большая модель на быстром железе Groq. Есть бесплатный тариф.',
  },
  {
    id: 'groq-v3',
    provider: 'groq',
    apiModel: 'whisper-large-v3',
    label: 'Groq · Large v3',
    quality: 5,
    price: '~$0.111/час',
    note: 'Максимум качества Whisper, в разы быстрее реального времени.',
  },
  {
    id: 'openai-whisper',
    provider: 'openai',
    apiModel: 'whisper-1',
    label: 'OpenAI · Whisper v2',
    quality: 4,
    price: '$0.36/час',
    note: 'Классический API. Стабильно, поддерживает перевод на английский.',
  },
  {
    id: 'openai-4o',
    provider: 'openai',
    apiModel: 'gpt-4o-transcribe',
    label: 'OpenAI · GPT-4o Transcribe',
    quality: 5,
    price: '$0.36/час',
    note: 'Новая флагманская модель распознавания от OpenAI.',
  },
  {
    id: 'openai-4o-mini',
    provider: 'openai',
    apiModel: 'gpt-4o-mini-transcribe',
    label: 'OpenAI · GPT-4o mini',
    quality: 3,
    price: '$0.18/час',
    note: 'Дешевле и быстрее, качество чуть ниже флагмана.',
  },
  {
    id: 'deepgram-nova3',
    provider: 'deepgram',
    apiModel: 'nova-3',
    label: 'Deepgram · Nova-3',
    quality: 5,
    price: '~$0.26/час',
    note: 'Сильна на деловой речи и телефонии, отдаёт таймкоды по фразам.',
  },
]

export const PROVIDER_INFO: Record<
  CloudProvider,
  { label: string; keyUrl: string; keyPlaceholder: string; keyPrefix: string }
> = {
  openai: {
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
    keyPrefix: 'sk-',
  },
  groq: {
    label: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_...',
    keyPrefix: 'gsk_',
  },
  deepgram: {
    label: 'Deepgram',
    keyUrl: 'https://console.deepgram.com/',
    keyPlaceholder: 'ключ Deepgram',
    keyPrefix: '',
  },
}

export interface LanguageOption {
  code: string
  label: string
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'auto', label: 'Автоопределение' },
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'Английский' },
  { code: 'uk', label: 'Украинский' },
  { code: 'de', label: 'Немецкий' },
  { code: 'es', label: 'Испанский' },
  { code: 'fr', label: 'Французский' },
  { code: 'it', label: 'Итальянский' },
  { code: 'pt', label: 'Португальский' },
  { code: 'pl', label: 'Польский' },
  { code: 'tr', label: 'Турецкий' },
  { code: 'zh', label: 'Китайский' },
  { code: 'ja', label: 'Японский' },
  { code: 'ko', label: 'Корейский' },
]

export interface AiAction {
  id: string
  label: string
  prompt: string
}

export const AI_ACTIONS: AiAction[] = [
  {
    id: 'grammar',
    label: 'Грамматика',
    prompt:
      'Ты — строгий редактор. Исправь орфографию, грамматику и пунктуацию в транскрипте устной речи. Сохрани стиль, порядок мыслей и весь смысл, ничего не добавляй и не сокращай. Верни только исправленный текст, без комментариев.',
  },
  {
    id: 'cleanup',
    label: 'Чистка речи',
    prompt:
      'Убери из транскрипции слова-паразиты, запинки, междометия и повторы. Сделай текст читабельным, сохранив все факты и порядок изложения. Верни только текст, без комментариев.',
  },
  {
    id: 'summary',
    label: 'Саммари',
    prompt:
      'Сделай краткое саммари транскрипции: 3–7 маркированных пунктов с главным. Отвечай на языке исходного текста. Верни только список.',
  },
  {
    id: 'fixup',
    label: 'Корректура терминов',
    prompt:
      'В транскрипте встречаются термины, имена и аббревиатуры, искажённые распознаванием по звучанию. Восстанови их по смыслу и контексту — примеры искажений: «X-remote-юзера» → «X-remote-user», «K-Clock-Ice» → «Keycloak», «GVT» → «JWT», «эйчти-тэпэ» → «HTTP». Исправь только явные искажения терминов и имён, остальной текст не трогай, ничего не сокращай и не добавляй. Верни только исправленный текст целиком, без комментариев и списка правок.',
  },
  {
    id: 'tasks',
    label: 'Задачи',
    prompt:
      'Выдели из транскрипции все поручения и договорённости. Формат каждого пункта: кто — что сделать — срок (если назван). Если поручений нет, напиши об этом одной строкой. Верни только список.',
  },
]

export const QUALITY_GUIDE = [  {
    tier: 'Черновик',
    model: 'Whisper Tiny / Base · локально',
    text: 'Скорость важнее точности: голосовые заметки, поиск по записи. Ошибки на именах и терминах.',
  },
  {
    tier: 'Рабочее качество',
    model: 'Whisper Small · локально',
    text: 'Чистая речь без шума: подкасты, лекции, интервью один-на-один. Приемлемый русский.',
  },
  {
    tier: 'Высокое · локально',
    model: 'Whisper Large v3 Turbo · WebGPU',
    text: 'Максимум без отправки файлов: шум, акценты, музыка, многоязычие. Нужен Chrome/Edge с GPU.',
  },
  {
    tier: 'Высокое · облако',
    model: 'Groq Large v3 Turbo',
    text: 'То же качество большой модели, но без загрузки 800 МБ и почти мгновенно. Файл уходит в сервис.',
  },
  {
    tier: 'Максимум',
    model: 'Groq Large v3 · OpenAI GPT-4o · Deepgram Nova-3',
    text: 'Деловые звонки, телефония, сложная запись. Nova-3 особенно хороша на перебиваниях и телефонном канале.',
  },
]
