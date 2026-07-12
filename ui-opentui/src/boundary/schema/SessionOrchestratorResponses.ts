/** Effect 4 decode boundaries for the unified live-session orchestrator RPCs. */
import { Option, Schema } from 'effect'

const Str = Schema.String
const Num = Schema.Number
const Bool = Schema.Boolean
const opt = Schema.optionalKey
const UnknownFields = Schema.Record(Str, Schema.Unknown)

export const LiveSessionStatusSchema = Schema.Literals(['idle', 'starting', 'waiting', 'working', 'streaming'])
export type LiveSessionStatus = typeof LiveSessionStatusSchema.Type

export const ActiveItemSchema = Schema.StructWithRest(
  Schema.Struct({
    current: opt(Bool),
    id: Str,
    last_active: opt(Num),
    message_count: opt(Num),
    model: opt(Str),
    preview: opt(Str),
    session_key: opt(Str),
    started_at: opt(Num),
    status: LiveSessionStatusSchema,
    title: opt(Str)
  }),
  [UnknownFields]
)
export type ActiveItem = typeof ActiveItemSchema.Type

export const SessionActiveListResponseSchema = Schema.StructWithRest(
  Schema.Struct({ sessions: opt(Schema.Array(ActiveItemSchema)) }),
  [UnknownFields]
)
export type SessionActiveListResponse = typeof SessionActiveListResponseSchema.Type

export const SessionInflightSchema = Schema.StructWithRest(
  Schema.Struct({
    assistant: opt(Str),
    streaming: opt(Bool),
    user: opt(Str)
  }),
  [UnknownFields]
)
export type SessionInflight = typeof SessionInflightSchema.Type

/** Shared snapshot returned by both session.activate and session.resume. */
export const LiveSessionSnapshotSchema = Schema.StructWithRest(
  Schema.Struct({
    inflight: opt(Schema.NullOr(SessionInflightSchema)),
    info: opt(Schema.Record(Str, Schema.Unknown)),
    message_count: opt(Num),
    messages: Schema.Array(Schema.Unknown),
    resumed: opt(Str),
    running: opt(Bool),
    session_id: Str,
    session_key: opt(Str),
    started_at: opt(Num),
    status: opt(LiveSessionStatusSchema)
  }),
  [UnknownFields]
)
export type LiveSessionSnapshot = typeof LiveSessionSnapshotSchema.Type

export const SessionActivateResponseSchema = LiveSessionSnapshotSchema
export type SessionActivateResponse = LiveSessionSnapshot

export const SessionResumeResponseSchema = LiveSessionSnapshotSchema
export type SessionResumeResponse = LiveSessionSnapshot

export const SessionCloseResponseSchema = Schema.StructWithRest(Schema.Struct({ closed: opt(Bool), ok: opt(Bool) }), [
  UnknownFields
])
export type SessionCloseResponse = typeof SessionCloseResponseSchema.Type

export const SessionDeleteResponseSchema = Schema.StructWithRest(Schema.Struct({ deleted: Str }), [UnknownFields])
export type SessionDeleteResponse = typeof SessionDeleteResponseSchema.Type

export const SessionListItemSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Str,
    message_count: Num,
    preview: Str,
    source: opt(Str),
    started_at: Num,
    title: Str
  }),
  [UnknownFields]
)
export type SessionListItem = typeof SessionListItemSchema.Type

export const SessionListResponseSchema = Schema.StructWithRest(
  Schema.Struct({ sessions: opt(Schema.Array(SessionListItemSchema)) }),
  [UnknownFields]
)
export type SessionListResponse = typeof SessionListResponseSchema.Type

const decodeActiveList = Schema.decodeUnknownOption(SessionActiveListResponseSchema)
const decodeLiveSnapshot = Schema.decodeUnknownOption(LiveSessionSnapshotSchema)
const decodeClose = Schema.decodeUnknownOption(SessionCloseResponseSchema)
const decodeDelete = Schema.decodeUnknownOption(SessionDeleteResponseSchema)
const decodeList = Schema.decodeUnknownOption(SessionListResponseSchema)

function some<A>(value: Option.Option<A>): A | undefined {
  return Option.isSome(value) ? value.value : undefined
}

function nonblank(value: string): boolean {
  return value.trim().length > 0
}

export const decodeSessionActiveListResponse = (value: unknown): SessionActiveListResponse | undefined => {
  const decoded = some(decodeActiveList(value))
  if (!decoded || decoded.sessions?.some(item => !nonblank(item.id))) return undefined
  return decoded
}

export const decodeSessionActivateResponse = (value: unknown): SessionActivateResponse | undefined =>
  some(decodeLiveSnapshot(value))

export const decodeSessionResumeResponse = (value: unknown): SessionResumeResponse | undefined =>
  some(decodeLiveSnapshot(value))

export const decodeSessionCloseResponse = (value: unknown): SessionCloseResponse | undefined => {
  const decoded = some(decodeClose(value))
  // Both fields are optional on the wire for compatibility with old gateways,
  // but a response with neither is not an acknowledgement and must not drive
  // routing teardown in liveGateway.
  if (!decoded || (decoded.closed === undefined && decoded.ok === undefined)) return undefined
  return decoded
}

export const decodeSessionDeleteResponse = (value: unknown): SessionDeleteResponse | undefined =>
  some(decodeDelete(value))

export const decodeSessionListResponse = (value: unknown): SessionListResponse | undefined => some(decodeList(value))
