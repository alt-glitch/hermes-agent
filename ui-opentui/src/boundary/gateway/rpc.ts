/**
 * Wire types for the JSON-RPC methods ui-opentui calls.
 *
 * `RpcMethods` is generated from `tui_gateway/contracts` by
 * `scripts/gen_gateway_contracts.py`. Typing `request()` against it makes
 * `tsc` reject a param key or a result field the Python contract does not
 * declare. The import is type-only, so nothing from `apps/shared` reaches the
 * bundle.
 */
import type { RpcMethod, RpcMethods } from '@hermes/gateway-contract'

export type { RpcMethod, RpcMethods }

/**
 * Params as sent on the wire. An optional key may also carry `undefined`:
 * `JSON.stringify` drops it, so `{ session_id: undefined }` and `{}` are the
 * same frame. Required keys and excess-key checks are unchanged.
 */
export type WireParams<T> = { [K in keyof T]: Record<never, never> extends Pick<T, K> ? T[K] | undefined : T[K] }

export type RpcParams<M extends RpcMethod> = WireParams<RpcMethods[M]['params']>
export type RpcResult<M extends RpcMethod> = RpcMethods[M]['result']

/** Promise-returning request seam handed to logic/ modules (slash, wake, billing, store). */
export type RpcRequest = <M extends RpcMethod>(method: M, params: RpcParams<M>) => Promise<RpcResult<M>>
