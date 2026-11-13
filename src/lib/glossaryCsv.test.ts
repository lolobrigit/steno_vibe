import { describe, expect, it } from 'vitest'
import { parseCsv, termsFromCsv, termsToCsv } from './glossaryCsv'

describe('glossary csv', () => {
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
