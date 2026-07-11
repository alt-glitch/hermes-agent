import { describe, expect, test } from 'vitest'

import {
  busyInputModeFromConfig,
  BUSY_QUEUE_MAX_CHARS,
  BUSY_QUEUE_MAX_EDIT_CHARS,
  BUSY_QUEUE_MAX_ITEMS,
  normalizeBusyInputMode,
  queueAccepts,
  queuePreview,
  queueWindow
} from '../logic/busyQueue.ts'

describe('busy input mode', () => {
  test('normalizes the three modes and defaults malformed values to queue', () => {
    expect(normalizeBusyInputMode(' INTERRUPT ')).toBe('interrupt')
    expect(normalizeBusyInputMode('queue')).toBe('queue')
    expect(normalizeBusyInputMode('steer')).toBe('steer')
    expect(normalizeBusyInputMode('drop')).toBe('queue')
    expect(normalizeBusyInputMode(undefined)).toBe('queue')
  })

  test('reads full config without inheriting the classic CLI interrupt default', () => {
    expect(busyInputModeFromConfig({ display: { busy_input_mode: 'steer' } })).toBe('steer')
    expect(busyInputModeFromConfig({ display: {} })).toBe('queue')
    expect(busyInputModeFromConfig({})).toBe('queue')
  })
})

describe('bounded queue helpers', () => {
  test('keeps the active edit row inside the three-row window', () => {
    expect(queueWindow(8, undefined)).toEqual({ end: 3, showLead: false, showTail: true, start: 0 })
    expect(queueWindow(8, 4)).toEqual({ end: 6, showLead: true, showTail: true, start: 3 })
    expect(queueWindow(8, 7)).toEqual({ end: 8, showLead: true, showTail: false, start: 5 })
  })

  test('preview is single-line, bounded, and does not need the whole source', () => {
    expect(queuePreview('one\n\n two\tthree', 40)).toBe('one two three')
    expect(queuePreview('x'.repeat(10_000), 20)).toBe(`${'x'.repeat(19)}…`)
  })

  test('rejects count/character overflow but permits an in-budget replacement', () => {
    expect(
      queueAccepts(
        Array.from({ length: BUSY_QUEUE_MAX_ITEMS }, () => 'x'),
        'next'
      )
    ).toBe(false)
    expect(queueAccepts(['x'.repeat(BUSY_QUEUE_MAX_CHARS)], 'y')).toBe(false)
    expect(queueAccepts(['x'.repeat(BUSY_QUEUE_MAX_CHARS)], 'short', 0)).toBe(true)
  })

  test('pending reservations protect fallback capacity across enqueue and replacement', () => {
    const reserved = 'r'.repeat(128)
    const existing = ['x'.repeat(BUSY_QUEUE_MAX_CHARS - reserved.length)]
    expect(queueAccepts(existing, 'new', undefined, 1, reserved.length)).toBe(false)
    expect(queueAccepts(['small'], 'x'.repeat(BUSY_QUEUE_MAX_CHARS), 0, 1, reserved.length)).toBe(false)
    expect(queueAccepts(['small'], 'replacement', 0, 1, reserved.length)).toBe(true)
  })

  test('native queue editing has a measured 16Ki code-unit ceiling', () => {
    expect(BUSY_QUEUE_MAX_EDIT_CHARS).toBe(16 * 1024)
  })
})
