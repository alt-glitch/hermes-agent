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
import type { OpenRequestEntry, ServerRequest, ServerRequestDisposition } from './client.ts'
import type { RpcMethod, RpcParams, RpcResult } from './rpc.ts'

export interface GatewayTransport {
  /** Push decoded gateway events into the Solid store. Returns an unsubscribe fn. */
  readonly subscribe: (handler: (event: GatewayEvent) => void) => Effect.Effect<() => void>
  /** Typed JSON-RPC request to the Python gateway. Fails with a typed GatewayError, never throws. */
  readonly request: <M extends RpcMethod>(method: M, params: RpcParams<M>) => Effect.Effect<RpcResult<M>, GatewayError>
  /** Install the handler for backend→client JSON-RPC requests (clarify, approval, sudo, …); returns an
   *  uninstall fn. The handler returns false for methods it does not serve (the client answers -32601).
   *  Absent on transports with no backend (fake gateway, test doubles). */
  readonly serveRequests?: (handler: (request: ServerRequest) => ServerRequestDisposition) => () => void
  /** Re-deliver a hydration's `open_requests` to the installed handler, as if each had just arrived. */
  readonly replayRequests?: (entries: readonly OpenRequestEntry[]) => void
  /** The active live session id; undefined before a session exists. */
  readonly sessionId: () => string | undefined
  /** Bounded low-level transport diagnostics used by the local `/logs` pager. */
  readonly logTail: (limit: number) => string[]
}

export class GatewayService extends Context.Service<GatewayService, GatewayTransport>()('@hermes-tui/GatewayService') {}
