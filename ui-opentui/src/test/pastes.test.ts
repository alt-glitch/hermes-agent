/**
 * Pasted-text store test — add returns a placeholder, expand restores the real
 * content, multiple pastes round-trip, unknown refs pass through, single-pass
 * replace keeps a self-referential paste safe. (input polish.)
 */
import { describe, expect, test } from 'vitest'

import { createPasteStore, type PasteStore, shouldPlaceholder } from '../logic/pastes.ts'

function add(store: PasteStore, text: string): string {
  const token = store.add(text)
  if (token === undefined) throw new Error('paste fixture unexpectedly exceeded its store ceiling')
  return token
}

describe('createPasteStore', () => {
  test('add returns a numbered placeholder with the line count', () => {
    const s = createPasteStore()
    expect(add(s, 'a\nb\nc')).toBe('[Pasted text #1 +3 lines]')
    expect(add(s, 'single line')).toBe('[Pasted text #2]') // 1 line → no "+N lines"
  })

  test('expand restores the real content for each ref', () => {
    const s = createPasteStore()
    const p1 = add(s, 'FIRST\nblock')
    const p2 = add(s, 'SECOND')
    const input = `before ${p1} middle ${p2} after`
    expect(s.expand(input)).toBe('before FIRST\nblock middle SECOND after')
  })

  test('unknown ref is left as-is (e.g. user typed it, or it was cleared)', () => {
    const s = createPasteStore()
    expect(s.expand('look [Pasted text #99] here')).toBe('look [Pasted text #99] here')
  })

  test('single-pass replace: a pasted block containing a ref literal is NOT re-expanded', () => {
    const s = createPasteStore()
    const p1 = add(s, 'code with [Pasted text #2] inside')
    add(s, 'SHOULD-NOT-APPEAR')
    // expanding the input replaces #1 with its content; the #2 inside that content
    // is not re-scanned, so SHOULD-NOT-APPEAR never leaks in.
    expect(s.expand(`x ${p1}`)).toBe('x code with [Pasted text #2] inside')
  })

  test('bounded expansion preflights duplicate references without allocating the oversized result', () => {
    const s = createPasteStore()
    const token = add(s, 'abcdefghij')
    expect(s.expand(`${token}${token}`, 20)).toBe('abcdefghijabcdefghij')
    expect(s.expand(`${token}${token}${token}`, 20)).toBeUndefined()
    expect(s.stats()).toMatchObject({ bytes: 20, count: 1 })
  })

  test('clear drops stored pastes without reusing ids', () => {
    const s = createPasteStore()
    const p = add(s, 'gone')
    s.clear()
    expect(s.expand(p)).toBe(p) // no longer expandable
    expect(add(s, 'fresh')).toBe('[Pasted text #2]')
    expect(s.stats()).toEqual({ bytes: 10, count: 1, maxBytes: 8 * 1024 * 1024, maxCount: 100 })
  })

  test('hard aggregate ceiling rejects without evicting or corrupting live refs', () => {
    const s = createPasteStore({ maxRetainedBytes: 16 })
    const live = add(s, '12345678')
    expect(s.stats()).toEqual({ bytes: 16, count: 1, maxBytes: 16, maxCount: 100 })
    expect(s.add('x')).toBeUndefined()
    expect(s.stats()).toEqual({ bytes: 16, count: 1, maxBytes: 16, maxCount: 100 })
    expect(s.expand(live)).toBe('12345678')
  })

  test('discard releases abandoned refs while retainOnly preserves a restored draft', () => {
    const s = createPasteStore()
    const keep = add(s, 'keep me')
    const abandon = add(s, 'drop me')
    s.discard(`editing ${abandon}`)
    expect(s.stats().count).toBe(1)
    expect(s.expand(keep)).toBe('keep me')
    expect(s.expand(abandon)).toBe(abandon)

    // A session reset may clear the native textarea and restore the SAME draft
    // token synchronously. Reconciliation against that restored draft keeps it.
    s.retainOnly(`restored ${keep}`)
    expect(s.stats().count).toBe(1)
    expect(s.expand(keep)).toBe('keep me')

    s.retainOnly('programmatic replacement')
    expect(s.stats()).toEqual({ bytes: 0, count: 0, maxBytes: 8 * 1024 * 1024, maxCount: 100 })
  })

  test('replace is atomic: an oversized replacement leaves the old draft live', () => {
    const s = createPasteStore({ maxRetainedBytes: 20 })
    const old = add(s, '12345')
    expect(s.replace('x'.repeat(11))).toBeUndefined()
    expect(s.expand(old)).toBe('12345')
    expect(s.stats().bytes).toBe(10)

    const next = s.replace('next')
    expect(next).toBeDefined()
    expect(s.expand(old)).toBe(old)
    expect(s.expand(next ?? '')).toBe('next')
    expect(s.stats()).toEqual({ bytes: 8, count: 1, maxBytes: 20, maxCount: 100 })
  })

  test('repeated multi-megabyte paste then discard returns retained storage to zero', () => {
    const s = createPasteStore()
    const body = 'α'.repeat(2 * 1024 * 1024)
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const token = add(s, body)
      expect(s.stats()).toEqual({
        bytes: 4 * 1024 * 1024,
        count: 1,
        maxBytes: 8 * 1024 * 1024,
        maxCount: 100
      })
      s.discard(token)
      expect(s.stats()).toEqual({ bytes: 0, count: 0, maxBytes: 8 * 1024 * 1024, maxCount: 100 })
    }
  })

  test('item count is bounded even when bodies retain zero bytes', () => {
    const s = createPasteStore({ maxRetainedItems: 2 })
    expect(s.add('')).toBeDefined()
    expect(s.add('')).toBeDefined()
    expect(s.add('')).toBeUndefined()
    expect(s.stats()).toEqual({ bytes: 0, count: 2, maxBytes: 8 * 1024 * 1024, maxCount: 2 })
  })

  test('newline-heavy multi-megabyte labels use the allocation-free line scan', () => {
    const s = createPasteStore()
    const body = 'x\n'.repeat(512 * 1024)
    const token = add(s, body)
    expect(token).toBe('[Pasted text #1 +524289 lines]')
    expect(s.stats()).toMatchObject({ bytes: 2 * 1024 * 1024, count: 1 })
    s.discard(token)
    expect(s.stats()).toMatchObject({ bytes: 0, count: 0 })
  })

  test('shouldPlaceholder: ≥4 lines OR >400 chars', () => {
    expect(shouldPlaceholder('a\nb\nc\nd')).toBe(true) // 4 lines
    expect(shouldPlaceholder('a\nb\nc')).toBe(false) // 3 lines
    expect(shouldPlaceholder('x'.repeat(401))).toBe(true) // long
    expect(shouldPlaceholder('short')).toBe(false)
  })
})
