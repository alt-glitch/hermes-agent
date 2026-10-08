/** Effect 4 decode boundaries for the OS background-process control RPCs. */
import { Schema } from 'effect'

const UnknownFields = Schema.Record(Schema.String, Schema.Unknown)
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ProcessStopResponseSchema = Schema.StructWithRest(Schema.Struct({ killed: NonNegativeInt }), [
  UnknownFields
])
export type ProcessStopResponse = typeof ProcessStopResponseSchema.Type

export const decodeProcessStopResponse = Schema.decodeUnknownOption(ProcessStopResponseSchema)

const optNull = <S extends Schema.Top>(s: S) => Schema.optionalKey(Schema.NullOr(s))

/** One `process.list` row (`ProcessEntry` in the generated contract): the
 * session-scoped `terminal(background=true)` processes behind the dock block. */
export const ProcessEntrySchema = Schema.StructWithRest(
  Schema.Struct({
    session_id: Schema.String,
    command: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Schema.String),
    uptime_seconds: optNull(Schema.Number),
    exit_code: optNull(Schema.Number),
    exited_at: optNull(Schema.Number),
    completion_reason: optNull(Schema.String),
    output_preview: Schema.optionalKey(Schema.String)
  }),
  [UnknownFields]
)
export type ProcessEntry = typeof ProcessEntrySchema.Type

export const ProcessListResponseSchema = Schema.StructWithRest(
  Schema.Struct({ processes: Schema.optionalKey(Schema.Array(ProcessEntrySchema)) }),
  [UnknownFields]
)
export const decodeProcessListResponse = Schema.decodeUnknownOption(ProcessListResponseSchema)
