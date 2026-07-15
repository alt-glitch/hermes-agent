/** Effect 4 acknowledgement boundary for blocking-prompt response RPCs. */
import { Option, Schema } from 'effect'

export type PromptResponseMethod = 'approval.respond' | 'clarify.respond' | 'secret.respond' | 'sudo.respond'

const StatusOkResponseSchema = Schema.Struct({ status: Schema.Literal('ok') })
const SensitivePromptResponseSchema = Schema.Struct({ status: Schema.Literals(['ok', 'expired']) })
const ApprovalResponseSchema = Schema.Struct({ resolved: Schema.Number })
const decodeStatusOk = Schema.decodeUnknownOption(StatusOkResponseSchema)
const decodeSensitivePromptResponse = Schema.decodeUnknownOption(SensitivePromptResponseSchema)
const decodeApproval = Schema.decodeUnknownOption(ApprovalResponseSchema)

/** True only for the exact acknowledgement emitted by the f7 gateway method. */
export function promptResponseAcknowledged(method: PromptResponseMethod, value: unknown): boolean {
  if (method === 'approval.respond') {
    const decoded = decodeApproval(value)
    return Option.isSome(decoded) && Number.isSafeInteger(decoded.value.resolved) && decoded.value.resolved > 0
  }
  if (method === 'secret.respond' || method === 'sudo.respond') {
    return Option.isSome(decodeSensitivePromptResponse(value))
  }
  return Option.isSome(decodeStatusOk(value))
}
