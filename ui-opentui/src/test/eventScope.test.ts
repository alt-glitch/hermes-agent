import { describe, expect, test } from 'vitest'

import type { GatewayEvent } from '../boundary/schema/GatewayEvent.ts'
import { eventBelongsToSession, eventMayEnterStore } from '../logic/eventScope.ts'

describe('eventBelongsToSession', () => {
  test('accepts matching and global events, rejects stale or detached scoped events', () => {
    const matching = { type: 'message.start', session_id: 'live-1' } satisfies GatewayEvent
    const stale = { type: 'message.start', session_id: 'old-1' } satisfies GatewayEvent
    const global = { type: 'skin.changed', payload: {} } satisfies GatewayEvent

    expect(eventBelongsToSession(matching, 'live-1')).toBe(true)
    expect(eventBelongsToSession(stale, 'live-1')).toBe(false)
    expect(eventBelongsToSession(matching, undefined)).toBe(false)
    expect(eventBelongsToSession(global, undefined)).toBe(true)
  })

  test('gateway lifecycle events pass even with a mismatched SID', () => {
    const ready = { type: 'gateway.ready', session_id: 'old-1' } satisfies GatewayEvent
    expect(eventBelongsToSession(ready, 'live-1')).toBe(true)
  })

  test('empty session ids are treated as unscoped for backwards compatibility', () => {
    const skin = { type: 'skin.changed', session_id: '', payload: {} } satisfies GatewayEvent
    expect(eventBelongsToSession(skin, undefined)).toBe(true)
  })

  test('stale blocking prompts are fenced before they can replace the composer', () => {
    const approval = {
      type: 'approval.request',
      session_id: 'old-1',
      payload: { command: 'rm -rf /tmp/x', description: 'remove temp data' }
    } satisfies GatewayEvent
    expect(eventBelongsToSession(approval, 'live-1')).toBe(false)
  })

  test('a stale session.title cannot retitle successor chrome (entry-gate scoping)', () => {
    // The gateway scopes the live title push by its TOP-LEVEL session_id (the
    // payload's session_id is the DB key) — the same gate every scoped event
    // rides, so a title emitted for a torn-down session never lands.
    const stale = {
      type: 'session.title',
      session_id: 'old-1',
      payload: { session_id: 'db-key-9', title: 'stale title' }
    } satisfies GatewayEvent
    const live = {
      type: 'session.title',
      session_id: 'live-1',
      payload: { title: 'fresh title' }
    } satisfies GatewayEvent
    expect(eventBelongsToSession(stale, 'live-1')).toBe(false)
    expect(eventBelongsToSession(live, 'live-1')).toBe(true)
  })

  test('resume buffering admits target events before transport identity changes', () => {
    const target = { type: 'message.start', session_id: 'target-live' } satisfies GatewayEvent
    expect(eventMayEnterStore(target, 'old-live', false)).toBe(false)
    expect(eventMayEnterStore(target, 'old-live', true)).toBe(true)
  })
})
