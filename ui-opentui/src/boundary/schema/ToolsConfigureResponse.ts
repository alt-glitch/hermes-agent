/** Effect 4 decode boundary for `tools.configure` RPC results. */
import { Option, Schema } from 'effect'

const Str = Schema.String
const opt = Schema.optionalKey
const Strings = Schema.Array(Str)

export const ToolsConfigureResponseSchema = Schema.Struct({
  changed: opt(Strings),
  enabled_toolsets: opt(Strings),
  // The gateway returns JSON null when configuration changed but the requested
  // SID is no longer live. That is a successful no-reset response, not a decode
  // failure; Ink treats it as falsy and still presents changed/unknown rows.
  info: opt(Schema.NullOr(Schema.Record(Str, Schema.Unknown))),
  missing_servers: opt(Strings),
  reset: opt(Schema.Boolean),
  unknown: opt(Strings)
})

export type ToolsConfigureResponse = typeof ToolsConfigureResponseSchema.Type

const decode = Schema.decodeUnknownOption(ToolsConfigureResponseSchema)

/** Malformed gateway responses fail closed instead of being cast into UI state. */
export function decodeToolsConfigureResponse(value: unknown): ToolsConfigureResponse | undefined {
  const result = decode(value)
  return Option.isSome(result) ? result.value : undefined
}
