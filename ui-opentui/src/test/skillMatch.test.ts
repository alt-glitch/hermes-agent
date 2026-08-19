/**
 * skillMatch table tests (Epic 6) — the pure tokenizer/matcher behind the
 * composer's skill highlighting + one-edit autocorrect. Pins the anti-jank
 * boundary rules: start-of-message detection, standalone-token extraction
 * (paths are never tokens), exact-match vs one-edit-away (Damerau-Levenshtein /
 * OSA distance 1), and mid-prose = highlight-only / suggestion-never.
 */
import { describe, expect, test } from 'vitest'

import {
  analyzeSlash,
  isOneEdit,
  learnableNames,
  nativeCharOffset,
  slashTokens,
  type SlashToken
} from '../logic/skillMatch.ts'

const NAMES = new Set(['commit', 'help', 'model', 'copy', 'skills'])

const tok = (name: string, start: number, over: Partial<SlashToken> = {}): SlashToken => ({
  end: start + 1 + name.length,
  lead: start === 0,
  name,
  start,
  ...over
})

describe('slashTokens — boundary rules', () => {
  test.each<[string, string, SlashToken[]]>([
    ['lead token at message start', '/commit', [tok('commit', 0)]],
    ['lead token with args', '/commit -m foo', [tok('commit', 0)]],
    ['mid-prose token after a space', 'use /commit here', [tok('commit', 4)]],
    ['token after a newline', 'hello\n/help', [tok('help', 6)]],
    ['multiple tokens', '/help and /model', [tok('help', 0), tok('model', 10)]],
    ['a/b path is NOT a token', 'see the a/b path', []],
    ['slash glued to a word is NOT a token', 'foo/bar', []],
    ['absolute path is NOT a token (slash in body)', '/usr/bin', []],
    ['relative path is NOT a token', './run it', []],
    ['bare slash is NOT a token', '/', []],
    ['bare slash mid-prose is NOT a token', 'say / something', []],
    ['empty text', '', []],
    ['name charset: dots and dashes ok', '/skill-name.v2', [tok('skill-name.v2', 0)]],
    ['name must start alphanumeric', '/-flag', []]
  ])('%s', (_name, text, expected) => {
    expect(slashTokens(text)).toEqual(expected)
  })
})

describe('isOneEdit — Damerau-Levenshtein (OSA) distance 1', () => {
  test.each<[string, string, string, boolean]>([
    ['substitution', 'comjit', 'commit', true],
    ['adjacent transposition', 'hlep', 'help', true],
    ['deletion (typed an extra char)', 'helpp', 'help', true],
    ['insertion (missed a char)', 'comit', 'commit', true],
    ['identical = zero edits, not one', 'help', 'help', false],
    ['two substitutions', 'hxlx', 'help', false],
    ['two edits via lengths', 'he', 'help', false],
    ['non-adjacent swap is two edits', 'pleh', 'help', false],
    ['case-sensitive: one case flip is one edit', 'Help', 'help', true],
    ['case-sensitive: full upcase is far', 'HELP', 'help', false],
    ['empty vs one char', '', 'a', true],
    ['empty vs two chars', '', 'ab', false]
  ])('%s: %s ↔ %s → %s', (_name, a, b, expected) => {
    expect(isOneEdit(a, b)).toBe(expected)
    expect(isOneEdit(b, a)).toBe(expected) // symmetric
  })
})

describe('analyzeSlash — highlight + suggestion decision table', () => {
  test('/commit at start = exact match → highlight, no suggestion', () => {
    const a = analyzeSlash('/commit', NAMES)
    expect(a.highlights).toEqual([tok('commit', 0)])
    expect(a.suggestion).toBeNull()
  })

  test('/comit at start = one-edit → suggestion `commit`, no highlight', () => {
    const a = analyzeSlash('/comit', NAMES)
    expect(a.highlights).toEqual([])
    expect(a.suggestion).toEqual({ from: 1, name: 'commit' })
  })

  test('a/b path = nothing', () => {
    const a = analyzeSlash('see the a/b path', NAMES)
    expect(a.highlights).toEqual([])
    expect(a.suggestion).toBeNull()
  })

  test('mid-prose exact token = highlight ONLY (never a suggestion)', () => {
    const a = analyzeSlash('use /commit here', NAMES)
    expect(a.highlights).toEqual([tok('commit', 4)])
    expect(a.suggestion).toBeNull()
  })

  test('mid-prose near-miss token = nothing (anti-jank)', () => {
    const a = analyzeSlash('use /comit here', NAMES)
    expect(a.highlights).toEqual([])
    expect(a.suggestion).toBeNull()
  })

  test('/xyzzy = nothing (no exact, nothing within one edit)', () => {
    const a = analyzeSlash('/xyzzy', NAMES)
    expect(a.highlights).toEqual([])
    expect(a.suggestion).toBeNull()
  })

  test('case sensitivity per catalog: /Commit is not exact but IS one edit → suggests', () => {
    const a = analyzeSlash('/Commit', NAMES)
    expect(a.highlights).toEqual([])
    expect(a.suggestion).toEqual({ from: 1, name: 'commit' })
  })

  test('case sensitivity per catalog: /COMMIT = nothing', () => {
    const a = analyzeSlash('/COMMIT', NAMES)
    expect(a.highlights).toEqual([])
    expect(a.suggestion).toBeNull()
  })

  test('suggestion only while the message IS the bare token: `/comit foo` → nothing', () => {
    const a = analyzeSlash('/comit foo', NAMES)
    expect(a.highlights).toEqual([])
    expect(a.suggestion).toBeNull()
  })

  test('exact lead token keeps its highlight with args after it', () => {
    const a = analyzeSlash('/commit -m "x"', NAMES)
    expect(a.highlights).toEqual([tok('commit', 0)])
    expect(a.suggestion).toBeNull()
  })

  test('ambiguity (two names within one edit) → no suggestion', () => {
    const names = new Set(['help', 'helm'])
    const a = analyzeSlash('/hela', names)
    expect(a.suggestion).toBeNull()
  })

  test('a token after a newline is mid-prose: highlight-only', () => {
    const a = analyzeSlash('note\n/help', NAMES)
    expect(a.highlights).toEqual([tok('help', 5)])
    expect(a.suggestion).toBeNull()
  })

  test('empty catalog → nothing ever', () => {
    expect(analyzeSlash('/help', new Set())).toEqual({ highlights: [], suggestion: null })
  })
})

describe('learnableNames — catalog learning gate', () => {
  test('bare lead token: names learned, slash/space variants normalized', () => {
    expect(
      learnableNames('/', [{ text: '/clear' }, { text: 'help ' }, { text: 'model' }, { text: 'two words' }])
    ).toEqual(['clear', 'help', 'model'])
  })

  test('arg completions (text has a space) are NOT learned', () => {
    expect(learnableNames('/details ', [{ text: 'thinking' }])).toEqual([])
    expect(learnableNames('/details th', [{ text: 'thinking' }])).toEqual([])
  })

  test('mid-prose / path menus are NOT learned', () => {
    expect(learnableNames('use /', [{ text: 'clear' }])).toEqual([])
    expect(learnableNames('src/ma', [{ text: 'src/main.py' }])).toEqual([])
  })

  test('path-shaped candidates are filtered even on a slash text', () => {
    expect(learnableNames('/c', [{ text: 'src/main.py' }, { text: '' }])).toEqual([])
  })
})

describe('nativeCharOffset — newline exclusion for native highlight ranges', () => {
  test.each<[string, string, number, number]>([
    ['no newlines = identity', '/help', 3, 3],
    ['one newline before', 'ab\ncd', 3, 2],
    ['two newlines before', 'a\nb\nc', 4, 2],
    ['offset before any newline', 'ab\ncd', 1, 1],
    ['offset past end clamps newline scan', 'a\nb', 5, 4]
  ])('%s', (_name, text, offset, expected) => {
    expect(nativeCharOffset(text, offset)).toBe(expected)
  })
})
