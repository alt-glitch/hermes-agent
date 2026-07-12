import { Option, Schema } from 'effect'

const Str = Schema.String
const Num = Schema.Number
const opt = Schema.optionalKey
const UnknownFields = Schema.Record(Str, Schema.Unknown)
const JourneyNodeSchema = Schema.StructWithRest(
  Schema.Struct({
    body: opt(Str),
    fullLabel: opt(Str),
    glyph: Str,
    id: Str,
    label: Str,
    meta: Str,
    style: Str
  }),
  [UnknownFields]
)
const JourneyBucketSchema = Schema.StructWithRest(
  Schema.Struct({
    category: opt(Schema.NullOr(Str)),
    color: opt(Schema.NullOr(Str)),
    date: Str,
    index: Num,
    label: Str,
    memories: Num,
    nodes: Schema.Array(JourneyNodeSchema),
    skills: Num
  }),
  [UnknownFields]
)
export const JourneyFramesSchema = Schema.StructWithRest(
  Schema.Struct({
    axis: Schema.Struct({ end: Str, start: Str }),
    buckets: opt(Schema.Array(JourneyBucketSchema)),
    count: Num,
    frames: Schema.Array(Schema.Unknown),
    legend: Schema.Array(Schema.Unknown),
    summary: Schema.Array(Str)
  }),
  [UnknownFields]
)
export const JourneyDetailSchema = Schema.StructWithRest(
  Schema.Struct({
    content: opt(Str),
    kind: opt(Str),
    message: Str,
    ok: Schema.Boolean
  }),
  [UnknownFields]
)
export const JourneyMutationSchema = Schema.StructWithRest(Schema.Struct({ message: Str, ok: Schema.Boolean }), [
  UnknownFields
])
export type JourneyFrames = typeof JourneyFramesSchema.Type
export type JourneyDetail = typeof JourneyDetailSchema.Type
export type JourneyMutation = typeof JourneyMutationSchema.Type
const frames = Schema.decodeUnknownOption(JourneyFramesSchema)
const detail = Schema.decodeUnknownOption(JourneyDetailSchema)
const mutation = Schema.decodeUnknownOption(JourneyMutationSchema)
const some = <A>(value: Option.Option<A>): A | undefined => (Option.isSome(value) ? value.value : undefined)
export const decodeJourneyFrames = (value: unknown): JourneyFrames | undefined => some(frames(value))
export const decodeJourneyDetail = (value: unknown): JourneyDetail | undefined => some(detail(value))
export const decodeJourneyMutation = (value: unknown): JourneyMutation | undefined => some(mutation(value))
