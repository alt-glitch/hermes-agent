/**
 * Client-side BUSY QUEUE — the transport-free store layer (layer A of the
 * busy-queue fix). Submitting a prompt while a turn is running ENQUEUES it
 * (instead of being dropped with a swallowed 4009); the entry drains one prompt
 * per turn-completion via the registered onTurnComplete handler.
 *
 * These are PURE store-logic tests (no renderer): the FIFO queue ops + the
 * turn-complete drain hook. The submitPrompt busy-GUARD itself lives in the
 * ENTRY (entry/main.tsx), not the store, so it's covered by live validation —
 * here we only exercise the queue + the completion hook the store owns.
 *
 * (.test.ts files have the strict ui-opentui/src lint rules off, so plain event
 * object literals can be passed to store.apply without a GatewayEvent cast.)
 */
import { describe, expect, test, vi } from 'vitest'

import { createSessionStore } from '../logic/store.ts'

describe('busy queue — FIFO enqueue/dequeue', () => {
  test('dequeue returns enqueued prompts in FIFO order, then undefined', () => {
    const store = createSessionStore()
    expect(store.queuedCount()).toBe(0)

    store.enqueuePrompt('a')
    store.enqueuePrompt('b')
    store.enqueuePrompt('c')
    expect(store.queuedCount()).toBe(3)
    expect(store.state.queuedPrompts).toEqual(['a', 'b', 'c'])

    expect(store.dequeuePrompt()).toBe('a')
    expect(store.dequeuePrompt()).toBe('b')
    expect(store.dequeuePrompt()).toBe('c')
    expect(store.dequeuePrompt()).toBeUndefined()
    expect(store.queuedCount()).toBe(0)
  })

  test('dequeue on an empty queue is undefined and leaves count at 0', () => {
    const store = createSessionStore()
    expect(store.dequeuePrompt()).toBeUndefined()
    expect(store.queuedCount()).toBe(0)
  })

  test('queuedCount reflects size as items are added and removed', () => {
    const store = createSessionStore()
    store.enqueuePrompt('one')
    expect(store.queuedCount()).toBe(1)
    store.enqueuePrompt('two')
    expect(store.queuedCount()).toBe(2)
    store.dequeuePrompt()
    expect(store.queuedCount()).toBe(1)
  })
})

describe('busy queue — clearQueue', () => {
  test('clearQueue empties the queue', () => {
    const store = createSessionStore()
    store.enqueuePrompt('x')
    store.enqueuePrompt('y')
    expect(store.queuedCount()).toBe(2)

    store.clearQueue()
    expect(store.queuedCount()).toBe(0)
    expect(store.state.queuedPrompts).toEqual([])
    expect(store.dequeuePrompt()).toBeUndefined()
  })

  test('/clear (clearTranscript) drops queued prompts — no cross-session bleed', () => {
    const store = createSessionStore()
    store.enqueuePrompt('stale')
    expect(store.queuedCount()).toBe(1)

    store.clearTranscript()
    expect(store.queuedCount()).toBe(0)
  })
})

describe('busy queue — turn-complete drain hook', () => {
  test('drain fires on the server session.info running true→false edge, not on message.complete', () => {
    const store = createSessionStore()
    const onComplete = vi.fn()
    store.registerTurnCompleteHandler(onComplete)

    // A turn opens: message.start arms the drain edge + flips running true.
    store.apply({ type: 'message.start' })
    expect(store.state.info.running).toBe(true)
    expect(onComplete).not.toHaveBeenCalled()

    // message.complete flips running false LOCALLY (optimistic spinner-stop UI)
    // but MUST NOT drain — the server hasn't cleared its running flag yet, so a
    // re-submit here would 4009-bounce. The handler stays unfired.
    store.apply({ type: 'message.complete' })
    expect(store.state.info.running).toBe(false)
    expect(onComplete).not.toHaveBeenCalled()

    // The server then confirms idle via session.info(running:false) — THIS is the
    // true→false edge the drain keys off (turnInFlight was armed by message.start).
    // It fires exactly once.
    store.apply({ type: 'session.info', payload: { running: false } })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  test('drain fires on a session.info running true→false edge even without message.complete', () => {
    // Belt-and-suspenders: the drain is gated on turnInFlight (armed by
    // message.start) + the session.info running:false edge — independent of
    // whether a message.complete arrived first.
    const store = createSessionStore()
    const onComplete = vi.fn()
    store.registerTurnCompleteHandler(onComplete)

    store.apply({ type: 'session.info', payload: { running: true } })
    store.apply({ type: 'message.start' })
    expect(onComplete).not.toHaveBeenCalled()

    store.apply({ type: 'session.info', payload: { running: false } })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  test('drain does NOT fire when running was never armed (no in-flight turn)', () => {
    // An idle session.info(running:false) with no preceding turn must be inert:
    // turnInFlight is false, so no edge → no drain (and no spurious re-submit).
    const store = createSessionStore()
    const onComplete = vi.fn()
    store.registerTurnCompleteHandler(onComplete)

    store.apply({ type: 'session.info', payload: { running: false } })
    expect(onComplete).not.toHaveBeenCalled()
  })

  test('drain does NOT fire on a session.info that does not flip running false', () => {
    // A mid-turn info refresh (usage/context only, or running:true) must not drain.
    const store = createSessionStore()
    const onComplete = vi.fn()
    store.registerTurnCompleteHandler(onComplete)

    store.apply({ type: 'message.start' })
    // info patch with no running field — pure usage refresh.
    store.apply({ type: 'session.info', payload: { usage: { context_used: 100 } } })
    expect(onComplete).not.toHaveBeenCalled()
    // info patch that re-asserts running:true — still no true→false edge.
    store.apply({ type: 'session.info', payload: { running: true } })
    expect(onComplete).not.toHaveBeenCalled()
  })

  test('drain fires exactly ONCE per turn (a second session.info running:false is inert)', () => {
    // turnInFlight is disarmed the moment the drain fires, so a redundant
    // server session.info(running:false) (e.g. a later usage refresh) cannot
    // double-drain the same completion.
    const store = createSessionStore()
    const onComplete = vi.fn()
    store.registerTurnCompleteHandler(onComplete)

    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.complete' })
    store.apply({ type: 'session.info', payload: { running: false } })
    expect(onComplete).toHaveBeenCalledTimes(1)

    // A trailing idle session.info(running:false) — no turn in flight → no drain.
    store.apply({ type: 'session.info', payload: { running: false } })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  test('the handler can drain ONE queued prompt per completion (entry pattern)', () => {
    const store = createSessionStore()
    const drained: string[] = []
    // Mirror the entry's registered drain: pop ONE per completion.
    store.registerTurnCompleteHandler(() => {
      const next = store.dequeuePrompt()
      if (next !== undefined) drained.push(next)
    })

    store.enqueuePrompt('first')
    store.enqueuePrompt('second')

    // Turn 1 completes (server-confirmed) → drains exactly one (the head).
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.complete' })
    store.apply({ type: 'session.info', payload: { running: false } })
    expect(drained).toEqual(['first'])
    expect(store.queuedCount()).toBe(1)

    // Turn 2 completes → drains the next; queue now empty.
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.complete' })
    store.apply({ type: 'session.info', payload: { running: false } })
    expect(drained).toEqual(['first', 'second'])
    expect(store.queuedCount()).toBe(0)

    // A completion with an empty queue is a harmless no-op.
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.complete' })
    store.apply({ type: 'session.info', payload: { running: false } })
    expect(drained).toEqual(['first', 'second'])
  })

  test('no registered handler → a server-confirmed completion is a safe no-op', () => {
    const store = createSessionStore()
    store.enqueuePrompt('orphan')
    // No handler registered; completion must not throw and must not drain.
    expect(() => {
      store.apply({ type: 'message.start' })
      store.apply({ type: 'message.complete' })
      store.apply({ type: 'session.info', payload: { running: false } })
    }).not.toThrow()
    expect(store.queuedCount()).toBe(1)
  })
})
