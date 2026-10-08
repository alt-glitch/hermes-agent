/**
 * The connection operation (`manage_connections` card) wire shapes, decoded once.
 * Source of truth: `tui_gateway/contracts/connectors_operation.py`. Every frame
 * carries the full target snapshot, so the card is a projection and derives no
 * state of its own.
 *
 * `state` is a closed literal union because the card's phases depend on it.
 * `action` and `kind` stay open strings: a verb added upstream renders as a
 * plain label instead of making the whole card undecodable.
 */
import { Schema } from 'effect'

const Str = Schema.String
const Num = Schema.Number
const Bool = Schema.Boolean
const opt = Schema.optionalKey
const nullable = <S extends Schema.Top>(schema: S) => opt(Schema.NullOr(schema))
const UnknownFields = Schema.Record(Str, Schema.Unknown)

export const ConnectionTargetStateSchema = Schema.Literals([
  'pending',
  'initiated',
  'connected',
  'skipped',
  'failed',
  'expired',
  'not_connected'
])
export type ConnectionTargetState = typeof ConnectionTargetStateSchema.Type

export const ConnectionEnvFieldSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Str,
    required: Bool,
    secret: Bool,
    default: Str,
    prompt: nullable(Str)
  }),
  [UnknownFields]
)
export type ConnectionEnvField = typeof ConnectionEnvFieldSchema.Type

export const ConnectionTargetSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Str,
    kind: Str,
    action: Str,
    state: ConnectionTargetStateSchema,
    detail: nullable(Str),
    instructions: nullable(Str),
    discovery_error: nullable(Str),
    connect_url: nullable(Str),
    required_env: nullable(Schema.Array(ConnectionEnvFieldSchema)),
    display: nullable(Str)
  }),
  [UnknownFields]
)
export type ConnectionTarget = typeof ConnectionTargetSchema.Type

export const ConnectionRequestPayloadSchema = Schema.StructWithRest(
  Schema.Struct({
    op_id: Str,
    seq: Num,
    deadline_at: Num,
    timeout_seconds: opt(Num),
    targets: Schema.Array(ConnectionTargetSchema),
    tool_call_id: nullable(Str)
  }),
  [UnknownFields]
)
export type ConnectionRequestPayload = typeof ConnectionRequestPayloadSchema.Type

export const ConnectionUpdatePayloadSchema = Schema.StructWithRest(
  Schema.Struct({
    op_id: Str,
    seq: Num,
    deadline_at: Num,
    settled: Bool,
    targets: Schema.Array(ConnectionTargetSchema)
  }),
  [UnknownFields]
)
export type ConnectionUpdatePayload = typeof ConnectionUpdatePayloadSchema.Type
