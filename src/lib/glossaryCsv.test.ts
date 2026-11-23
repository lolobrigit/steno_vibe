import { describe, expect, it } from 'vitest'
import {
  entryToFlat,
  entriesFromCsv,
  entriesToCsv,
  flatToEntry,
  parseCsv,
  termsFromCsv,
  termsToCsv,
} from './glossaryCsv'

describe('glossary csv — legacy flat API', () => {
  it('one term per line', () => {
    expect(termsFromCsv('Keycloak\nJWT\n\nKeycloak')).toEqual(['Keycloak', 'JWT'])
  })
  it('two columns become "a = b", header skipped', () => {
    expect(termsFromCsv('term,replacement\nК-клок,Keycloak\nGVT,JWT')).toEqual(['К-клок = Keycloak', 'GVT = JWT'])
  })
  it('semicolon delimiter and quotes', () => {
    expect(parseCsv('a;"b;c"\n"x ""y""";z')).toEqual([['a', 'b;c'], ['x "y"', 'z']])
  })
  it('round trip', () => {
    const terms = ['Keycloak', 'К-клок = Keycloak', 'a,b = c']
    expect(termsFromCsv(termsToCsv(terms))).toEqual(terms)
  })
  it('handles BOM and CRLF', () => {
    expect(termsFromCsv('﻿слово\r\nтест\r\n')).toEqual(['тест'])
  })
})

describe('glossary entries — three columns', () => {
  it('parses header term,replacement,note', () => {
    expect(
      entriesFromCsv('term,replacement,note\nК-клок,Keycloak,система SSO\nJWT,,токены\n'),
    ).toEqual([
      { term: 'К-клок', replacement: 'Keycloak', note: 'система SSO' },
      { term: 'JWT', replacement: undefined, note: 'токены' },
    ])
  })

  it('recognizes russian header synonyms', () => {
    expect(
      entriesFromCsv('термин,расшифровка,пояснение\nДЖИВЕ,JWT,JSON Web Token'),
    ).toEqual([{ term: 'ДЖИВЕ', replacement: 'JWT', note: 'JSON Web Token' }])
  })

  it('no header → first three columns by position', () => {
    expect(entriesFromCsv('Keycloak\nК-клок,Keycloak\nGVT,JWT,токены')).toEqual([
      { term: 'Keycloak', replacement: undefined, note: undefined },
      { term: 'К-клок', replacement: 'Keycloak', note: undefined },
      { term: 'GVT', replacement: 'JWT', note: 'токены' },
    ])
  })

  it('dedupes is NOT done by entriesFromCsv (storage layer dedupes)', () => {
    const out = entriesFromCsv('Keycloak\nKeycloak')
    expect(out).toHaveLength(2)
  })

  it('round trips three columns', () => {
    const entries = [
      { term: 'Keycloak', replacement: undefined, note: undefined },
      { term: 'К-клок', replacement: 'Keycloak', note: 'система единого входа' },
      { term: 'GVT', replacement: 'JWT', note: undefined },
    ]
    expect(entriesFromCsv(entriesToCsv(entries))).toEqual(entries)
  })

  it('quotes cells with commas and newlines', () => {
    const entries = [{ term: 'a,b', replacement: 'c\nd', note: 'e;f' }]
    const csv = entriesToCsv(entries)
    expect(csv).toContain('"a,b"')
    expect(csv).toContain('"c\nd"')
    expect(entriesFromCsv(csv)).toEqual(entries)
  })
})

describe('flat ⇄ entry', () => {
  it('flatToEntry: plain term', () => {
    expect(flatToEntry('Keycloak')).toEqual({ term: 'Keycloak' })
  })
  it('flatToEntry: a = b', () => {
    expect(flatToEntry('К-клок = Keycloak')).toEqual({ term: 'К-клок', replacement: 'Keycloak' })
  })
  it('entryToFlat round trip', () => {
    expect(entryToFlat(flatToEntry('К-клок = Keycloak'))).toBe('К-клок = Keycloak')
    expect(entryToFlat({ term: 'JWT' })).toBe('JWT')
  })
})
