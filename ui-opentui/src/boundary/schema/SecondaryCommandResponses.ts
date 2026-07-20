import { Option, Schema } from 'effect'

const Str = Schema.String
const Num = Schema.Number
const Bool = Schema.Boolean
const opt = Schema.optionalKey
const loose = Schema.Struct

const UsageBarSchema = loose({
  kind: Schema.Literals(['plan', 'topup']),
  remaining_display: Str,
  total_display: Str,
  spent_display: Str,
  pct_used: Schema.NullOr(Num),
  fill_fraction: Num
})
const UsageModelSchema = loose({
  available: Bool,
  status: opt(Str),
  plan_name: opt(Schema.NullOr(Str)),
  renews_display: opt(Schema.NullOr(Str)),
  total_spendable_display: opt(Schema.NullOr(Str)),
  has_topup: opt(Bool),
  plan_bar: opt(Schema.NullOr(UsageBarSchema)),
  topup_bar: opt(Schema.NullOr(UsageBarSchema))
})

export const SessionUsageResponseSchema = loose({
  calls: opt(Num),
  compressions: opt(Num),
  context_max: opt(Num),
  context_percent: opt(Num),
  context_used: opt(Num),
  credits_lines: opt(Schema.Array(Str)),
  input: opt(Num),
  model: opt(Str),
  output: opt(Num),
  total: opt(Num),
  usage: opt(UsageModelSchema)
})
export type SessionUsageResponse = typeof SessionUsageResponseSchema.Type

export const CreditsViewResponseSchema = loose({
  balance_lines: Schema.Array(Str),
  depleted: Bool,
  identity_line: Schema.NullOr(Str),
  logged_in: Bool,
  topup_url: Schema.NullOr(Str)
})
export type CreditsViewResponse = typeof CreditsViewResponseSchema.Type

export const PersonalityResponseSchema = loose({
  history_reset: opt(Bool),
  info: opt(Schema.NullOr(Schema.Record(Str, Schema.Unknown))),
  value: Str
})
export type PersonalityResponse = typeof PersonalityResponseSchema.Type

const CheckpointSchema = loose({ hash: Str, message: Str, timestamp: Str })
export const RollbackListResponseSchema = loose({
  checkpoints: Schema.Array(CheckpointSchema),
  enabled: Bool
})
export const RollbackDiffResponseSchema = loose({
  diff: opt(Str),
  rendered: opt(Str),
  stat: opt(Str)
})
export const RollbackRestoreResponseSchema = loose({
  error: opt(Str),
  history_removed: opt(Num),
  message: opt(Str),
  reason: opt(Str),
  restored_to: opt(Str),
  success: Bool
})

const some = <A>(value: Option.Option<A>): A | undefined => (Option.isSome(value) ? value.value : undefined)
export const decodeSessionUsageResponse = (value: unknown): SessionUsageResponse | undefined =>
  some(Schema.decodeUnknownOption(SessionUsageResponseSchema)(value))
export const decodeCreditsViewResponse = (value: unknown): CreditsViewResponse | undefined =>
  some(Schema.decodeUnknownOption(CreditsViewResponseSchema)(value))
export const decodePersonalityResponse = (value: unknown): PersonalityResponse | undefined =>
  some(Schema.decodeUnknownOption(PersonalityResponseSchema)(value))
export const decodeRollbackListResponse = (value: unknown) =>
  some(Schema.decodeUnknownOption(RollbackListResponseSchema)(value))
export const decodeRollbackDiffResponse = (value: unknown) =>
  some(Schema.decodeUnknownOption(RollbackDiffResponseSchema)(value))
export const decodeRollbackRestoreResponse = (value: unknown) =>
  some(Schema.decodeUnknownOption(RollbackRestoreResponseSchema)(value))
