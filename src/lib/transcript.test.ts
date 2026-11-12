import { describe, expect, it } from 'vitest'
import {
  formatRules,
  joinWithPrevious,
  legacyVersion,
  mergeSpeakerNames,
  mergeSpeakers,
  nameMap,
  nextSpeakerId,
  parseDialog,
  pushVersion,
  snapToWord,
  speakersOf,
  splitSegment,
  toDialog,
} from './transcript'
import type { Segment, TranscriptVersion } from '../types'

const seg = (start: number, end: number, text: string, speaker?: string): Segment =>
  speaker ? { start, end, text, speaker } : { start, end, text }

const name = (id: string) => ({ S1: 'Ivan', S2: 'Anna' })[id] ?? id

describe('speakers', () => {
  const segs = [seg(0, 4, 'Hello', 'S1'), seg(4, 8, 'Hi', 'S2'), seg(8, 9, 'Bye', 'S3')]

  it('lists speakers in order of appearance', () => {
    expect(speakersOf(segs)).toEqual(['S1', 'S2', 'S3'])
  })

  it('merges one speaker into another', () => {
    const out = mergeSpeakers(segs, 'S3', 'S1')
    expect(speakersOf(out)).toEqual(['S1', 'S2'])
    expect(out[2].speaker).toBe('S1')
    expect(segs[2].speaker).toBe('S3') // исходный массив не меняется
  })

  it('merging into itself is a no-op', () => {
    expect(mergeSpeakers(segs, 'S1', 'S1')).toBe(segs)
  })

  it('keeps the target name, inherits the source name when the target has none', () => {
    expect(mergeSpeakerNames({ S1: 'Ivan', S2: 'Anna' }, 'S2', 'S1')).toEqual({ S1: 'Ivan' })
    expect(mergeSpeakerNames({ S2: 'Anna' }, 'S2', 'S1')).toEqual({ S1: 'Anna' })
  })

  it('picks a free speaker id', () => {
    expect(nextSpeakerId(segs)).toBe('S4')
    expect(nextSpeakerId([], ['S1'])).toBe('S2')
  })
})

describe('splitSegment', () => {
  const base = [seg(10, 20, 'How are you today? I am fine thanks', 'S1')]

  it('splits at a word boundary and interpolates time', () => {
    const out = splitSegment(base, 0, 19, 'S2')
    expect(out).toHaveLength(2)
    expect(out[0].text).toBe('How are you today?')
    expect(out[1].text).toBe('I am fine thanks')
    expect(out[0].speaker).toBe('S1')
    expect(out[1].speaker).toBe('S2')
    expect(out[0].end).toBe(out[1].start)
    expect(out[0].start).toBe(10)
    expect(out[1].end).toBe(20)
    expect(out[1].start).toBeGreaterThan(10)
    expect(out[1].start).toBeLessThan(20)
  })

  it('never cuts inside a word', () => {
    const out = splitSegment(base, 0, 7, 'S2') // «How are| you» → ближайшая граница
    expect(base[0].text.startsWith(out[0].text)).toBe(true)
    expect(out[0].text.endsWith(' ')).toBe(false)
    expect(`${out[0].text} ${out[1].text}`).toBe(base[0].text)
  })

  it('does not create an empty half', () => {
    expect(splitSegment(base, 0, 0, 'S2')).toBe(base)
    expect(splitSegment(base, 0, 999, 'S2')).toBe(base)
    expect(splitSegment(base, 5, 3, 'S2')).toBe(base)
  })

  it('join restores the original line', () => {
    const split = splitSegment(base, 0, 19, 'S2')
    const back = joinWithPrevious(split, 1)
    expect(back).toHaveLength(1)
    expect(back[0].text).toBe(base[0].text)
    expect(back[0].start).toBe(10)
    expect(back[0].end).toBe(20)
    expect(joinWithPrevious(split, 0)).toBe(split)
  })

  it('snapToWord prefers the nearest boundary', () => {
    expect(snapToWord('aaa bbbbbb', 5)).toBe(4)
    expect(snapToWord('aaa bbbbbb', 9)).toBe(10)
    expect(snapToWord('aaa bbb', 3)).toBe(3)
  })
})

describe('dialog for the LLM', () => {
  const segs = [
    seg(0, 4, 'Hello there.', 'S1'),
    seg(4.4, 8, 'Hi, how are you?', 'S2'),
    seg(3725, 3730, 'Late line.', 'S1'),
  ]

  it('renders timecodes and speaker names', () => {
    expect(toDialog(segs, name)).toBe(
      '[00:00] Ivan: Hello there.\n[00:04] Anna: Hi, how are you?\n[01:02:05] Ivan: Late line.',
    )
  })

  it('omits the speaker when there is none', () => {
    expect(toDialog([seg(65, 70, 'Solo')], name)).toBe('[01:05] Solo')
  })

  it('round-trips unchanged output and keeps exact times', () => {
    const parsed = parseDialog(toDialog(segs, name), segs, nameMap(segs, name), 3730)!
    expect(parsed.segments).toEqual(segs)
    expect(parsed.newNames).toEqual({})
  })

  it('keeps edited text while preserving timing and speakers', () => {
    const out = '[00:00] Ivan: Hello, there!\n[00:04] Anna: Hi, how are you doing?\n[01:02:05] Ivan: Late line.'
    const parsed = parseDialog(out, segs, nameMap(segs, name))!
    expect(parsed.segments[0].text).toBe('Hello, there!')
    expect(parsed.segments[1].start).toBe(4.4)
    expect(parsed.segments[1].end).toBe(8)
    expect(parsed.segments[1].speaker).toBe('S2')
  })

  it('tolerates markdown bullets and wrapped lines', () => {
    const out = '- **[00:00]** Ivan: Hello\nthere.\n* [00:04] Anna: Hi'
    const parsed = parseDialog(out, segs.slice(0, 2), nameMap(segs, name))!
    expect(parsed.segments).toHaveLength(2)
    expect(parsed.segments[0].text).toBe('Hello there.')
    expect(parsed.segments[1].speaker).toBe('S2')
  })

  it('creates ids for speakers the model invented', () => {
    const out = '[00:00] Ivan: One\n[00:04] Boris: Two'
    const parsed = parseDialog(out, segs.slice(0, 2), nameMap(segs, name))!
    expect(parsed.segments[1].speaker).toBe('S3')
    expect(parsed.newNames).toEqual({ S3: 'Boris' })
  })

  it('handles a merged line by taking the next known time as its end', () => {
    const out = '[00:00] Ivan: Hello there. Hi, how are you?\n[01:02:05] Ivan: Late line.'
    const parsed = parseDialog(out, segs, nameMap(segs, name))!
    expect(parsed.segments).toHaveLength(2)
    expect(parsed.segments[0].end).toBe(4)
  })

  it('returns null when the answer is not a transcript', () => {
    expect(parseDialog('- Greeting\n- Question about health', segs, nameMap(segs, name))).toBeNull()
    expect(parseDialog('', segs, {})).toBeNull()
  })

  it('returns null when the model returned far fewer lines than it was given', () => {
    const many = Array.from({ length: 10 }, (_, i) => seg(i * 5, i * 5 + 5, `Line ${i}`, 'S1'))
    expect(parseDialog('[00:00] Ivan: Everything in one line', many, { Ivan: 'S1' })).toBeNull()
  })
})

describe('LLM rules', () => {
  it('asks to keep the exact form for rewrites', () => {
    const r = formatRules({ structured: true, hasSpeakers: true, keepFormat: true })
    expect(r).toContain('[mm:ss] Speaker: text')
    expect(r).toContain('EXACTLY')
    expect(r).toContain('speaker names')
  })

  it('only describes the structure for free-form answers', () => {
    const r = formatRules({ structured: true, hasSpeakers: true, keepFormat: false })
    expect(r).not.toContain('EXACTLY')
    expect(r).toContain('speaker labels')
  })

  it('adds nothing for unstructured text', () => {
    expect(formatRules({ structured: false, hasSpeakers: false, keepFormat: true })).toBe('')
  })
})

describe('versions', () => {
  const v = (id: string, parentId?: string): TranscriptVersion => ({
    id,
    createdAt: 0,
    kind: 'asr',
    label: id,
    parentId,
    text: '',
    segments: [],
    speakerNames: {},
    durationSec: 0,
    elapsedSec: 0,
    engineLabel: '',
    modelLabel: '',
  })

  it('appends and caps, dropping the oldest leaf but never a parent', () => {
    let list = [v('a'), v('b', 'a')]
    list = pushVersion(list, v('c'), 3)
    list = pushVersion(list, v('d'), 3)
    // «a» — родитель «b», его не трогаем; из листьев старейший — «b»
    expect(list.map((x) => x.id)).toEqual(['a', 'c', 'd'])
  })

  it('builds the first version from a legacy history item', () => {
    const out = legacyVersion({
      id: 'h1',
      createdAt: 5,
      text: 'x',
      segments: [],
      language: 'en',
      durationSec: 1,
      elapsedSec: 2,
      engineLabel: 'Local',
      modelLabel: 'Whisper Small',
    })
    expect(out.id).toBe('h1-v1')
    expect(out.label).toBe('Whisper Small')
    expect(out.speakerNames).toEqual({})
  })
})

import { diffWords, findMatches, removeFillers, replaceInSegments, segmentsFromWords } from './transcript'

describe('search, replace, fillers, diff', () => {
  const segs = [
    { start: 0, end: 2, text: 'Привет, привет мир' },
    { start: 2, end: 4, text: 'Ну, это как бы эээ тест' },
  ]
  it('findMatches counts case-insensitively', () => {
    expect(findMatches(segs, 'привет', false)).toEqual([{ index: 0, count: 2 }])
    expect(findMatches(segs, 'привет', true)).toEqual([{ index: 0, count: 1 }])
  })
  it('replaceInSegments all and one', () => {
    const r = replaceInSegments(segs, 'привет', 'Здравствуйте', false)
    expect(r.count).toBe(2)
    expect(r.segments[0].text).toBe('Здравствуйте, Здравствуйте мир')
    const one = replaceInSegments(segs, 'это', 'то', false, 0)
    expect(one.count).toBe(0)
  })
  it('removeFillers cleans ru fillers and keeps timing', () => {
    const r = removeFillers(segs, 'ru')
    expect(r.count).toBeGreaterThan(0)
    expect(r.segments[1].start).toBe(2)
    expect(/эээ|как бы/.test(r.segments[1].text)).toBe(false)
  })
  it('removeFillers drops empty segment', () => {
    const r = removeFillers([{ start: 0, end: 1, text: 'Эээ...' }, { start: 1, end: 2, text: 'ok' }], 'ru')
    expect(r.segments).toHaveLength(1)
  })
  it('diffWords marks changes', () => {
    const d = diffWords('a b c', 'a x c')
    expect(d.map((o) => o.kind)).toEqual(['same', 'del', 'add', 'same'])
  })
  it('segmentsFromWords splits on sentence end and pause', () => {
    const w = [
      { text: 'Hello', start: 0, end: 0.4 },
      { text: 'world.', start: 0.4, end: 0.9 },
      { text: 'Next', start: 3, end: 3.4 },
      { text: 'one', start: 3.4, end: 3.8 },
    ]
    const s = segmentsFromWords(w)
    expect(s).toHaveLength(2)
    expect(s[0].text).toBe('Hello world.')
    expect(s[1].start).toBe(3)
  })
})
