/**
 * Effect 4 decode boundary for the session's standing /goal
 * (`session.control.read` result and the `goal` slot of
 * `session.control.update`). The event envelope keeps `goal` as Unknown so a
 * partial snapshot never rejects the whole frame; this decoder narrows it once
 * for the goal row. Mirrors `GoalSnapshot` in the generated gateway contract.
 */
import { Option, Schema } from 'effect'

const Str = Schema.String
const Num = Schema.Number
const opt = Schema.optionalKey
const UnknownFields = Schema.Record(Str, Schema.Unknown)

const WaitBarrierUntilSchema = Schema.StructWithRest(
  Schema.Struct({ type: Schema.Literal('until'), until_at: Num, reason: opt(Schema.NullOr(Str)) }),
  [UnknownFields]
)
const WaitBarrierTargetSchema = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literals(['session', 'pid']),
    target: Schema.Union([Str, Num]),
    reason: opt(Schema.NullOr(Str))
  }),
  [UnknownFields]
)

export const GoalSnapshotSchema = Schema.StructWithRest(
  Schema.Struct({
    title: Str,
    status: Str,
    turns_used: Num,
    max_turns: Num,
    paused_reason: opt(Schema.NullOr(Str)),
    wait_barrier: opt(Schema.NullOr(Schema.Union([WaitBarrierUntilSchema, WaitBarrierTargetSchema])))
  }),
  [UnknownFields]
)
export type GoalSnapshot = typeof GoalSnapshotSchema.Type

const decodeGoal = Schema.decodeUnknownOption(GoalSnapshotSchema)

/** `null`/absent → no goal; a malformed snapshot also yields null (no row) rather than a fake one. */
export function decodeGoalSnapshot(raw: unknown): GoalSnapshot | null {
  if (raw === null || raw === undefined) return null
  return Option.getOrNull(decodeGoal(raw))
}

export const SessionControlReadResponseSchema = Schema.StructWithRest(
  Schema.Struct({ control: Schema.StructWithRest(Schema.Struct({ goal: Schema.Unknown }), [UnknownFields]) }),
  [UnknownFields]
)
export const decodeSessionControlReadResponse = Schema.decodeUnknownOption(SessionControlReadResponseSchema)
