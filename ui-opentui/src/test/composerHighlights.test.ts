import { describe, expect, test } from 'vitest'

import { composerHighlightSpans, splitComposerHighlights } from '../logic/composerHighlights.ts'

const painted = (text: string): string[] =>
  splitComposerHighlights(text)
    .filter(segment => segment.ref)
    .map(segment => segment.text)

describe('splitComposerHighlights', () => {
  test('marks a command invocation and a skill named mid-prose', () => {
    expect(painted('/work fix the leak')).toEqual(['/work'])
    expect(painted('clean this up with /clean')).toEqual(['/clean'])
    expect(painted('run /clean then /work')).toEqual(['/clean', '/work'])
  })

  test('marks @ references, including quoted values with spaces', () => {
    expect(painted('see @file:src/a.ts please')).toEqual(['@file:src/a.ts'])
    expect(painted('see @file:`my notes.md` please')).toEqual(['@file:`my notes.md`'])
    expect(painted('diff @diff and @staged')).toEqual(['@diff', '@staged'])
  })

  test('marks Ink and OpenTUI attachment/paste tokens', () => {
    expect(painted('what is in [[ Image 1 ]] here')).toEqual(['[[ Image 1 ]]'])
    expect(painted('paste [Pasted text #2 +3 lines] with [Image #1]')).toEqual([
      '[Pasted text #2 +3 lines]',
      '[Image #1]'
    ])
  })

  test('marks every kind in one message', () => {
    expect(painted('/work with @file:a.ts and [[ Image 2 ]]')).toEqual(['/work', '@file:a.ts', '[[ Image 2 ]]'])
  })

  test('leaves paths, bare prose slashes, and email addresses alone', () => {
    for (const text of [
      'look at /usr/local/bin',
      'check src/foo/bar',
      'a 3 /4 b',
      'either / or',
      'email me@example.com'
    ]) {
      expect(splitComposerHighlights(text)).toEqual([{ ref: false, text }])
    }
  })

  test('marks half-typed references so the accent tracks the caret', () => {
    expect(painted('/wor')).toEqual(['/wor'])
    expect(painted('ref @fi')).toEqual(['@fi'])
    expect(painted('/')).toEqual(['/'])
  })

  test('round-trips the input exactly and always returns a segment', () => {
    for (const text of ['/work a', 'x @file:b [[ Image 1 ]]', 'plain text', '', 'look at /usr/local/bin']) {
      expect(
        splitComposerHighlights(text)
          .map(segment => segment.text)
          .join('')
      ).toBe(text)
    }
    expect(splitComposerHighlights('')).toEqual([{ ref: false, text: '' }])
  })

  test('exposes exact native textarea ranges with token precedence', () => {
    expect(composerHighlightSpans('use /work and @diff')).toEqual([
      { end: 9, start: 4 },
      { end: 19, start: 14 }
    ])
    expect(composerHighlightSpans('see @file:`/work notes`')).toEqual([{ end: 23, start: 4 }])
  })
})
