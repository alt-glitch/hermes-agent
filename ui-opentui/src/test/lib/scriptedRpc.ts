import type { RpcMethod, RpcParams, RpcRequest, RpcResult } from '../../boundary/gateway/rpc.ts'

/** A test responder: sees the method and a plain params record, returns any reply. */
export type ScriptedResponder = (method: RpcMethod, params: Readonly<Record<string, unknown>>) => Promise<unknown>

/**
 * Adapt a scripted responder to the typed `RpcRequest` seam. Replies are test
 * data, not contract-checked; decoders in the code under test still run.
 */
export function scriptedRpc(respond: ScriptedResponder): RpcRequest {
  return <M extends RpcMethod>(method: M, params: RpcParams<M>) =>
    respond(method, { ...params }) as Promise<RpcResult<M>>
}
