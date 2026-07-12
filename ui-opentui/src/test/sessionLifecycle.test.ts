import { assert, describe, it } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'

import { GatewayError } from '../boundary/errors.ts'
import type { GatewayServiceShape } from '../boundary/gateway/GatewayService.ts'
import { replaceSession, resumeSession, SessionProtocolError } from '../boundary/sessionLifecycle.ts'
import { createSessionStore } from '../logic/store.ts'

interface FakeGateway {
  readonly service: GatewayServiceShape
  readonly calls: Array<{ method: string; params: unknown }>
}

function fakeGateway(
  handler: (method: string, params: unknown) => Effect.Effect<unknown, GatewayError>,
  sessionId = 'old-live'
): FakeGateway {
  const calls: FakeGateway['calls'] = []
  return {
    calls,
    service: {
      request: <A>(method: string, params: unknown) => {
        calls.push({ method, params })
        return handler(method, params) as Effect.Effect<A, GatewayError>
      },
      sessionId: () => sessionId,
      logTail: () => [],
      subscribe: () => Effect.succeed(() => {})
    }
  }
}

const rpcFailure = (method: string) => new GatewayError({ message: `${method} failed`, method, reason: 'rpc-error' })

describe('replaceSession', () => {
  it.effect('runs setup → close → detach → create with the explicit launch cwd', () => {
    const order: string[] = []
    const fake = fakeGateway((method, _params) => {
      order.push(method)
      if (method === 'setup.status') return Effect.succeed({ provider_configured: true })
      if (method === 'session.close') return Effect.succeed({ closed: false })
      if (method === 'session.create') {
        return Effect.succeed({
          info: { model: 'new-model' },
          session_id: 'new-live',
          stored_session_id: 'persisted-new'
        })
      }
      return Effect.succeed(undefined)
    })

    return Effect.gen(function* () {
      const result = yield* replaceSession(fake.service, {
        activeSessionId: 'old-live',
        cols: 123,
        cwd: '/work/project',
        onClosed: () => order.push('detached')
      })
      assert.deepStrictEqual(order, ['setup.status', 'session.close', 'detached', 'session.create'])
      assert.deepStrictEqual(result, {
        kind: 'created',
        sessionId: 'new-live',
        resumeId: 'persisted-new',
        info: { model: 'new-model' }
      })
      assert.deepStrictEqual(fake.calls.at(-1), {
        method: 'session.create',
        params: { cols: 123, cwd: '/work/project' }
      })
    })
  })

  it.effect('provider_configured:false preserves the old session and skips destructive RPCs', () => {
    let detached = false
    const fake = fakeGateway(method =>
      method === 'setup.status' ? Effect.succeed({ provider_configured: false }) : Effect.die('unexpected RPC')
    )
    return Effect.gen(function* () {
      const result = yield* replaceSession(fake.service, {
        activeSessionId: 'old-live',
        cols: 80,
        cwd: '/work',
        onClosed: () => (detached = true)
      })
      assert.deepStrictEqual(result, { kind: 'setup-required' })
      assert.strictEqual(detached, false)
      assert.deepStrictEqual(
        fake.calls.map(call => call.method),
        ['setup.status']
      )
    })
  })

  it.effect('close failure preserves the old state and never creates a second session', () => {
    let detached = false
    const fake = fakeGateway(method => {
      if (method === 'setup.status') return Effect.succeed({ provider_configured: true })
      if (method === 'session.close') return Effect.fail(rpcFailure(method))
      return Effect.die('session.create must not run')
    })
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        replaceSession(fake.service, {
          activeSessionId: 'old-live',
          cols: 80,
          cwd: '/work',
          onClosed: () => (detached = true)
        })
      )
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(detached, false)
      assert.deepStrictEqual(
        fake.calls.map(call => call.method),
        ['setup.status', 'session.close']
      )
    })
  })

  it.effect('create failure detaches after close and is never retried', () => {
    let detached = false
    const fake = fakeGateway(method => {
      if (method === 'setup.status') return Effect.succeed({ provider_configured: true })
      if (method === 'session.close') return Effect.succeed({ closed: true })
      if (method === 'session.create') return Effect.fail(rpcFailure(method))
      return Effect.die('unexpected RPC')
    })
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        replaceSession(fake.service, {
          activeSessionId: 'old-live',
          cols: 80,
          cwd: '/work',
          onClosed: () => (detached = true)
        })
      )
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(detached, true)
      assert.deepStrictEqual(
        fake.calls.map(call => call.method),
        ['setup.status', 'session.close', 'session.create']
      )
    })
  })

  it.effect('a blank create SID is a typed protocol failure, never an old-SID fallback', () => {
    const fake = fakeGateway(method => {
      if (method === 'setup.status') return Effect.succeed({ provider_configured: true })
      if (method === 'session.close') return Effect.succeed({ closed: true })
      return Effect.succeed({ session_id: '   ' })
    })
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        replaceSession(fake.service, {
          activeSessionId: 'old-live',
          cols: 80,
          cwd: undefined,
          onClosed: () => {}
        })
      )
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.instanceOf(Cause.squash(exit.cause), SessionProtocolError)
    })
  })
})

describe('resumeSession', () => {
  it.effect('hydrates session age and arms completion drain for an already-running turn', () => {
    const store = createSessionStore()
    let drained = 0
    store.registerTurnCompleteHandler(() => (drained += 1))
    const service = fakeGateway(() =>
      Effect.succeed({
        inflight: { assistant: 'partial', streaming: true, user: 'question' },
        info: { model: 'live-model' },
        messages: [],
        running: true,
        session_id: 'running-live',
        started_at: 123.5,
        status: 'working'
      })
    ).service
    return Effect.gen(function* () {
      yield* resumeSession(service, store, { cols: 80, targetSessionId: 'durable-key' })
      assert.strictEqual(store.state.info.startedAt, 123_500)
      assert.isTrue(store.isTurnInFlight())
      store.applyInfo({ running: false })
      assert.strictEqual(drained, 1)
      assert.isFalse(store.isTurnInFlight())
    })
  })

  it.effect('adopts the returned live SID, filters old buffered events, and returns the prior live SID', () => {
    const store = createSessionStore()
    store.setSessionId('old-live')
    let current: string | undefined = 'old-live'
    const calls: string[] = []
    const service: GatewayServiceShape = {
      request: <A>(method: string) =>
        Effect.sync(() => {
          calls.push(method)
          if (method === 'session.resume') {
            store.apply({ type: 'message.start', session_id: 'old-live' })
            store.apply({ type: 'message.delta', session_id: 'old-live', payload: { text: 'stale' } })
            store.apply({ type: 'message.start', session_id: 'new-live' })
            store.apply({ type: 'message.delta', session_id: 'new-live', payload: { text: 'fresh' } })
            current = 'new-live'
            return {
              info: { model: 'resumed-model' },
              messages: [{ role: 'user', text: 'saved question' }],
              resumed: 'persisted-key',
              session_id: 'new-live'
            } as A
          }
          return { closed: true } as A
        }),
      sessionId: () => current,
      logTail: () => [],
      subscribe: () => Effect.succeed(() => {})
    }

    return Effect.gen(function* () {
      const result = yield* resumeSession(service, store, { cols: 100, targetSessionId: 'persisted-key' })
      assert.strictEqual(result.sessionId, 'new-live')
      assert.strictEqual(result.resumedId, 'persisted-key')
      assert.deepStrictEqual(calls, ['session.resume'])
      assert.strictEqual(result.previousSessionId, 'old-live')
      assert.strictEqual(store.state.sessionId, 'new-live')
      assert.strictEqual(store.state.resumeId, 'persisted-key')
      assert.strictEqual(store.state.info.model, 'resumed-model')
      assert.strictEqual(store.state.messages[0]?.text, 'saved question')
      const freshPart = store.state.messages[1]?.parts?.[0]
      assert.strictEqual(freshPart?.type, 'text')
      assert.strictEqual(freshPart?.type === 'text' ? freshPart.text : undefined, 'fresh')
      assert.notInclude(JSON.stringify(store.state.messages), 'stale')
    })
  })

  it.effect('preserves the latest draft typed while an ordinary resume RPC is in flight', () => {
    const store = createSessionStore()
    store.setSessionId('old-live')
    const service: GatewayServiceShape = {
      request: <A>() =>
        Effect.sync(() => {
          store.setComposerDraft('typed after resume started')
          return { messages: [], resumed: 'target-key', session_id: 'new-live' } as A
        }),
      sessionId: () => 'old-live',
      logTail: () => [],
      subscribe: () => Effect.succeed(() => {})
    }
    return Effect.gen(function* () {
      yield* resumeSession(service, store, {
        cols: 80,
        preserveLocalInput: 'draft',
        targetSessionId: 'target-key'
      })
      assert.strictEqual(store.state.composerDraft, 'typed after resume started')
      assert.strictEqual(store.state.sessionId, 'new-live')
    })
  })

  it.effect('same-session recovery snapshots the latest queue/edit/draft at commit time', () => {
    const store = createSessionStore()
    store.setSessionId('dead-live')
    const service: GatewayServiceShape = {
      request: <A>() =>
        Effect.sync(() => {
          store.enqueuePrompt('queued during recovery')
          store.setQueueEditIndex(0)
          store.setComposerDraft('edited after recovery started')
          return { messages: [], resumed: 'durable-key', session_id: 'replacement-live' } as A
        }),
      sessionId: () => 'dead-live',
      logTail: () => [],
      subscribe: () => Effect.succeed(() => {})
    }
    return Effect.gen(function* () {
      yield* resumeSession(service, store, {
        cols: 80,
        preserveLocalInput: 'same-session',
        targetSessionId: 'durable-key'
      })
      assert.deepStrictEqual(store.state.queuedPrompts, ['queued during recovery'])
      assert.strictEqual(store.state.queueEditIndex, 0)
      assert.strictEqual(store.state.composerDraft, 'edited after recovery started')
    })
  })

  it.effect('failed resume aborts the buffer and preserves the prior live session', () => {
    const store = createSessionStore()
    store.setSessionId('old-live')
    const service: GatewayServiceShape = {
      request: <A>(method: string) => {
        if (method !== 'session.resume')
          return Effect.die('old session must not close') as Effect.Effect<A, GatewayError>
        return Effect.gen(function* () {
          yield* Effect.sync(() => {
            store.apply({ type: 'message.start', session_id: 'old-live' })
            store.apply({ type: 'message.delta', session_id: 'old-live', payload: { text: 'kept' } })
            store.apply({ type: 'message.start', session_id: 'target-live' })
            store.apply({ type: 'message.delta', session_id: 'target-live', payload: { text: 'discarded' } })
          })
          return yield* Effect.fail(rpcFailure(method))
        }) as Effect.Effect<A, GatewayError>
      },
      sessionId: () => 'old-live',
      logTail: () => [],
      subscribe: () => Effect.succeed(() => {})
    }

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(resumeSession(service, store, { cols: 80, targetSessionId: 'persisted-key' }))
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(store.state.sessionId, 'old-live')
      const keptPart = store.state.messages.at(-1)?.parts?.[0]
      assert.strictEqual(keptPart?.type === 'text' ? keptPart.text : undefined, 'kept')
      assert.notInclude(JSON.stringify(store.state.messages), 'discarded')
    })
  })

  it.effect('blank response SID aborts buffering with a typed protocol failure', () => {
    const store = createSessionStore()
    const service: GatewayServiceShape = {
      request: <A>() => Effect.succeed({ session_id: ' ' } as A),
      sessionId: () => 'old-live',
      logTail: () => [],
      subscribe: () => Effect.succeed(() => {})
    }
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(resumeSession(service, store, { cols: 80, targetSessionId: 'persisted-key' }))
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.instanceOf(Cause.squash(exit.cause), SessionProtocolError)
      // A subsequent event applies immediately: the failed transaction did not
      // leave the store permanently buffering.
      store.apply({ type: 'message.start', session_id: 'old-live' })
      assert.strictEqual(store.state.messages.length, 1)
    })
  })

  it.effect('null response is schema-rejected and the buffer finalizer always rolls back', () => {
    const store = createSessionStore()
    const service: GatewayServiceShape = {
      request: <A>() => Effect.succeed(null as A),
      sessionId: () => 'old-live',
      logTail: () => [],
      subscribe: () => Effect.succeed(() => {})
    }
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(resumeSession(service, store, { cols: 80, targetSessionId: 'persisted-key' }))
      assert.isTrue(Exit.isFailure(exit))
      store.apply({ type: 'message.start', session_id: 'old-live' })
      assert.strictEqual(store.state.messages.length, 1)
    })
  })
})
