import { useEffect, useRef, useState } from 'react'

interface WaveformProps {
  /** уровни 0..1; live-режим подсвечивает хвост cyan-цветом */
  levels: number[]
  live?: boolean
  /** 0..1 — прогресс обработки (заливка слева) */
  progress?: number
  height?: number
}

export function Waveform({ levels, live = false, progress, height = 88 }: WaveformProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  // перерисовка при смене темы (атрибут data-theme на <html>)
  const [themeTick, setThemeTick] = useState(0)

  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick((t) => t + 1))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = canvas.clientWidth
    const h = height
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    const n = levels.length
    const gap = 2
    const bw = Math.max(2, (w - gap * (n - 1)) / n)
    const mid = h / 2

    // цвета из CSS-переменных текущей темы
    const css = getComputedStyle(document.documentElement)
    const primary = css.getPropertyValue('--primary').trim() || '187 85% 53%'
    const track = css.getPropertyValue('--track').trim() || '218 39% 22%'
    const cPrimary = (a: number) => `hsl(${primary.split(' ').join(' ')} / ${a})`
    const cTrack = (a: number) => `hsl(${track} / ${a})`

    for (let i = 0; i < n; i++) {
      const v = Math.max(0.02, levels[i] ?? 0)
      const bh = Math.max(2, v * (h - 8))
      const x = i * (bw + gap)
      const inProgress = progress !== undefined && i / n <= progress

      if (inProgress) {
        ctx.fillStyle = cPrimary(0.95)
      } else if (live) {
        const tail = i > n - 14
        ctx.fillStyle = tail ? cPrimary(0.9) : cTrack(0.85)
      } else {
        ctx.fillStyle = cTrack(0.8)
      }
      const y = mid - bh / 2
      ctx.beginPath()
      ctx.roundRect(x, y, bw, bh, bw / 2)
      ctx.fill()
    }
  }, [levels, live, progress, height, themeTick])

  return (
    <canvas
      ref={ref}
      style={{ height }}
      className="w-full block"
      aria-hidden="true"
    />
  )
}
