/** Effect 4 decode boundary for blocking-prompt requests and response RPCs. */
import { Option, Schema } from 'effect'

export type PromptResponseMethod = 'approval.respond' | 'clarify.respond' | 'secret.respond' | 'sudo.respond'

const Str = Schema.String
const opt = Schema.optionalKey

/** One request-specific approval, shared by live events and pending snapshots. */
export const ApprovalRequestPayloadSchema = Schema.Struct({
  allow_permanent: opt(Schema.Boolean),
  choices: opt(Schema.Array(Str)),
  command: Str,
  description: Str,
  request_id: Schema.NonEmptyString,
  smart_denied: opt(Schema.Boolean)
})
export type ApprovalRequestPayload = typeof ApprovalRequestPayloadSchema.Type

const ApprovalPendingResponseSchema = Schema.Struct({ approvals: Schema.Array(ApprovalRequestPayloadSchema) })
const StatusResponseSchema = Schema.Struct({ status: Schema.Literals(['ok', 'expired']) })
const ApprovalResponseSchema = Schema.Struct({ resolved: Schema.Number })
const decodePendingApprovals = Schema.decodeUnknownOption(ApprovalPendingResponseSchema)
const decodeStatusResponse = Schema.decodeUnknownOption(StatusResponseSchema)
const decodeApproval = Schema.decodeUnknownOption(ApprovalResponseSchema)

export type PromptResponseDisposition =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'terminal'; readonly reason: 'expired' | 'obsolete' }
  | { readonly kind: 'uncertain'; readonly message: string }

const ACCEPTED = { kind: 'accepted' } as const
const EXPIRED = { kind: 'terminal', reason: 'expired' } as const
const OBSOLETE = { kind: 'terminal', reason: 'obsolete' } as const

type PromptResponseUncertain = Extract<PromptResponseDisposition, { kind: 'uncertain' }>

function uncertain(message: string): PromptResponseUncertain {
  return { kind: 'uncertain', message }
}

/**
 * Classify only documented response shapes. A legacy approval `resolved: 0`
 * proves that this exact request is already gone; malformed/version-skewed
 * values prove neither delivery nor rejection and therefore stay uncertain.
 */
export function classifyPromptResponse(method: PromptResponseMethod, value: unknown): PromptResponseDisposition {
  if (method === 'approval.respond') {
    const decoded = decodeApproval(value)
    if (Option.isNone(decoded) || !Number.isSafeInteger(decoded.value.resolved) || decoded.value.resolved < 0) {
      return uncertain('gateway returned an unrecognized approval response')
    }
    return decoded.value.resolved === 0 ? OBSOLETE : ACCEPTED
  }

  const decoded = decodeStatusResponse(value)
  if (Option.isNone(decoded)) return uncertain('gateway returned an unrecognized prompt response')
  return decoded.value.status === 'ok' ? ACCEPTED : EXPIRED
}

/** Convert a rejected RPC into the same explicit uncertainty domain. */
export function promptTransportUncertain(cause: unknown): PromptResponseUncertain {
  return uncertain(cause instanceof Error ? cause.message : 'response delivery was not confirmed')
}

/** Decode the authoritative FIFO snapshot used after session reconnection. */
export function decodeApprovalPendingResponse(value: unknown): readonly ApprovalRequestPayload[] | undefined {
  const decoded = decodePendingApprovals(value)
  return Option.isSome(decoded) ? decoded.value.approvals : undefined
}

export interface ApprovalPendingReconciler {
  readonly getPromptRequestId: () => string | undefined
  readonly getPromptRevision: () => number
  readonly reconcilePendingApprovals: (
    sessionId: string,
    expectedRevision: number,
    expectedRequestId: string | undefined,
    approvals: readonly ApprovalRequestPayload[]
  ) => boolean
}

export type ApprovalPendingReconcileOutcome = 'applied' | 'ignored' | 'invalid'

/**
 * Fetch one reconnect snapshot and apply it against the prompt identity that
 * existed when the fetch began. A delayed snapshot can therefore never retire
 * or replace a prompt that arrived while the RPC was in flight.
 */
export async function reconcilePendingApprovalSnapshot(
  load: () => Promise<unknown>,
  store: ApprovalPendingReconciler,
  sessionId: string
): Promise<ApprovalPendingReconcileOutcome> {
  const revision = store.getPromptRevision()
  const requestId = store.getPromptRequestId()
  const approvals = decodeApprovalPendingResponse(await load())
  if (approvals === undefined) return 'invalid'
  return store.reconcilePendingApprovals(sessionId, revision, requestId, approvals) ? 'applied' : 'ignored'
}
