/**
 * Effect 4 decode boundaries for the Agents/delegation RPC family.
 *
 * These schemas describe the JSON-RPC `result` payload (the transport already
 * unwraps `_ok(...)`). They are grounded in `tui_gateway/server.py` and
 * `tools/delegate_tool.py`, not the older optional-only Ink interfaces.
 *
 * Every externally supplied object uses `StructWithRest(..., Record(String,
 * Unknown))`: known fields are typed and validated, while additive fields from
 * a newer gateway survive decoding for replay/diff/detail views. Types are
 * inferred from the schemas; there is no second hand-maintained interface.
 */
import { Schema } from 'effect'

const Str = Schema.String
const Num = Schema.Number
const Bool = Schema.Boolean
const opt = Schema.optionalKey
const UnknownFields = Schema.Record(Str, Schema.Unknown)
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

// ── Rich subagent records ────────────────────────────────────────────

/** One tool-result preview persisted in a rich spawn-tree record. */
export const SpawnTreeOutputEntrySchema = Schema.StructWithRest(
  Schema.Struct({
    is_error: opt(Bool),
    preview: opt(Str),
    tool: opt(Str)
  }),
  [UnknownFields]
)
export type SpawnTreeOutputEntry = typeof SpawnTreeOutputEntrySchema.Type

/**
 * The gateway's canonical snake_case subagent shape. All known fields are
 * optional because `spawn_tree.load` reads cross-version user-owned JSON and
 * existing Ink snapshots contain camelCase aliases. The rest index signature
 * preserves those aliases and future metrics instead of stripping them.
 */
export const SpawnTreeSubagentSchema = Schema.StructWithRest(
  Schema.Struct({
    api_calls: opt(NonNegativeInt),
    child_session_id: opt(Str),
    cost_usd: opt(Num),
    depth: opt(NonNegativeInt),
    duration_seconds: opt(Num),
    files_read: opt(Schema.Array(Str)),
    files_written: opt(Schema.Array(Str)),
    goal: opt(Str),
    input_tokens: opt(NonNegativeInt),
    last_tool: opt(Str),
    iteration: opt(NonNegativeInt),
    model: opt(Schema.NullOr(Str)),
    notes: opt(Schema.Array(Str)),
    output_tail: opt(Schema.Array(SpawnTreeOutputEntrySchema)),
    output_tokens: opt(NonNegativeInt),
    parent_id: opt(Schema.NullOr(Str)),
    reasoning_tokens: opt(NonNegativeInt),
    started_at: opt(Num),
    status: opt(Str),
    subagent_id: opt(Str),
    summary: opt(Str),
    task_count: opt(PositiveInt),
    task_index: opt(NonNegativeInt),
    text: opt(Str),
    thinking: opt(Schema.Array(Str)),
    tool_count: opt(NonNegativeInt),
    tool_name: opt(Str),
    tool_preview: opt(Str),
    tools: opt(Schema.Array(Str)),
    toolsets: opt(Schema.Array(Str))
  }),
  [UnknownFields]
)
export type SpawnTreeSubagent = typeof SpawnTreeSubagentSchema.Type

// ── delegation.status / delegation.pause ─────────────────────────────

/** Exact projection returned by `list_active_subagents()`. */
export const ActiveDelegationSubagentSchema = Schema.StructWithRest(
  Schema.Struct({
    depth: NonNegativeInt,
    goal: Str,
    last_tool: opt(Str),
    model: Schema.NullOr(Str),
    parent_id: Schema.NullOr(Str),
    started_at: Num,
    status: Str,
    subagent_id: Str,
    tool_count: NonNegativeInt
  }),
  [UnknownFields]
)
export type ActiveDelegationSubagent = typeof ActiveDelegationSubagentSchema.Type

export const DelegationStatusResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    active: Schema.Array(ActiveDelegationSubagentSchema),
    max_concurrent_children: PositiveInt,
    max_spawn_depth: PositiveInt,
    paused: Bool
  }),
  [UnknownFields]
)
export type DelegationStatusResponse = typeof DelegationStatusResponseSchema.Type

export const DelegationPauseRequestSchema = Schema.StructWithRest(Schema.Struct({ paused: Bool }), [UnknownFields])
export type DelegationPauseRequest = typeof DelegationPauseRequestSchema.Type

export const DelegationPauseResponseSchema = Schema.StructWithRest(Schema.Struct({ paused: Bool }), [UnknownFields])
export type DelegationPauseResponse = typeof DelegationPauseResponseSchema.Type

// ── subagent.interrupt ────────────────────────────────────────────────

export const SubagentInterruptRequestSchema = Schema.StructWithRest(
  Schema.Struct({ subagent_id: Schema.NonEmptyString }),
  [UnknownFields]
)
export type SubagentInterruptRequest = typeof SubagentInterruptRequestSchema.Type

export const SubagentInterruptResponseSchema = Schema.StructWithRest(Schema.Struct({ found: Bool, subagent_id: Str }), [
  UnknownFields
])
export type SubagentInterruptResponse = typeof SubagentInterruptResponseSchema.Type

// ── spawn_tree.save ───────────────────────────────────────────────────

export const SpawnTreeSaveRequestSchema = Schema.StructWithRest(
  Schema.Struct({
    finished_at: opt(Num),
    label: opt(Str),
    session_id: opt(Str),
    started_at: opt(Schema.NullOr(Num)),
    subagents: Schema.Array(SpawnTreeSubagentSchema).check(Schema.isMinLength(1))
  }),
  [UnknownFields]
)
export type SpawnTreeSaveRequest = typeof SpawnTreeSaveRequestSchema.Type

export const SpawnTreeSaveResponseSchema = Schema.StructWithRest(Schema.Struct({ path: Str, session_id: Str }), [
  UnknownFields
])
export type SpawnTreeSaveResponse = typeof SpawnTreeSaveResponseSchema.Type

// ── spawn_tree.list ───────────────────────────────────────────────────

export const SpawnTreeListRequestSchema = Schema.StructWithRest(
  Schema.Struct({
    cross_session: opt(Bool),
    limit: opt(PositiveInt),
    session_id: opt(Str)
  }),
  [UnknownFields]
)
export type SpawnTreeListRequest = typeof SpawnTreeListRequestSchema.Type

export const SpawnTreeListEntrySchema = Schema.StructWithRest(
  Schema.Struct({
    count: NonNegativeInt,
    finished_at: opt(Num),
    label: opt(Str),
    path: Str,
    session_id: opt(Str),
    started_at: opt(Schema.NullOr(Num))
  }),
  [UnknownFields]
)
export type SpawnTreeListEntry = typeof SpawnTreeListEntrySchema.Type

export const SpawnTreeListResponseSchema = Schema.StructWithRest(
  Schema.Struct({ entries: Schema.Array(SpawnTreeListEntrySchema) }),
  [UnknownFields]
)
export type SpawnTreeListResponse = typeof SpawnTreeListResponseSchema.Type

// ── spawn_tree.load ───────────────────────────────────────────────────

export const SpawnTreeLoadRequestSchema = Schema.StructWithRest(Schema.Struct({ path: Schema.NonEmptyString }), [
  UnknownFields
])
export type SpawnTreeLoadRequest = typeof SpawnTreeLoadRequestSchema.Type

export const SpawnTreeLoadResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    finished_at: opt(Num),
    label: opt(Str),
    session_id: opt(Str),
    started_at: opt(Schema.NullOr(Num)),
    subagents: Schema.Array(SpawnTreeSubagentSchema)
  }),
  [UnknownFields]
)
export type SpawnTreeLoadResponse = typeof SpawnTreeLoadResponseSchema.Type

// ── usage.active_subagents ────────────────────────────────────────────

/**
 * `_get_usage()` may omit this field only when importing the async-delegation
 * registry fails. It counts background (`delegate_task(background=true)`)
 * runs, which is a different population from `delegation.status.active`.
 */
export const UsageActiveSubagentsSchema = Schema.StructWithRest(
  Schema.Struct({ active_subagents: opt(NonNegativeInt) }),
  [UnknownFields]
)
export type UsageActiveSubagents = typeof UsageActiveSubagentsSchema.Type

// Build each decoder once. Callers pass untrusted RPC/event payloads here and
// carry only the decoded value into Solid state/domain logic.
export const decodeDelegationStatusResponse = Schema.decodeUnknownOption(DelegationStatusResponseSchema)
export const decodeDelegationPauseRequest = Schema.decodeUnknownOption(DelegationPauseRequestSchema)
export const decodeDelegationPauseResponse = Schema.decodeUnknownOption(DelegationPauseResponseSchema)
export const decodeSubagentInterruptRequest = Schema.decodeUnknownOption(SubagentInterruptRequestSchema)
export const decodeSubagentInterruptResponse = Schema.decodeUnknownOption(SubagentInterruptResponseSchema)
export const decodeSpawnTreeSaveRequest = Schema.decodeUnknownOption(SpawnTreeSaveRequestSchema)
export const decodeSpawnTreeSaveResponse = Schema.decodeUnknownOption(SpawnTreeSaveResponseSchema)
export const decodeSpawnTreeListRequest = Schema.decodeUnknownOption(SpawnTreeListRequestSchema)
export const decodeSpawnTreeListResponse = Schema.decodeUnknownOption(SpawnTreeListResponseSchema)
export const decodeSpawnTreeLoadRequest = Schema.decodeUnknownOption(SpawnTreeLoadRequestSchema)
export const decodeSpawnTreeLoadResponse = Schema.decodeUnknownOption(SpawnTreeLoadResponseSchema)
export const decodeUsageActiveSubagents = Schema.decodeUnknownOption(UsageActiveSubagentsSchema)
