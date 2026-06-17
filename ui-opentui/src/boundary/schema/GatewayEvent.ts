/**
 * GatewayEvent — the wire event union, modeled as an Effect Schema and decoded
 * ONCE at the transport boundary (spec v4 §3.3). Mirrors Ink's
 * `ui-tui/src/gatewayTypes.ts:509-587` (discriminant = `type`).
 *
 * beta.78 API (verified vs .d.ts): variants are `Schema.Struct` with a
 * `Schema.Literal` `type`, combined with `Schema.Union([...]).pipe(
 * Schema.toTaggedUnion("type"))`. Optional fields use `Schema.optionalKey`
 * (exact-optional under exactOptionalPropertyTypes). Decode unknown wire JSON
 * with `Schema.decodeUnknownOption` so an UNRECOGNIZED `type` yields `Option.none`
 * and is skipped — a stray event never tears down the stream.
 *
 * Types are INFERRED from the schema (`typeof X["Type"]`), never hand-declared.
 */
import { Schema } from 'effect'

const Str = Schema.String
const opt = Schema.optionalKey

// ── Skin (mirror GatewaySkin in ui-tui/src/gatewayTypes.ts) ───────────
export const GatewaySkinSchema = Schema.Struct({
  banner_hero: opt(Str),
  banner_logo: opt(Str),
  branding: opt(Schema.Record(Str, Str)),
  colors: opt(Schema.Record(Str, Str)),
  help_header: opt(Str),
  tool_prefix: opt(Str),
  // Spinner animation data (faces/verbs/wings) — mixed array/tuple shapes, kept
  // loose at the boundary; the spinner component narrows what it reads. tool_emojis
  // is a per-tool glyph override map. Both additive + optional (back-compat).
  spinner: opt(Schema.Record(Str, Schema.Unknown)),
  tool_emojis: opt(Schema.Record(Str, Str))
})
export type GatewaySkinDecoded = typeof GatewaySkinSchema.Type

// ── Variant schemas (one per wire `type`) ─────────────────────────────
// lifecycle
const GatewayReady = Schema.Struct({
  type: Schema.Literal('gateway.ready'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ skin: opt(GatewaySkinSchema) }))
})
const SkinChanged = Schema.Struct({
  type: Schema.Literal('skin.changed'),
  session_id: opt(Str),
  payload: opt(GatewaySkinSchema)
})
const SessionInfoEvent = Schema.Struct({
  type: Schema.Literal('session.info'),
  session_id: opt(Str),
  // SessionInfo is large + evolving; keep it loose at the boundary (Record),
  // the chrome phase narrows the fields it actually reads.
  payload: Schema.Record(Str, Schema.Unknown)
})

// streaming text
const MessageStart = Schema.Struct({ type: Schema.Literal('message.start'), session_id: opt(Str) })
const MessageDelta = Schema.Struct({
  type: Schema.Literal('message.delta'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ text: opt(Str), rendered: opt(Str) }))
})
const MessageComplete = Schema.Struct({
  type: Schema.Literal('message.complete'),
  session_id: opt(Str),
  // `usage` carries the post-turn token/context totals → refreshes the status bar
  // (item 14). Kept loose (Record) — the chrome reader narrows what it needs.
  payload: opt(Schema.Struct({ text: opt(Str), rendered: opt(Str), usage: opt(Schema.Record(Str, Schema.Unknown)) }))
})

// reasoning / thinking — toTaggedUnion needs ONE literal per member, so the
// reasoning.delta/reasoning.available pair is two structs sharing a shape.
const ReasoningShape = {
  session_id: opt(Str),
  payload: opt(Schema.Struct({ text: opt(Str), verbose: opt(Schema.Boolean) }))
}
const ReasoningDelta = Schema.Struct({ type: Schema.Literal('reasoning.delta'), ...ReasoningShape })
const ReasoningAvailable = Schema.Struct({ type: Schema.Literal('reasoning.available'), ...ReasoningShape })
const ThinkingDelta = Schema.Struct({
  type: Schema.Literal('thinking.delta'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ text: opt(Str) }))
})

// tools
const ToolStart = Schema.Struct({
  type: Schema.Literal('tool.start'),
  session_id: opt(Str),
  payload: Schema.Record(Str, Schema.Unknown)
})
const ToolComplete = Schema.Struct({
  type: Schema.Literal('tool.complete'),
  session_id: opt(Str),
  payload: Schema.Record(Str, Schema.Unknown)
})
const ToolProgress = Schema.Struct({
  type: Schema.Literal('tool.progress'),
  session_id: opt(Str),
  payload: Schema.Struct({ name: opt(Str), preview: opt(Str) })
})
const ToolGenerating = Schema.Struct({
  type: Schema.Literal('tool.generating'),
  session_id: opt(Str),
  payload: Schema.Struct({ name: opt(Str) })
})

// blocking prompts (deadlock-critical — Phase 3 renders these)
const ClarifyRequest = Schema.Struct({
  type: Schema.Literal('clarify.request'),
  session_id: opt(Str),
  payload: Schema.Struct({
    choices: opt(Schema.NullOr(Schema.Array(Str))),
    question: opt(Str),
    request_id: Str
  })
})
const ApprovalRequest = Schema.Struct({
  type: Schema.Literal('approval.request'),
  session_id: opt(Str),
  payload: Schema.Struct({ command: Str, description: Str })
})
const SudoRequest = Schema.Struct({
  type: Schema.Literal('sudo.request'),
  session_id: opt(Str),
  payload: Schema.Struct({ request_id: Str })
})
const SecretRequest = Schema.Struct({
  type: Schema.Literal('secret.request'),
  session_id: opt(Str),
  payload: Schema.Struct({ env_var: Str, prompt: Str, request_id: Str })
})

// chrome / agent
const StatusUpdate = Schema.Struct({
  type: Schema.Literal('status.update'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ kind: opt(Str), text: opt(Str) }))
})
const NotificationShow = Schema.Struct({
  type: Schema.Literal('notification.show'),
  session_id: opt(Str),
  payload: Schema.Record(Str, Schema.Unknown)
})
const NotificationClear = Schema.Struct({
  type: Schema.Literal('notification.clear'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ key: opt(Str) }))
})
const VoiceStatus = Schema.Struct({
  type: Schema.Literal('voice.status'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ state: opt(Schema.Literals(['idle', 'listening', 'transcribing'])) }))
})
const VoiceTranscript = Schema.Struct({
  type: Schema.Literal('voice.transcript'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ no_speech_limit: opt(Schema.Boolean), text: opt(Str) }))
})
const BrowserProgress = Schema.Struct({
  type: Schema.Literal('browser.progress'),
  session_id: opt(Str),
  payload: Schema.Record(Str, Schema.Unknown)
})
const BackgroundComplete = Schema.Struct({
  type: Schema.Literal('background.complete'),
  session_id: opt(Str),
  payload: Schema.Struct({ task_id: Str, text: Str })
})
const ReviewSummary = Schema.Struct({
  type: Schema.Literal('review.summary'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ text: opt(Str) }))
})
const SubagentShape = { session_id: opt(Str), payload: Schema.Record(Str, Schema.Unknown) }
const SubagentSpawnRequested = Schema.Struct({ type: Schema.Literal('subagent.spawn_requested'), ...SubagentShape })
const SubagentStart = Schema.Struct({ type: Schema.Literal('subagent.start'), ...SubagentShape })
const SubagentThinking = Schema.Struct({ type: Schema.Literal('subagent.thinking'), ...SubagentShape })
const SubagentTool = Schema.Struct({ type: Schema.Literal('subagent.tool'), ...SubagentShape })
const SubagentProgress = Schema.Struct({ type: Schema.Literal('subagent.progress'), ...SubagentShape })
const SubagentComplete = Schema.Struct({ type: Schema.Literal('subagent.complete'), ...SubagentShape })
// Per-token streamed reply text from a subagent. The server mirrors this once per
// token, so the store COALESCES consecutive frames into one growing trace line
// (see store.ts reducer) rather than one line per token.
const SubagentText = Schema.Struct({ type: Schema.Literal('subagent.text'), ...SubagentShape })

// transport errors
const ErrorEvent = Schema.Struct({
  type: Schema.Literal('error'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ message: opt(Str) }))
})
const GatewayStderr = Schema.Struct({
  type: Schema.Literal('gateway.stderr'),
  session_id: opt(Str),
  payload: Schema.Struct({ line: Str })
})
const GatewayStartTimeout = Schema.Struct({
  type: Schema.Literal('gateway.start_timeout'),
  session_id: opt(Str),
  payload: Schema.Record(Str, Schema.Unknown)
})
const GatewayProtocolError = Schema.Struct({
  type: Schema.Literal('gateway.protocol_error'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ preview: opt(Str) }))
})
// gateway lifecycle recovery (auto-heal): the child exited (crash/kill) and the
// transport is respawning+resuming the session. Surfaced so the frozen spinner
// clears and the user sees the in-flight reply was lost (see store cases).
const GatewayExited = Schema.Struct({
  type: Schema.Literal('gateway.exited'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ reason: opt(Str), code: opt(Schema.Number), signal: opt(Str) }))
})
const GatewayRecovering = Schema.Struct({
  type: Schema.Literal('gateway.recovering'),
  session_id: opt(Str),
  payload: opt(Schema.Struct({ attempt: opt(Schema.Number), delay_ms: opt(Schema.Number) }))
})

// ── The union ─────────────────────────────────────────────────────────
export const GatewayEventSchema = Schema.Union([
  GatewayReady,
  SkinChanged,
  SessionInfoEvent,
  MessageStart,
  MessageDelta,
  MessageComplete,
  ReasoningDelta,
  ReasoningAvailable,
  ThinkingDelta,
  ToolStart,
  ToolComplete,
  ToolProgress,
  ToolGenerating,
  ClarifyRequest,
  ApprovalRequest,
  SudoRequest,
  SecretRequest,
  StatusUpdate,
  NotificationShow,
  NotificationClear,
  VoiceStatus,
  VoiceTranscript,
  BrowserProgress,
  BackgroundComplete,
  ReviewSummary,
  SubagentSpawnRequested,
  SubagentStart,
  SubagentThinking,
  SubagentTool,
  SubagentProgress,
  SubagentComplete,
  SubagentText,
  ErrorEvent,
  GatewayStderr,
  GatewayStartTimeout,
  GatewayProtocolError,
  GatewayExited,
  GatewayRecovering
]).pipe(Schema.toTaggedUnion('type'))

/** The decoded, typed event. Inferred from the schema — never hand-declared. */
export type GatewayEvent = typeof GatewayEventSchema.Type
