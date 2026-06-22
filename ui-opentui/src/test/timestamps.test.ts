/**
 * /timestamps tests (port of upstream 5ff11a689, reproduced natively in the
 * OpenTUI/Solid engine). Three contracts:
 *   1. formatTimestamp zero-pads to a local 24h `[HH:MM]` (TZ-robust — we
 *      compute the expectation the same local-time way, so the UTC gate passes).
 *   2. the store `timestamps` flag round-trips through setTimestamps and starts OFF.
 *   3. mapResumeHistory carries a stored unix `timestamp` onto the Message and
 *      OMITS it (never fabricates) when the resumed entry lacks one.
 */
import { describe, expect, test } from 'vitest'

import { mapResumeHistory } from '../logic/resume.ts'
import { createSessionStore } from '../logic/store.ts'
import { formatTimestamp } from '../view/messageLine.tsx'

describe('formatTimestamp', () => {
  test('zero-pads hours and minutes to a local 24h [HH:MM]', () => {
    // A fixed unix-seconds value. We assert against the SAME local-time
    // computation so the test is timezone-independent (the gate runs TZ=UTC,
    // a dev box may not) — the contract under test is the zero-padding + shape,
    // not the absolute wall-clock the runner happens to be in.
    const unix = 1_700_000_000 // arbitrary fixed instant
    const d = new Date(unix * 1000)
    const expected = `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}]`
    expect(formatTimestamp(unix)).toBe(expected)
  })

  test('pads a single-digit hour and minute (e.g. local 09:05)', () => {
    // Build an instant that is 09:05 in LOCAL time, then round-trip it so the
    // assertion holds in any timezone.
    const local = new Date(2024, 0, 1, 9, 5, 0) // year, monthIdx, day, 09:05 local
    const unix = Math.floor(local.getTime() / 1000)
    expect(formatTimestamp(unix)).toBe('[09:05]')
  })

  test('formats a local-midnight instant as [00:00]', () => {
    const local = new Date(2024, 5, 15, 0, 0, 0)
    const unix = Math.floor(local.getTime() / 1000)
    expect(formatTimestamp(unix)).toBe('[00:00]')
  })
})

describe('store timestamps flag', () => {
  test('starts OFF and round-trips through setTimestamps', () => {
    const store = createSessionStore()
    expect(store.state.timestamps).toBe(false)
    store.setTimestamps(true)
    expect(store.state.timestamps).toBe(true)
    store.setTimestamps(false)
    expect(store.state.timestamps).toBe(false)
  })
})

describe('mapResumeHistory timestamp carry-through', () => {
  test('carries a stored unix timestamp onto user + assistant messages', () => {
    const msgs = mapResumeHistory([
      { role: 'user', text: 'hi', timestamp: 1_700_000_000 },
      { role: 'assistant', text: 'hello', timestamp: 1_700_000_005 }
    ])
    expect(msgs[0]).toMatchObject({ role: 'user', timestamp: 1_700_000_000 })
    expect(msgs[1]).toMatchObject({ role: 'assistant', timestamp: 1_700_000_005 })
  })

  test('omits timestamp entirely when the resumed entry lacks one (never fabricated)', () => {
    const msgs = mapResumeHistory([
      { role: 'user', text: 'no time here' },
      { role: 'assistant', text: 'also none' }
    ])
    expect(msgs[0]!.timestamp).toBeUndefined()
    expect(msgs[1]!.timestamp).toBeUndefined()
  })

  test('ignores a non-finite / non-numeric timestamp (treated as absent)', () => {
    const msgs = mapResumeHistory([
      { role: 'user', text: 'bad', timestamp: 'nope' },
      { role: 'system', text: 'also bad', timestamp: Number.NaN }
    ])
    expect(msgs[0]!.timestamp).toBeUndefined()
    expect(msgs[1]!.timestamp).toBeUndefined()
  })
})
