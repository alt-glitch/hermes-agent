/** Effect 4 decode boundaries for image/setup RPCs used by external input. */
import { Option, Schema } from 'effect'

const ImageAttachResponseSchema = Schema.Struct({
  attached: Schema.optionalKey(Schema.Boolean),
  count: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
  name: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  remainder: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  token_estimate: Schema.optionalKey(Schema.Number),
  width: Schema.optionalKey(Schema.Number)
})

const SetupStatusResponseSchema = Schema.Struct({
  provider_configured: Schema.optionalKey(Schema.Boolean)
})

export type ImageAttachResponse = typeof ImageAttachResponseSchema.Type
export type SetupStatusResponse = typeof SetupStatusResponseSchema.Type

const decodeImageAttach = Schema.decodeUnknownOption(ImageAttachResponseSchema)
const decodeSetupStatus = Schema.decodeUnknownOption(SetupStatusResponseSchema)

export function decodeImageAttachResponse(value: unknown): ImageAttachResponse | undefined {
  const result = decodeImageAttach(value)
  return Option.isSome(result) ? result.value : undefined
}

export function decodeSetupStatusResponse(value: unknown): SetupStatusResponse | undefined {
  const result = decodeSetupStatus(value)
  return Option.isSome(result) ? result.value : undefined
}

const COMPACT_NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, notation: 'compact' })
const compactNumber = (value: number): string =>
  COMPACT_NUMBER.format(value).replace(/[KMBT]$/, suffix => suffix.toLowerCase())

/** Exact Ink image-attachment notice, including best-effort wire metadata. */
export function attachedImageNotice(info?: ImageAttachResponse): string {
  const dimensions = info?.width && info.height ? `${String(info.width)}x${String(info.height)}` : ''
  const tokens = (info?.token_estimate ?? 0) > 0 ? `~${compactNumber(info?.token_estimate ?? 0)} tok` : ''
  const meta = [dimensions, tokens].filter(Boolean).join(' · ')
  const label = info?.name ? `📎 Attached image: ${info.name}` : '📎 Attached image'

  return `${label}${meta ? ` · ${meta}` : ''}`
}
