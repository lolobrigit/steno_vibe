import { useCallback, useMemo, useRef, useState } from 'react'
import type { HistoryItem, TranscriptResult, TranscriptVersion } from '@/types'
import { updateHistory } from '@/lib/storage'
import { loadVersions, saveVersions } from '@/lib/versionStore'
import { legacyVersion, pushVersion } from '@/lib/transcript'

interface DocState {
  versions: TranscriptVersion[]
  activeId: string | null
}

const EMPTY: DocState = { versions: [], activeId: null }

export type NewVersion = Omit<TranscriptVersion, 'id' | 'createdAt'>

/**
 * Документ расшифровки: версии текущей записи, активная версия и правки.
 * Показываемый результат (`result`, `speakerNames`) — всегда активная версия:
 * переключили версию — LLM, экспорт и плеер работают уже с ней.
 *
 * Версии хранятся в IndexedDB; в запись истории (localStorage) зеркалится
 * только активная версия — для списка истории и быстрого открытия.
 */
export function useTranscriptDoc(onHistory: (list: HistoryItem[]) => void) {
  const [state, setStateRaw] = useState<DocState>(EMPTY)
  const stateRef = useRef<DocState>(EMPTY)
  const historyIdRef = useRef<string | null>(null)

  const setState = useCallback((next: DocState) => {
    stateRef.current = next
    setStateRaw(next)
  }, [])

  const persist = useCallback(
    (next: DocState) => {
      const id = historyIdRef.current
      const active = next.versions.find((v) => v.id === next.activeId)
      if (!id || !active) return
      void saveVersions({ id, versions: next.versions, activeVersionId: active.id })
      onHistory(
        updateHistory(id, {
          text: active.text,
          segments: active.segments,
          speakerNames: active.speakerNames,
          language: active.language ?? '—',
          durationSec: active.durationSec,
          elapsedSec: active.elapsedSec,
          engineLabel: active.engineLabel,
          modelLabel: active.modelLabel,
          activeVersionId: active.id,
        }),
      )
    },
    [onHistory],
  )

  const commit = useCallback(
    (next: DocState) => {
      setState(next)
      persist(next)
    },
    [persist, setState],
  )

  const active = useMemo(
    () => state.versions.find((v) => v.id === state.activeId) ?? null,
    [state],
  )

  const result = useMemo<TranscriptResult | null>(
    () =>
      active
        ? {
            text: active.text,
            segments: active.segments,
            language: active.language,
            durationSec: active.durationSec,
            elapsedSec: active.elapsedSec,
            engineLabel: active.engineLabel,
            modelLabel: active.modelLabel,
          }
        : null,
    [active],
  )

  /** Новая или другая запись: версии сбрасываются. */
  const reset = useCallback(
    (historyId: string | null = null) => {
      historyIdRef.current = historyId
      setState(EMPTY)
    },
    [setState],
  )

  /** Открыть запись истории: версии из IndexedDB, для старых записей — одна версия из текста. */
  const open = useCallback(
    async (item: HistoryItem) => {
      historyIdRef.current = item.id
      const stored = await loadVersions(item.id)
      if (historyIdRef.current !== item.id) return // за время загрузки открыли другую
      if (stored && stored.versions.length > 0) {
        const activeId = stored.versions.some((v) => v.id === stored.activeVersionId)
          ? stored.activeVersionId
          : stored.versions[stored.versions.length - 1].id
        setState({ versions: stored.versions, activeId })
      } else if (item.text) {
        const v = legacyVersion(item)
        setState({ versions: [v], activeId: v.id })
      } else {
        setState(EMPTY)
      }
    },
    [setState],
  )

  /** Добавить версию и сделать её активной. */
  const addVersion = useCallback(
    (v: NewVersion, historyId?: string): TranscriptVersion => {
      if (historyId) historyIdRef.current = historyId
      const full: TranscriptVersion = { ...v, id: crypto.randomUUID(), createdAt: Date.now() }
      commit({
        versions: pushVersion(stateRef.current.versions, full),
        activeId: full.id,
      })
      return full
    },
    [commit],
  )

  const select = useCallback(
    (id: string) => {
      const cur = stateRef.current
      if (cur.activeId === id || !cur.versions.some((v) => v.id === id)) return
      commit({ ...cur, activeId: id })
    },
    [commit],
  )

  /** Правка активной версии на месте (спикеры, разбиение реплик). */
  const update = useCallback(
    (fn: (v: TranscriptVersion) => TranscriptVersion) => {
      const cur = stateRef.current
      const a = cur.versions.find((v) => v.id === cur.activeId)
      if (!a) return
      const next = fn(a)
      if (next === a) return
      commit({ ...cur, versions: cur.versions.map((v) => (v.id === a.id ? next : v)) })
    },
    [commit],
  )

  /** Удалить версию (последнюю оставшуюся — нельзя). */
  const remove = useCallback(
    (id: string) => {
      const cur = stateRef.current
      const victim = cur.versions.find((v) => v.id === id)
      if (!victim || cur.versions.length <= 1) return
      const versions = cur.versions
        .filter((v) => v.id !== id)
        .map((v) => (v.parentId === id ? { ...v, parentId: victim.parentId } : v))
      const activeId = cur.activeId === id ? versions[versions.length - 1].id : cur.activeId
      commit({ versions, activeId })
    },
    [commit],
  )

  return {
    versions: state.versions,
    activeId: state.activeId,
    active,
    result,
    speakerNames: active?.speakerNames ?? EMPTY_NAMES,
    reset,
    open,
    addVersion,
    select,
    update,
    remove,
  }
}

const EMPTY_NAMES: Record<string, string> = {}
