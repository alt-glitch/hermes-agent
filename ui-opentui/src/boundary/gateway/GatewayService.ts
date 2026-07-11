/**
 * GatewayService — the Effect-side transport boundary.
 *
 * Phase 0: the SHAPE only. The live layer (spawning the Python `tui_gateway`,
 * JSON-RPC framing, Schema-decoding the wire union) lands in Phase 1
 * (`boundary/gateway/liveGateway.ts`). For now the only implementation is
 * `FakeGateway.layer` (entry/fakeGateway.ts), which the render/test harness uses.
 *
 * This is one of exactly two Effect<->Solid contact points: the Solid store
 * subscribes via `subscribe(handler)` and the boundary pushes DECODED events in.
 * Per spec v4 §1, the store/reducer themselves are plain Solid, never Effect.
 */
import { Context, type Effect } from 'effect'

import type { GatewayError } from '../errors.ts'
import type { GatewayEvent } from '../schema/GatewayEvent.ts'

export interface GatewayServiceShape {
  /** Push decoded gateway events into the Solid store. Returns an unsubscribe fn. */
  readonly subscribe: (handler: (event: GatewayEvent) => void) => Effect.Effect<() => void>
  /** Typed JSON-RPC request to the Python gateway. Fails with a typed GatewayError, never throws. */
  readonly request: <A>(method: string, params: unknown) => Effect.Effect<A, GatewayError>
  /** The active session id (for `approval.respond {session_id}`); undefined before a session exists. */
  readonly sessionId: () => string | undefined
  /** Bounded low-level transport diagnostics used by the local `/logs` pager. */
  readonly logTail: (limit: number) => string[]
}

export class GatewayService extends Context.Service<GatewayService, GatewayServiceShape>()(
  '@hermes-tui/GatewayService'
) {}
