/** Blocking-prompt replies (answer a backend→client request) and their decoded dispositions. */
import { Option, Schema } from 'effect'

import type { AnswerOutcome, ServerRequestResult, ServerRequestRouter } from './gateway/serverRequests.ts'

/**
 * What the prompt overlay asks the entry to deliver:
 *   answer — the JSON-RPC response to open request `requestId` (serverRequests.ts router);
 *   lock   — one batch-clarify answer through the `clarify.lock` RPC (the request stays open).
 */
export type PromptReply =
  | { readonly kind: 'answer'; readonly requestId: string; readonly result: ServerRequestResult }
  | { readonly kind: 'lock'; readonly requestId: string; readonly questionId: string; readonly answer: string }

export type PromptResponseDisposition =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'terminal'; readonly reason: 'expired' | 'obsolete' }
  | { readonly kind: 'uncertain'; readonly message: string }

export const PROMPT_ACCEPTED = { kind: 'accepted' } as const
export const PROMPT_EXPIRED = { kind: 'terminal', reason: 'expired' } as const

type PromptResponseUncertain = Extract<PromptResponseDisposition, { kind: 'uncertain' }>

function uncertain(message: string): PromptResponseUncertain {
  return { kind: 'uncertain', message }
}

const decodeLockResult = Schema.decodeUnknownOption(
  Schema.Struct({
    status: Schema.Literals(['ok', 'expired']),
    remaining: Schema.optionalKey(Schema.Array(Schema.String))
  })
)

/** `clarify.lock` result: `ok` locked the answer, `expired` means the request already ended.
 *  `resolved`: that lock was the last one (`remaining: []`), so the backend resolved the request. */
function decodeClarifyLock(value: unknown): {
  readonly disposition: PromptResponseDisposition
  readonly resolved: boolean
} {
  const decoded = decodeLockResult(value)
  if (Option.isNone(decoded))
    return { disposition: uncertain('gateway returned an unrecognized clarify.lock response'), resolved: false }
  if (decoded.value.status === 'expired') return { disposition: PROMPT_EXPIRED, resolved: false }
  return { disposition: PROMPT_ACCEPTED, resolved: decoded.value.remaining?.length === 0 }
}

export function classifyClarifyLock(value: unknown): PromptResponseDisposition {
  return decodeClarifyLock(value).disposition
}

/** Convert a rejected RPC into the same explicit uncertainty domain. */
export function promptTransportUncertain(cause: unknown): PromptResponseUncertain {
  return uncertain(cause instanceof Error ? cause.message : 'response delivery was not confirmed')
}

/** A response that was never written (transport down) leaves the request open: the overlay's
 *  uncertain phase offers `r` to send the same answer again. */
const ANSWER_DISPOSITION: Readonly<Record<AnswerOutcome, PromptResponseDisposition>> = {
  sent: PROMPT_ACCEPTED,
  closed: PROMPT_EXPIRED,
  'not-sent': uncertain('not sent — the gateway connection is down; the request is still open')
}

export interface PromptResponderOptions {
  readonly router: Pick<ServerRequestRouter, 'answer' | 'forget'>
  /** The `clarify.lock` RPC. */
  readonly lock: (params: {
    readonly answer: string
    readonly question_id: string
    readonly request_id: string
  }) => Promise<unknown>
  readonly warn: (message: string, fields: Readonly<Record<string, unknown>>) => void
}

/**
 * The prompt overlay's `onRespond`: an answer is the JSON-RPC response to the open request; a
 * batch-clarify lock is the `clarify.lock` RPC. The last lock resolves the request on the backend
 * (no request.cancel follows), so the router forgets it there.
 */
export function createPromptResponder(
  options: PromptResponderOptions
): (reply: PromptReply) => Promise<PromptResponseDisposition> {
  return async reply => {
    if (reply.kind === 'answer') return ANSWER_DISPOSITION[options.router.answer(reply.requestId, reply.result)]
    try {
      const { disposition, resolved } = decodeClarifyLock(
        await options.lock({ answer: reply.answer, question_id: reply.questionId, request_id: reply.requestId })
      )
      if (disposition.kind === 'uncertain') options.warn(disposition.message, { method: 'clarify.lock' })
      if (resolved) options.router.forget(reply.requestId)
      return disposition
    } catch (cause) {
      options.warn('failed', { cause: String(cause), method: 'clarify.lock' })
      return promptTransportUncertain(cause)
    }
  }
}
