/**
 * Phase 0 boundary test (spec v4 §5 Layer 1). Exercises the GatewayService shape
 * through the FakeGateway layer using @effect/vitest's `it.effect`: subscribe
 * receives emitted events; request records the call. Proves the Effect<->Solid
 * seam (subscribe) and the typed request path compile + run.
 *
 * `it.effect` runs the program in a scoped test runtime (TestClock + TestConsole
 * provided automatically), replacing the old hand-rolled ManagedRuntime shim.
 * The fake layer carries per-test controller state (we assert `controller.calls`),
 * so it's provided locally — the testing guide's allowed one-off, not a shared
 * `layer(...)` group.
 */
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { GatewayService } from '../boundary/gateway/GatewayService.ts'
import type { GatewayEvent } from '../boundary/schema/GatewayEvent.ts'
import { fakeGatewayLayerWith, makeFakeGateway } from '../entry/fakeGateway.ts'

describe('GatewayService via FakeGateway (Phase 0)', () => {
  it.effect('subscribe receives emitted events; request records the call', () => {
    const controller = makeFakeGateway('sess-123')
    const received: GatewayEvent[] = []

    return Effect.gen(function* () {
      const gateway = yield* GatewayService
      const unsubscribe = yield* gateway.subscribe(event => received.push(event))
      // Emit after subscribing (synchronous fan-out in the fake).
      controller.emit({ type: 'gateway.ready' })
      controller.emit({ type: 'message.start' })
      yield* gateway.request('prompt.submit', { session_id: 'sid-test', text: 'hi' })
      unsubscribe()
      controller.emit({ type: 'message.complete' }) // dropped: unsubscribed

      assert.strictEqual(gateway.sessionId(), 'sess-123')
      assert.deepStrictEqual(
        received.map(e => e.type),
        ['gateway.ready', 'message.start']
      )
      assert.deepStrictEqual(controller.calls, [
        { method: 'prompt.submit', params: { session_id: 'sid-test', text: 'hi' } }
      ])
    }).pipe(Effect.provide(fakeGatewayLayerWith(controller)))
  })
})
