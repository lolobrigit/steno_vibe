export interface Segment {
  start: number
  end: number
  text: string
  speaker?: string
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
}
