/**
 * FakeGateway — the test/dev implementation of GatewayService (spec v4 §2/§5
 * Layer-3 seam). Provides an emittable event source and a spy `request`, so
 * store/component tests can drive synthetic streams and assert RPC calls
 * without spawning Python. Mirrors opencode's injectable fake transport.
 *
 * Phase 0 uses it to stream a scripted "hello" so the entry/test renders a
 * non-empty frame. Phase 1 swaps in `liveGateway.layer` (real `tui_gateway`).
 */
import { Effect, Layer } from 'effect'

import { GatewayService, type GatewayServiceShape } from '../boundary/gateway/GatewayService.ts'
import type { GatewayEvent } from '../boundary/schema/GatewayEvent.ts'

export interface FakeGatewayController {
  readonly service: GatewayServiceShape
  /** Emit a decoded event to all subscribers (drives the store in tests). */
  readonly emit: (event: GatewayEvent) => void
  /** Recorded (method, params) pairs from `request` calls. */
  readonly calls: Array<{ method: string; params: unknown }>
}

/** Build a fresh fake controller (used directly in tests, or wrapped as a Layer). */
export function makeFakeGateway(initialSessionId = 'fake-session'): FakeGatewayController {
  const handlers = new Set<(event: GatewayEvent) => void>()
  const calls: Array<{ method: string; params: unknown }> = []

  const service: GatewayServiceShape = {
    subscribe: handler =>
      Effect.sync(() => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      }),
    request: <A>(method: string, params: unknown) =>
      Effect.sync(() => {
        calls.push({ method, params })
        return undefined as A
      }),
    sessionId: () => initialSessionId,
    logTail: () => []
  }

  return {
    service,
    emit: event => {
      for (const handler of handlers) handler(event)
    },
    calls
  }
}

/** A GatewayService layer backed by a fresh FakeGateway. The controller is
 *  reachable for assertions via the returned tuple in tests; for the dev entry
 *  use {@link fakeGatewayLayer} and drive it from a scripted effect. */
export function fakeGatewayLayerWith(controller: FakeGatewayController): Layer.Layer<GatewayService> {
  return Layer.succeed(GatewayService, controller.service)
}

/** Convenience: a layer + its controller, for the dev entry's scripted stream. */
export function makeFakeGatewayLayer(): { layer: Layer.Layer<GatewayService>; controller: FakeGatewayController } {
  const controller = makeFakeGateway()
  return { layer: Layer.succeed(GatewayService, controller.service), controller }
}
