import { describe, expect, it } from 'vitest'
import { buildProject, parseProject, projectFileName } from './project'
import type { HistoryItem } from '../types'

const item = (id: string, name: string): HistoryItem => ({
  id,
  createdAt: 1,
  sourceName: name,
  engineLabel: 'Local',
  modelLabel: 'Whisper Small',
  language: 'en',
  durationSec: 3,
  elapsedSec: 1,
  text: 'Привет, world',
  segments: [{ start: 0, end: 3, text: 'Привет, world', speaker: 'S1' }],
  hasAudio: true,
  speakerNames: { S1: 'Иван' },
})

const bytes = (...n: number[]) => new Blob([new Uint8Array(n)], { type: 'audio/wav' })

describe('project file', () => {
  it('round-trips items and audio bytes', async () => {
    const entries = [
      { item: item('a', 'one.wav'), audio: bytes(1, 2, 3) },
      { item: item('b', 'two.mp4'), audio: bytes(9, 8, 7, 6, 5) },
    ]
    const back = await parseProject(buildProject(entries, true))
    expect(back).toHaveLength(2)
    expect(back[0].item.speakerNames).toEqual({ S1: 'Иван' })
    expect(back[0].item.text).toBe('Привет, world')
    expect([...new Uint8Array(await back[0].audio!.arrayBuffer())]).toEqual([1, 2, 3])
    expect([...new Uint8Array(await back[1].audio!.arrayBuffer())]).toEqual([9, 8, 7, 6, 5])
    expect(back[1].audio!.type).toBe('audio/wav')
  })

  it('without audio the entries are marked as having none', async () => {
    const blob = buildProject([{ item: item('a', 'one.wav'), audio: bytes(1, 2, 3) }], false)
    const back = await parseProject(blob)
    expect(back[0].audio).toBeUndefined()
    expect(back[0].item.hasAudio).toBe(false)
  })

  it('handles entries that have no audio next to ones that do', async () => {
    const entries = [
      { item: item('a', 'one.wav'), audio: null },
      { item: item('b', 'two.wav'), audio: bytes(4, 4) },
    ]
    const back = await parseProject(buildProject(entries, true))
    expect(back[0].audio).toBeUndefined()
    expect([...new Uint8Array(await back[1].audio!.arrayBuffer())]).toEqual([4, 4])
  })

  it('rejects foreign and truncated files', async () => {
    let msg = ''
    await parseProject(new Blob(['hello world, not a project at all'])).catch((e: Error) => (msg = e.message))
    expect(msg).toBe('not-a-project')
    const good = buildProject([{ item: item('a', 'one.wav'), audio: bytes(1, 2, 3, 4) }], true)
    msg = ''
    await parseProject(good.slice(0, good.size - 2)).catch((e: Error) => (msg = e.message))
    expect(msg).toBe('corrupt-project')
  })

  it('names the file after the recording or the date', () => {
    expect(projectFileName([{ item: item('a', 'Meeting: Q4/plan.mp4') }])).toBe('Meeting Q4 plan.steno')
    expect(projectFileName([{ item: item('a', 'x') }, { item: item('b', 'y') }], new Date('2026-11-12T10:00:00Z'))).toBe(
      'steno-projects-2026-11-12.steno',
    )
  })
})
