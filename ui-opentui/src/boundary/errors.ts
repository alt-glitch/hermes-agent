/**
 * Typed errors at the gateway boundary.
 *
 * Per spec v4 §3.4: internal errors use `Data.TaggedError`; wire/serializable
 * errors use Schema-based tagged errors (added in Phase 1 alongside the
 * GatewayEvent schema). Phase 0 ships the internal set the renderer/transport
 * boundary needs.
 *
 * Boundary code yields these directly (`return yield* new FooError(...)`) — no
 * throw / try-catch / Promise.catch / orDie.
 */
import { Data } from 'effect'

/** The renderer (createCliRenderer) failed to acquire. */
export class RendererError extends Data.TaggedError('RendererError')<{
  readonly cause: unknown
}> {}

/** Could not resolve a usable Python interpreter for the gateway. */
export class PythonResolutionError extends Data.TaggedError('PythonResolutionError')<{
  readonly tried: ReadonlyArray<string>
}> {}

/** A JSON-RPC request to the gateway failed (timeout, transport down, rpc error). */
export class GatewayError extends Data.TaggedError('GatewayError')<{
  readonly code?: number
  readonly data?: unknown
  readonly method: string
  readonly reason: 'timeout' | 'transport-down' | 'rpc-error'
  readonly message: string
}> {}
