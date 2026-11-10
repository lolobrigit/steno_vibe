import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm|mp4|mov|mkv|m4v|avi)$/i
const POLL_MS = 5000

type DirPicker = () => Promise<FileSystemDirectoryHandle>

type DirEntries = {
  values: () => AsyncIterableIterator<FileSystemHandle>
}

/**
 * Слежение за папкой через File System Access API (Chrome/Edge).
 * При выборе папки существующие файлы только регистрируются;
 * новые аудиофайлы уходят в onNewFile. Работает, пока открыта вкладка.
 */
export function useFolderWatch(onNewFile: (file: File) => void) {
  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window
  const [folderName, setFolderName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const handleRef = useRef<FileSystemDirectoryHandle | null>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const timerRef = useRef(0)
  const onNewRef = useRef(onNewFile)
  onNewRef.current = onNewFile

  const stop = useCallback(() => {
    window.clearInterval(timerRef.current)
    timerRef.current = 0
    handleRef.current = null
    setFolderName(null)
  }, [])

  const scan = useCallback(
    async (initial: boolean) => {
      const handle = handleRef.current
      if (!handle) return
      try {
        for await (const entry of (handle as FileSystemDirectoryHandle & DirEntries).values()) {
          if (entry.kind !== 'file' || !AUDIO_EXT.test(entry.name)) continue
          const file = await (entry as FileSystemFileHandle).getFile()
          const key = `${file.name}:${file.size}:${file.lastModified}`
          if (seenRef.current.has(key)) continue
          seenRef.current.add(key)
          if (!initial) onNewRef.current(file)
        }
        setError(null)
      } catch {
        setError(t('folder.err.lost'))
        stop()
      }
    },
    [stop],
  )

  const pick = useCallback(async () => {
    try {
      const handle = await (window as unknown as { showDirectoryPicker: DirPicker }).showDirectoryPicker()
      handleRef.current = handle
      seenRef.current = new Set()
      setFolderName(handle.name)
      setError(null)
      await scan(true) // существующие файлы помечаем, не обрабатываем
      timerRef.current = window.setInterval(() => void scan(false), POLL_MS)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(t('folder.err.open'))
    }
  }, [scan])

  useEffect(
    () => () => {
      window.clearInterval(timerRef.current)
    },
    [],
  )

  return { supported, folderName, watching: folderName !== null, error, pick, stop }
}
