/** Effect 4 decode boundaries for the OS background-process control RPCs. */
import { Schema } from 'effect'

const UnknownFields = Schema.Record(Schema.String, Schema.Unknown)
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ProcessStopResponseSchema = Schema.StructWithRest(Schema.Struct({ killed: NonNegativeInt }), [
  UnknownFields
])
export type ProcessStopResponse = typeof ProcessStopResponseSchema.Type

export const decodeProcessStopResponse = Schema.decodeUnknownOption(ProcessStopResponseSchema)
