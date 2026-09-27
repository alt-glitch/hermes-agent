/** Blocking-prompt replies (answer a backend→client request) and their decoded dispositions. */
import { Option, Schema } from 'effect'

import type { ServerRequestResult } from './gateway/serverRequests.ts'

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

const decodeLockStatus = Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Literals(['ok', 'expired']) }))

/** `clarify.lock` result: `ok` locked the answer, `expired` means the request already ended. */
export function classifyClarifyLock(value: unknown): PromptResponseDisposition {
  const decoded = decodeLockStatus(value)
  if (Option.isNone(decoded)) return uncertain('gateway returned an unrecognized clarify.lock response')
  return decoded.value.status === 'ok' ? PROMPT_ACCEPTED : PROMPT_EXPIRED
}

/** Convert a rejected RPC into the same explicit uncertainty domain. */
export function promptTransportUncertain(cause: unknown): PromptResponseUncertain {
  return uncertain(cause instanceof Error ? cause.message : 'response delivery was not confirmed')
}
