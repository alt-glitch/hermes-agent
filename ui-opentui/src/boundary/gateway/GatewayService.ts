/**
 * GatewayService — the Effect-side transport boundary.
 *
 * liveGateway.ts owns the Python transport; entry/fakeGateway.ts supplies the
 * render/test harness. Subscribers receive decoded events, while the Solid
 * store owns reactive state independently of the transport's Effect lifetime.
 */
import { Context, type Effect } from 'effect'

import type { GatewayError } from '../errors.ts'
import type { GatewayEvent } from '../schema/GatewayEvent.ts'

export interface GatewayTransport {
  /** Push decoded gateway events into the Solid store. Returns an unsubscribe fn. */
  readonly subscribe: (handler: (event: GatewayEvent) => void) => Effect.Effect<() => void>
  /** Typed JSON-RPC request to the Python gateway. Fails with a typed GatewayError, never throws. */
  readonly request: <A>(method: string, params: unknown) => Effect.Effect<A, GatewayError>
  /** The active session id (for `approval.respond {session_id}`); undefined before a session exists. */
  readonly sessionId: () => string | undefined
  /** Bounded low-level transport diagnostics used by the local `/logs` pager. */
  readonly logTail: (limit: number) => string[]
}

export class GatewayService extends Context.Service<GatewayService, GatewayTransport>()('@hermes-tui/GatewayService') {}
