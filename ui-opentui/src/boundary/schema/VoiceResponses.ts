/** Effect 4 decode boundaries for exact-f7 voice control RPCs. */
import { Option, Schema } from 'effect'

const Str = Schema.String
const Bool = Schema.Boolean
const opt = Schema.optionalKey
const UnknownFields = Schema.Record(Str, Schema.Unknown)

export const VoiceToggleResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    audio_available: opt(Bool),
    available: opt(Bool),
    details: opt(Str),
    enabled: opt(Bool),
    record_key: opt(Str),
    stt_available: opt(Bool),
    tts: opt(Bool)
  }),
  [UnknownFields]
)
export type VoiceToggleResponse = typeof VoiceToggleResponseSchema.Type

export const VoiceRecordResponseSchema = Schema.StructWithRest(
  Schema.Struct({ status: opt(Schema.Literals(['busy', 'recording', 'stopped'])), text: opt(Str) }),
  [UnknownFields]
)
export type VoiceRecordResponse = typeof VoiceRecordResponseSchema.Type

const decodeToggle = Schema.decodeUnknownOption(VoiceToggleResponseSchema)
const decodeRecord = Schema.decodeUnknownOption(VoiceRecordResponseSchema)

function some<A>(value: Option.Option<A>): A | undefined {
  return Option.isSome(value) ? value.value : undefined
}

export const decodeVoiceToggleResponse = (value: unknown): VoiceToggleResponse | undefined => some(decodeToggle(value))
export const decodeVoiceRecordResponse = (value: unknown): VoiceRecordResponse | undefined => some(decodeRecord(value))
