// Session-info patches and startup catalogs cross the shared Python boundary.
// Invalid payloads leave existing state intact; optional telemetry is recovered
// field-by-field so one bad metric does not discard valid session identity.
import { Effect, Option, Schema } from 'effect'

const Str = Schema.String
const Num = Schema.Number
const Bool = Schema.Boolean
const opt = Schema.optionalKey
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

// A malformed telemetry field is omitted without discarding valid session info.
const OptionalMetric = opt(Schema.Finite).pipe(Schema.catchDecoding(() => Effect.succeed(Option.none())))
const TelemetryFields = {
  avg_latency_s: OptionalMetric,
  avg_tps: OptionalMetric,
  cache_hit_pct: OptionalMetric
}

// ── session.info / session.create.info ────────────────────────────────
// Context/usage numbers arrive nested under `usage`; the same names may also
// appear at the top level depending on the RPC vs event path (the reader prefers
// `usage.context_*`, then the top-level fallback). All keys are optional — a
// `session.info` patch only carries the fields that actually changed.
const UsageSchema = Schema.Struct({
  ...TelemetryFields,
  active_subagents: opt(NonNegativeInt),
  context_used: opt(Num),
  context_max: opt(Num),
  context_percent: opt(Num),
  compressions: opt(Num),
  cost_usd: opt(Num)
})

const ProjectInfoSchema = Schema.Struct({
  id: Str,
  name: Str,
  primary_path: opt(Schema.NullOr(Str)),
  slug: Str
})

export const SessionInfoPatchSchema = Schema.Struct({
  ...TelemetryFields,
  model: opt(Str),
  reasoning_effort: opt(Str),
  fast: opt(Bool),
  // inference provider backing the active model (e.g. "openrouter", "anthropic")
  // — round-tripped from the merged server's session.info; compat-only, no UI.
  provider: opt(Str),
  cwd: opt(Str),
  branch: opt(Str),
  project: opt(Schema.NullOr(ProjectInfoSchema)),
  // session title ("" until the first exchange titles it) — drives the
  // terminal window-title chrome (OSC 0/2 via renderer.setTerminalTitle).
  title: opt(Str),
  running: opt(Bool),
  // status-bar chrome extras (Epic 1.3): update banner, profile badge, MCP count.
  // `update_behind` is null on the wire until the async update check resolves.
  update_behind: opt(Schema.NullOr(Num)),
  update_command: opt(Str),
  profile_name: opt(Str),
  mcp_servers: opt(Schema.Array(Schema.Unknown)),
  // Compatibility fallback for RPC paths that flatten usage fields. The
  // canonical gateway path is `usage.active_subagents`.
  active_subagents: opt(NonNegativeInt),
  // top-level context fallback (used when there's no nested `usage`)
  context_used: opt(Num),
  context_max: opt(Num),
  context_percent: opt(Num),
  compressions: opt(Num),
  usage: opt(UsageSchema)
})
export type SessionInfoPatchDecoded = typeof SessionInfoPatchSchema.Type

/** Decode a loose session.info payload → `Option<SessionInfoPatchDecoded>`. */
export const decodeSessionInfoPatch = Schema.decodeUnknownOption(SessionInfoPatchSchema)

// ── startup.catalog ───────────────────────────────────────────────────
// Mirrors the `Catalog` interface in store.ts. `enabled` defaults to true at the
// reader (an absent flag means on), so it stays optional here.
const ToolsetSchema = Schema.Struct({
  name: opt(Str),
  count: opt(Num),
  enabled: opt(Bool),
  tools: opt(Schema.Array(Schema.Unknown))
})
const CategorySchema = Schema.Struct({
  name: opt(Str),
  count: opt(Num)
})
const CatalogReadinessSchema = Schema.Struct({
  status: opt(Schema.Literals(['ready', 'pending', 'failed'])),
  warning: opt(Str),
  retry_after_ms: opt(Num)
})

export const CatalogSchema = Schema.Struct({
  tools: opt(
    Schema.Struct({
      total: opt(Num),
      toolsets: opt(Schema.Array(ToolsetSchema))
    })
  ),
  skills: opt(
    Schema.Struct({
      total: opt(Num),
      categories: opt(Schema.Array(CategorySchema))
    })
  ),
  mcp: opt(
    Schema.Struct({
      servers: opt(Schema.Array(Schema.Unknown))
    })
  ),
  readiness: opt(CatalogReadinessSchema)
})
export type CatalogDecoded = typeof CatalogSchema.Type

/** Decode a loose startup.catalog result → `Option<CatalogDecoded>`. */
export const decodeCatalog = Schema.decodeUnknownOption(CatalogSchema)
