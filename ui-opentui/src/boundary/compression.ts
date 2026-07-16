/** Effect 4 boundary for the sparse, additive f7 session.compress response. */
import { Option, Schema } from 'effect'

import { SessionInfoPatchSchema } from './schema/SessionInfo.ts'

const Str = Schema.String
const Num = Schema.Number
const opt = Schema.optionalKey
const UnknownFields = Schema.Record(Str, Schema.Unknown)
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const UsageSchema = Schema.StructWithRest(
  Schema.Struct({
    active_subagents: opt(NonNegativeInt),
    calls: opt(NonNegativeInt),
    completion: opt(NonNegativeInt),
    compressions: opt(NonNegativeInt),
    context_max: opt(Num),
    context_percent: opt(Num),
    context_used: opt(Num),
    cost_status: opt(Str),
    cost_usd: opt(Num),
    dev_credits_spent_micros: opt(NonNegativeInt),
    input: opt(NonNegativeInt),
    model: opt(Str),
    output: opt(NonNegativeInt),
    prompt: opt(NonNegativeInt),
    reasoning: opt(NonNegativeInt),
    total: opt(NonNegativeInt)
  }),
  [UnknownFields]
)
const SummarySchema = Schema.StructWithRest(
  Schema.Struct({ headline: opt(Str), noop: opt(Schema.Boolean), note: opt(Schema.NullOr(Str)), token_line: opt(Str) }),
  [UnknownFields]
)

export const SessionCompressResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    after_messages: opt(NonNegativeInt),
    after_tokens: opt(NonNegativeInt),
    before_messages: opt(NonNegativeInt),
    before_tokens: opt(NonNegativeInt),
    info: opt(SessionInfoPatchSchema),
    messages: opt(Schema.Array(Schema.Unknown)),
    removed: opt(NonNegativeInt),
    session_key: opt(Str),
    status: opt(Schema.Literals(['compressed', 'aborted'])),
    summary: opt(SummarySchema),
    usage: opt(UsageSchema)
  }),
  [UnknownFields]
)
export type SessionCompressResponse = typeof SessionCompressResponseSchema.Type
const decodeCompress = Schema.decodeUnknownOption(SessionCompressResponseSchema)

export function decodeSessionCompressResponse(value: unknown): SessionCompressResponse | undefined {
  const decoded = decodeCompress(value)
  if (Option.isNone(decoded)) return undefined
  const response = decoded.value
  if (response.session_key !== undefined && !response.session_key.trim()) return undefined
  const meaningful =
    response.status !== undefined ||
    response.messages !== undefined ||
    response.info !== undefined ||
    response.usage !== undefined ||
    response.summary !== undefined ||
    response.removed !== undefined ||
    response.before_messages !== undefined ||
    response.after_messages !== undefined ||
    response.session_key !== undefined
  return meaningful ? response : undefined
}
