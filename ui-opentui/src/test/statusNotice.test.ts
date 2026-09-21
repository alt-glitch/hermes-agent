/**
 * Chrome-notice lifecycle (P2) — the persistent status-bar banner state machine,
 * distinct from the inline notification cards. Ports the ui-tui turnController
 * showNotice/applyNotice/clearNotice/flushPendingNotice semantics:
 *   1. routing: sticky/ttl `notification.show` → `state.notice` (NOT a card).
 *   2. routing (card path intact): label-kind notice → an inline card, notice null.
 *   3. mid-turn hold + flush: a notice during a turn is held, applied on complete.
 *   4. clearNotice by key (and a non-matching key is a no-op).
 *   5. TTL auto-expiry (fake timers).
 *   6. flash-and-yield: credits.usage yields to a starting turn; sticky persists.
 *   7. clearTranscript resets notice + pending.
 *   8. error-path flush: a turn ending via error (no message.complete) flushes held.
 *   8b. gateway.exited flush: a turn ending via the child exiting mid-reply flushes held.
 *   9. resume reset: commitSnapshot clears notice + pending + armed timer.
 *  10. flash-and-yield: credits.grant_spent yields to a starting turn.
 *  11. success-level notice keeps its level.
 */
import { describe, expect, test, vi } from 'vitest'

import { createSessionStore } from '../logic/store.ts'

describe('chrome notice lifecycle', () => {
  test('routing: a sticky notice sets state.notice and pushes NO card', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({
      type: 'notification.show',
      payload: { kind: 'sticky', text: '⚠ Credits 90% used', level: 'warn', key: 'credits.usage', id: 'credits.usage' }
    })
    expect(store.state.notice?.id).toBe('credits.usage')
    expect(store.state.notice?.text).toBe('⚠ Credits 90% used')
    expect(store.state.messages.some(m => m.role === 'notification')).toBe(false)
  })

  test('routing (card path intact): a label-kind notice pushes a card, notice stays null', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({
      type: 'notification.show',
      payload: { kind: 'process.complete', text: 'build exited 0', key: 'proc:1' }
    })
    expect(store.state.notice).toBeNull()
    const last = store.state.messages.at(-1)
    expect(last?.role).toBe('notification')
    expect(last?.notification?.text).toBe('build exited 0')
  })

  test('mid-turn hold + flush: notice is held during a turn, applied on complete', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({
      type: 'notification.show',
      payload: { kind: 'sticky', text: 'held notice', level: 'info', key: 'credits.usage', id: 'h1' }
    })
    expect(store.state.notice).toBeNull()
    expect(store.state.pendingNotice?.id).toBe('h1')
    store.apply({ type: 'message.complete' })
    expect(store.state.notice?.id).toBe('h1')
    expect(store.state.pendingNotice).toBeNull()
  })

  test('clearNotice by key clears the visible notice; a non-matching key is a no-op', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({
      type: 'notification.show',
      payload: {
        kind: 'sticky',
        text: 'no credits left',
        level: 'error',
        key: 'credits.depleted',
        id: 'credits.depleted'
      }
    })
    expect(store.state.notice?.key).toBe('credits.depleted')
    store.apply({ type: 'notification.clear', payload: { key: 'nope' } })
    expect(store.state.notice?.key).toBe('credits.depleted') // no-op
    store.apply({ type: 'notification.clear', payload: { key: 'credits.depleted' } })
    expect(store.state.notice).toBeNull()
  })

  test('TTL auto-expiry: a ttl notice uses an unreferenced timer and clears itself after ttlMs', () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const store = createSessionStore()
      store.apply({ type: 'gateway.ready' })
      store.apply({
        type: 'notification.show',
        payload: { kind: 'ttl', ttl_ms: 50, text: 'transient', level: 'info', key: 'credits.usage', id: 't1' }
      })
      const ttlHandle = setTimeoutSpy.mock.results.at(-1)?.value as ReturnType<typeof setTimeout>
      expect(ttlHandle.hasRef()).toBe(false)
      expect(store.state.notice?.id).toBe('t1')
      vi.advanceTimersByTime(50)
      expect(store.state.notice).toBeNull()
    } finally {
      setTimeoutSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  test('TTL replacement is latest-wins and clear cancels the replacement timer', () => {
    vi.useFakeTimers()
    try {
      const store = createSessionStore()
      store.apply({ type: 'gateway.ready' })
      store.apply({
        type: 'notification.show',
        payload: { kind: 'ttl', ttl_ms: 50, text: 'first', level: 'info', key: 'first', id: 't1' }
      })
      vi.advanceTimersByTime(25)
      store.apply({
        type: 'notification.show',
        payload: { kind: 'ttl', ttl_ms: 100, text: 'second', level: 'info', key: 'second', id: 't2' }
      })
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(25)
      expect(store.state.notice?.id).toBe('t2')
      store.apply({ type: 'notification.clear', payload: { key: 'second' } })
      expect(store.state.notice).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test('flash-and-yield: credits.usage yields to a starting turn; sticky persists', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    // credits.usage: cleared the moment a turn opens.
    store.apply({
      type: 'notification.show',
      payload: { kind: 'sticky', text: '90% used', level: 'warn', key: 'credits.usage', id: 'u1' }
    })
    expect(store.state.notice?.id).toBe('u1')
    store.apply({ type: 'message.start' })
    expect(store.state.notice).toBeNull()
    store.apply({ type: 'message.complete' })

    // credits.depleted (sticky, non-yielding): survives a start→complete cycle.
    store.apply({
      type: 'notification.show',
      payload: { kind: 'sticky', text: 'depleted', level: 'error', key: 'credits.depleted', id: 'd1' }
    })
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.complete' })
    expect(store.state.notice?.id).toBe('d1')
  })

  test('clearTranscript resets both the visible notice and a pending one', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    // visible notice
    store.apply({
      type: 'notification.show',
      payload: { kind: 'sticky', text: 'visible', level: 'info', key: 'credits.depleted', id: 'v1' }
    })
    // pending notice (held mid-turn)
    store.apply({ type: 'message.start' })
    store.apply({
      type: 'notification.show',
      payload: { kind: 'sticky', text: 'held', level: 'info', key: 'credits.usage', id: 'p1' }
    })
    expect(store.state.notice?.id).toBe('v1')
    expect(store.state.pendingNotice?.id).toBe('p1')
    store.clearTranscript()
    expect(store.state.notice).toBeNull()
    expect(store.state.pendingNotice).toBeNull()
  })

  test('error-path flush: a notice held mid-turn is applied when the turn ends via error', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({
      type: 'notification.show',
      payload: { kind: 'sticky', text: 'held notice', level: 'info', key: 'credits.usage', id: 'e1' }
    })
    // held mid-turn — not yet visible
    expect(store.state.notice).toBeNull()
    expect(store.state.pendingNotice?.id).toBe('e1')
    // turn ends via error (no message.complete) — held notice must flush now
    store.apply({ type: 'error', payload: { message: 'boom' } })
    expect(store.state.notice?.id).toBe('e1')
    expect(store.state.pendingNotice).toBeNull()
  })

  test('gateway.exited flush: a notice held mid-turn is applied when the child exits mid-reply', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({
      type: 'notification.show',
      payload: { kind: 'sticky', text: 'held notice', level: 'info', key: 'credits.usage', id: 'x1' }
    })
    // held mid-turn — not yet visible
    expect(store.state.notice).toBeNull()
    expect(store.state.pendingNotice?.id).toBe('x1')
    // turn ends via the child exiting mid-reply (no message.complete) — held notice must flush now
    store.apply({ type: 'gateway.exited', payload: { reason: 'boom' } })
    expect(store.state.notice?.id).toBe('x1')
    expect(store.state.pendingNotice).toBeNull()
  })

  test('resume reset: commitSnapshot clears the visible notice, a pending one, and any armed timer', () => {
    vi.useFakeTimers()
    try {
      const store = createSessionStore()
      store.apply({ type: 'gateway.ready' })
      // visible ttl notice (idle) → armed TTL timer + state.notice set
      store.apply({
        type: 'notification.show',
        payload: { kind: 'ttl', ttl_ms: 50, text: 'visible', level: 'info', key: 'credits.usage', id: 'rv1' }
      })
      expect(store.state.notice?.id).toBe('rv1')
      // also hold a pending one mid-turn
      store.apply({ type: 'message.start' })
      store.apply({
        type: 'notification.show',
        payload: { kind: 'sticky', text: 'held', level: 'info', key: 'credits.depleted', id: 'rp1' }
      })
      expect(store.state.pendingNotice?.id).toBe('rp1')
      // resume replaces session context — notice + pending + timer must reset
      store.commitSnapshot([])
      expect(store.state.notice).toBeNull()
      expect(store.state.pendingNotice).toBeNull()
      // the surviving timer must not fire and null a different session's notice
      vi.advanceTimersByTime(100)
      expect(store.state.notice).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('flash-and-yield: credits.grant_spent yields to a starting turn', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({
      type: 'notification.show',
      payload: { kind: 'sticky', text: 'grant spent', level: 'warn', key: 'credits.grant_spent', id: 'gs1' }
    })
    expect(store.state.notice?.id).toBe('gs1')
    store.apply({ type: 'message.start' })
    expect(store.state.notice).toBeNull()
  })

  test('success level: a success-level sticky notice keeps level === "success"', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({
      type: 'notification.show',
      payload: { kind: 'sticky', text: 'grant applied', level: 'success', key: 'credits.grant', id: 'g1' }
    })
    expect(store.state.notice?.level).toBe('success')
  })
})
