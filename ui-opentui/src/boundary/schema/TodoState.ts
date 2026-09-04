/** Authoritative todo-list state shared by live events and session snapshots. */
import { Schema } from 'effect'

const Str = Schema.String
const UnknownFields = Schema.Record(Str, Schema.Unknown)
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Todo items stay loose at the transport boundary. Persisted sessions can
 * contain legacy or partially malformed entries; the store narrows each item
 * defensively so one bad row never rejects an otherwise valid session resume.
 */
export const TodoStateSchema = Schema.StructWithRest(
  Schema.Struct({
    revision: NonNegativeInt,
    todos: Schema.Array(Schema.Unknown)
  }),
  [UnknownFields]
)

export type TodoState = typeof TodoStateSchema.Type
