/** Effect 4 decode boundary for the interactive Plugins Hub. */
import { Option, Schema } from 'effect'

const Str = Schema.String
const opt = Schema.optionalKey
const UnknownFields = Schema.Record(Str, Schema.Unknown)

export const PluginRowSchema = Schema.StructWithRest(
  Schema.Struct({
    description: opt(Str),
    key: opt(Str),
    name: Str,
    portable: opt(Schema.Boolean),
    source: opt(Str),
    status: opt(Str),
    version: opt(Str)
  }),
  [UnknownFields]
)

export const PluginsListResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    bundled_count: opt(Schema.Number),
    plugins: opt(Schema.Array(PluginRowSchema)),
    user_count: opt(Schema.Number)
  }),
  [UnknownFields]
)

export const PluginsToggleResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    name: opt(Str),
    ok: opt(Schema.Boolean),
    plugin: opt(PluginRowSchema),
    unchanged: opt(Schema.Boolean)
  }),
  [UnknownFields]
)

export type PluginRow = typeof PluginRowSchema.Type
export type PluginsListResponse = typeof PluginsListResponseSchema.Type
export type PluginsToggleResponse = typeof PluginsToggleResponseSchema.Type

const decodeList = Schema.decodeUnknownOption(PluginsListResponseSchema)
const decodeToggle = Schema.decodeUnknownOption(PluginsToggleResponseSchema)

function some<A>(value: Option.Option<A>): A | undefined {
  return Option.isSome(value) ? value.value : undefined
}

export const decodePluginsListResponse = (value: unknown): PluginsListResponse | undefined => some(decodeList(value))
export const decodePluginsToggleResponse = (value: unknown): PluginsToggleResponse | undefined =>
  some(decodeToggle(value))
