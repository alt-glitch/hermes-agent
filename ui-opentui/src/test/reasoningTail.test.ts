/**
 * reasoningSummary tail bound — the OpenTUI port of Ink's
 * THINKING_CLEAN_TAIL_BOUND (upstream 64882bc6 + its fc8e3936 regression test):
 * a long accumulated reasoning stream must feed the render pipeline a BOUNDED
 * newest-tail window (constant per-delta work), never the whole string, while
 * the leading `**Title**` — which lives at the head, outside any tail slice —
 * still surfaces in the header.
 */
import { describe, expect, test } from 'vitest'

import { REASONING_TAIL_BOUND, reasoningSummary } from '../logic/reasoningTail.ts'

describe('reasoningSummary — short/title path (unchanged contract)', () => {
  test('splits a leading **Title** from the body', () => {
    expect(reasoningSummary('**Plan**\n\nthink about the steps')).toEqual({
      body: 'think about the steps',
      title: 'Plan'
    })
  })

  test('title-only reasoning yields an empty body', () => {
    expect(reasoningSummary('**Plan**')).toEqual({ body: '', title: 'Plan' })
  })

  test('no title → whole trimmed text is the body', () => {
    expect(reasoningSummary('  just thinking  ')).toEqual({ body: 'just thinking' })
  })

  test('[REDACTED] marker is stripped', () => {
    expect(reasoningSummary('[REDACTED]signal').body).toBe('signal')
  })

  test('empty input renders nothing', () => {
    expect(reasoningSummary('')).toEqual({ body: '' })
  })
})

describe('reasoningSummary — >24k tail bound (the O(n^2) guard)', () => {
  test('a >24k stream keeps the newest tail marker inside a bounded body, and the head title survives', () => {
    const marker = 'UNIQUE-TAIL-MARKER-7f3a'
    const long = '**Deep Plan**\n\n' + 'reasoning line about the problem space\n'.repeat(1200) + marker
    expect(long.length).toBeGreaterThan(REASONING_TAIL_BOUND)

    const s = reasoningSummary(long)
    expect(s.title).toBe('Deep Plan')
    expect(s.body.length).toBeLessThanOrEqual(REASONING_TAIL_BOUND)
    expect(s.body).toContain(marker)
    expect(s.body).not.toContain('Deep Plan')
  })

  test('at the bound the body is still the full text (no truncation)', () => {
    const text = 'a'.repeat(REASONING_TAIL_BOUND)
    expect(reasoningSummary(text).body).toBe(text)
  })

  test('body never grows past the bound as a stream accumulates', () => {
    let acc = '**Working**\n\n'
    for (let i = 0; i < 200; i++) {
      acc += `token ${i} of the stream with some padding text so it grows\n`.repeat(4)
      const s = reasoningSummary(acc)
      expect(s.body.length).toBeLessThanOrEqual(REASONING_TAIL_BOUND)
      if (acc.length > REASONING_TAIL_BOUND) expect(s.title).toBe('Working')
    }
  })

  test('a **bold** run cut at the head-scan boundary is not mistaken for a title', () => {
    const long = '**' + 'a'.repeat(1020) + '**' + 'b'.repeat(30_000)
    expect(reasoningSummary(long).title).toBeUndefined()
  })
})
