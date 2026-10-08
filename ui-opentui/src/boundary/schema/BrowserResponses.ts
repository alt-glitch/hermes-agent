/** Effect 4 decode boundary for the browser.manage control plane. */
import { Option, Schema } from 'effect'

const BrowserManageResponseSchema = Schema.Struct({
  /** Browser Use CLI mode for the session's profile (status/use replies). */
  browser_use: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  connected: Schema.Boolean,
  messages: Schema.optionalKey(Schema.Array(Schema.String)),
  url: Schema.optionalKey(Schema.String)
})

export type BrowserManageResponse = typeof BrowserManageResponseSchema.Type

const decode = Schema.decodeUnknownOption(BrowserManageResponseSchema)

export function decodeBrowserManageResponse(value: unknown): BrowserManageResponse | undefined {
  const result = decode(value)
  return Option.isSome(result) ? result.value : undefined
}
