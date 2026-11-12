export interface Segment {
  start: number
  end: number
  text: string
  speaker?: string
  /** закладка на реплике */
  mark?: boolean
  /** комментарий к реплике (в экспорт текста не попадает) */
  note?: string
  /** пословные метки (если включены у локального Whisper) */
  words?: { text: string; start: number; end: number }[]
}

export interface TranscriptResult {
  text: string
  segments: Segment[]
  language?: string
  durationSec: number
  elapsedSec: number
  engineLabel: string
  modelLabel: string
}

export type EngineMode = 'local' | 'cloud'
export type CloudProvider = 'openai' | 'groq' | 'deepgram'

export type TranscribePhase =
  | 'idle'
  | 'loading-model'
  | 'transcribing'
  | 'done'
  | 'error'

export interface LoadProgress {
  file: string
  progress: number // 0..100
  loaded: number
  total: number
}

export interface QueueItem {
  id: string
  name: string
  file: File
  status: 'pending' | 'processing' | 'done' | 'error'
  error?: string
}

/**
 * Версия расшифровки. Распознавание, результат LLM и ручная правка не затирают
 * друг друга: каждая попытка — отдельная версия, к любой можно вернуться и
 * продолжить с ней работать (в том числе через LLM).
 */
export interface TranscriptVersion {
  id: string
  createdAt: number
  /** asr — распознавание, llm — результат обработки, edit — копия для ручной правки */
  kind: 'asr' | 'llm' | 'edit'
  /** подпись для списка версий: «Whisper Small», «Грамматика · Qwen3» */
  label: string
  /** версия, из которой получена эта (для LLM и копий) */
  parentId?: string
  text: string
  /** пустой массив — «плоская» версия: LLM вернул текст не в формате расшифровки */
  segments: Segment[]
  speakerNames: Record<string, string>
  language?: string
  durationSec: number
  elapsedSec: number
  engineLabel: string
  modelLabel: string
}

export interface HistoryItem {
  id: string
  createdAt: number
  sourceName: string
  engineLabel: string
  modelLabel: string
  language: string
  durationSec: number
  elapsedSec: number
  text: string
  segments: Segment[]
  /** есть ли сохранённое аудио в IndexedDB */
  hasAudio?: boolean
  /** пользовательские имена спикеров: «Спикер 1» → «Иван» */
  speakerNames?: Record<string, string>
  /**
   * Версии расшифровки. В localStorage не хранятся (переполнят его): лежат в
   * IndexedDB (lib/versionStore.ts), а text/segments/speakerNames выше — копия
   * активной версии. Поле заполняется при экспорте проекта.
   */
  versions?: TranscriptVersion[]
  activeVersionId?: string
}
