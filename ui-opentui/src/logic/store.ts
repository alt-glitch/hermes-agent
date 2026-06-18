/**
 * Session/message store — the SOLID side (spec v4 §1, §7). Plain `createStore`
 * + an `apply(event)` reducer, à la opencode `context/sync-v2.tsx`. NOT Effect.
 * The boundary calls `apply` with already-decoded `GatewayEvent`s via
 * GatewayService.subscribe.
 *
 * Phase 2b: an assistant turn is ONE ordered `parts[]` of a discriminated union
 * (text / reasoning / tool), so tool calls render INLINE between text blocks
 * instead of dumped as separate rows below (§7 — the "dump-below" bug). Tools are
 * matched start↔complete by `tool_id`; `tool.complete` updates that part IN PLACE.
 * User/system rows stay flat `text` (no parts). Carried from Phase 1: streaming
 * concat (prefer `payload.text`), skin→theme, LRU dedup, hydrate-while-buffering.
 */
import { Option } from 'effect'
import { createStore, produce } from 'solid-js/store'

import type { GatewayEvent, GatewaySkinDecoded } from '../boundary/schema/GatewayEvent.ts'
import {
  decodeCatalog,
  decodeSessionInfoPatch,
  type CatalogDecoded,
  type SessionInfoPatchDecoded
} from '../boundary/schema/SessionInfo.ts'
import type { DetailsMode } from './details.ts'
import { diffStats, type DiffStats } from './diff.ts'
import type { SessionTabId } from './sessionPicker.ts'
import { envFlag, envOutputUnlimited, toolOutputsEnabled } from './env.ts'
import { registerNotifier } from './notify.ts'
import {
  isChromeNotice,
  parseNotification,
  type ActivityNotification,
  type BackgroundProcess
} from './backgroundActivity.ts'
import { stripAnsi, stripOmittedNote, stripToolEnvelope } from './toolOutput.ts'
import { DEFAULT_THEME, type Theme, themeFromSkin } from './theme.ts'

/** A tool call inside an assistant turn (matched start↔complete by `id`=tool_id). */
export interface ToolPartState {
  type: 'tool'
  id: string
  name: string
  state: 'running' | 'complete'
  /** Envelope-stripped output (multi-line → block render; the view caps it). */
  resultText?: string
  /** Short one-line status when there's no substantial output. */
  summary?: string
  error?: string
  lineCount?: number
  /** One-line primary-arg preview from gateway `context` (always sent; redaction-safe). */
  argsPreview?: string
  /** Full args (pretty JSON) for the expanded view — `args_text` (redacted) or stringified `args`. */
  argsText?: string
  /** Structured args from `tool.complete` (always sent) — the per-tool renderers read these. */
  args?: Record<string, unknown>
  /** Structured RESULT object from `tool.complete` (dict results only) — per-tool
   *  renderers extract payload fields (read_file `content`, search `matches`,
   *  clarify Q&A, skill_view name/description). The display string `resultText`
   *  can't serve this: `normalizeOutput` un-escapes literal `\n` inside JSON
   *  string values, so a stringified dict result no longer JSON.parses. Same
   *  raw-result redaction tradeoff as the unlimited-cap substitution above. */
  result?: Record<string, unknown>
  /** Tool wall-clock seconds (gateway `duration_s`), shown dim in the header. */
  duration?: number
  /** Local Date.now() stamped on `tool.start` — drives the live elapsed tick
   *  while running (Epic 2.5). `duration` (gateway truth) wins once settled. */
  startedAt?: number
  /** Tidy note when the gateway truncated output (e.g. "5 lines / 234 chars"). */
  omittedNote?: string
  /** FULL raw unified diff from file-edit tools (gateway `diff_unified`, 512KB-capped). */
  diffUnified?: string
  /** `+N −M` line counts derived from diffUnified (collapsed header summary). */
  diffStats?: DiffStats
}

/** One ordered piece of an assistant turn (§7). */
export type Part =
  | { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  | ToolPartState

export interface Message {
  readonly role: 'user' | 'assistant' | 'system' | 'notification'
  /** Flat body for user/system rows (and settled/resumed assistant rows). */
  text: string
  /** Ordered parts for a live assistant turn; absent for user/system. */
  parts?: Part[]
  streaming?: boolean
  /** Background-activity card payload (role `'notification'` only) — rendered as
   *  an inline NotificationCard instead of a normal role row. */
  notification?: ActivityNotification
}

/**
 * A BLOCKING interactive request from the agent (spec §8 #6 — unhandled = deadlock).
 * Each is answered via the matching `*.respond` RPC; Esc/Ctrl+C sends deny/empty.
 */
export type ActivePrompt =
  | { kind: 'clarify'; question: string; choices: string[] | null; requestId: string }
  | { kind: 'approval'; command: string; description: string }
  | { kind: 'sudo'; requestId: string }
  | { kind: 'secret'; envVar: string; prompt: string; requestId: string }
  // local (non-gateway) Y/N confirm — e.g. /clear, /new (spec §2a)
  | { kind: 'confirm'; message: string; onConfirm: () => void }

/** A full-screen scrollable text viewer (long slash output: /status, /logs, …). */
export interface PagerState {
  title: string
  text: string
}

/** One row in the legacy flat session list (from `session.list`). Kept for
 *  `mapSessionList` (resume.ts); the resume PICKER uses the richer
 *  `SessionRow` (logic/sessionPicker.ts). */
export interface SessionItem {
  id: string
  title: string
  preview: string
  messageCount: number
}

/** The open resume picker overlay (/sessions, /resume, boot `--resume`):
 *  just the pre-selected tab — the overlay fetches its own rows. */
export interface SessionPickerOverlay {
  tab: SessionTabId
}

/** A row in the generic picker overlay (model picker, skills hub, …). */
export interface PickerItem {
  label: string
  description?: string
  value: string
  /** Group header this row renders under (e.g. the provider's display name).
   *  Rows without a group render headerless (flat list). */
  group?: string
  /** Extra fuzzy-search haystacks beyond label/group/description (e.g. the
   *  provider slug, so `oai` finds openai models). */
  haystacks?: string[]
  /** Marks the currently-active row (rendered with a ✓). */
  current?: boolean
  /** Unavailable row (e.g. an unconfigured provider's `no API key — set …`
   *  hint): hidden by default, revealed dimmed + NON-selectable by the
   *  picker's Ctrl+U toggle; ↑↓ traversal skips it (picker v2.1). */
  unavailable?: boolean
}

/** An open generic picker overlay: a titled list whose pick runs `onPick(value)`. */
export interface PickerState {
  title: string
  items: PickerItem[]
  onPick: (value: string) => void
}

/** A slash-completion candidate (from `complete.slash`). */
export interface CompletionItem {
  text: string
  display: string
  meta: string
}

/** One typed entry in a subagent's activity trace — `kind` drives glyph + color
 *  in the dashboard so the trace reads like a transcript, not flat dumped lines. */
export interface TraceEntry {
  kind: 'start' | 'tool' | 'progress' | 'summary' | 'reply'
  text: string
}

/** A delegated subagent, tracked from the `subagent.*` event stream (agents dashboard). */
export interface SubagentInfo {
  id: string
  goal: string
  status: string
  depth: number
  model?: string
  parentId?: string
  summary?: string
  lastTool?: string
  /** Live activity trace (item 15) — typed entries, newest last; rendered by kind. */
  trace?: TraceEntry[]
  /** Latest thinking text (transient; not appended to the trace to avoid flooding). */
  thought?: string
}

/** Cap on a subagent's retained trace lines. */
const SUBAGENT_TRACE_LIMIT = 200

/**
 * Live session chrome (the status bar — item 14). Sourced from the `session.info`
 * event (and the `session.create`/`resume` result's `info`), refreshed whenever
 * the gateway's agent/config state changes. `running` is the turn-active flag the
 * Ctrl-C interrupt (item 11) reads; we also flip it locally on message.start/
 * complete so the bar reacts instantly even if a `session.info` lags.
 */
/** Todo task states (mirrors tools/todo_tool.py). */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** One todo item (content + state); list ORDER is priority — never re-sort. */
export interface TodoItem {
  content: string
  status: TodoStatus
}

/** Counts by state for the panel header + status-bar chip. */
export interface TodoCounts {
  total: number
  completed: number
  in_progress: number
  pending: number
  cancelled: number
}

/** The pinned TodoPanel's live source: the latest todo-tool snapshot. */
export interface TodoSnapshot {
  todos: TodoItem[]
  counts: TodoCounts
}

export interface SessionInfo {
  model?: string
  effort?: string
  fast?: boolean
  /** Inference provider backing the active model (`provider`) — round-tripped
   *  from the merged server's session.info; compat-only, no chrome consumes it yet. */
  provider?: string
  cwd?: string
  branch?: string
  /** Session title (auto-titled after the first exchange / renamed via the
   *  picker) — drives the terminal window-title chrome; unset until titled. */
  title?: string
  running?: boolean
  contextUsed?: number
  contextMax?: number
  contextPercent?: number
  compressions?: number
  /** Estimated session cost in USD (`usage.cost_usd` — only when the gateway's
   *  pricing estimate succeeds; absent otherwise). */
  costUsd?: number
  /** Commits behind the remote (`update_behind`) — null/absent until the async
   *  update check resolves; >0 drives the transient update notice in the bar. */
  updateBehind?: number
  /** The recommended update command (`update_command`), paired with updateBehind. */
  updateCommand?: string
  /** Active profile name (`profile_name`); the bar badges it when non-default. */
  profileName?: string
  /** Count of configured MCP servers (`mcp_servers.length`) for the bar's `N mcp`. */
  mcpServers?: number
  /** Epoch ms when this TUI session started (set once at store creation; never
   *  patched from the wire) — drives the status-bar session duration. */
  startedAt?: number
}

/** Startup catalog (tools/skills/MCP) for the home-screen panel (item 9 / banner parity). */
export interface Catalog {
  readonly tools: {
    readonly total: number
    readonly toolsets: ReadonlyArray<{ name: string; count: number; enabled: boolean; tools: ReadonlyArray<string> }>
  }
  readonly skills: { readonly total: number; readonly categories: ReadonlyArray<{ name: string; count: number }> }
  readonly mcp: { readonly servers: ReadonlyArray<string> }
}

export interface StoreState {
  ready: boolean
  messages: Message[]
  /** Count of oldest messages trimmed from the DISPLAY by the rolling cap (live
   *  overflow + resume slice). Drives the "N earlier messages" truncation notice;
   *  0 when nothing's been dropped. NOT context loss — the model's history lives on
   *  the gateway (see MESSAGE_CAP); this only bounds in-TUI scrollback. */
  dropped: number
  theme: Theme
  /** The active blocking prompt (composer is hidden while set); undefined when none. */
  prompt: ActivePrompt | undefined
  /** The composer's in-progress draft text, persisted so it survives the
   *  composer unmounting when a blocking prompt (clarify/approval) replaces it
   *  in the <Switch>. Restored on the next composer mount; cleared on submit. */
  composerDraft: string
  /** The latest todo-tool snapshot, captured from every `todo` tool.complete
   *  REGARDLESS of HERMES_TUI_TOOL_OUTPUTS (the pinned TodoPanel is a live
   *  tracker, not a tool body). undefined until the agent first calls `todo`. */
  latestTodos: TodoSnapshot | undefined
  /** The open pager overlay (replaces the transcript while set); undefined when none. */
  pager: PagerState | undefined
  /** The open resume picker (replaces the composer while set); undefined when none. */
  sessionPicker: SessionPickerOverlay | undefined
  /** The open generic picker (model/skills/…); undefined when none. */
  picker: PickerState | undefined
  /** Whether the Esc+Esc session prompt-history viewer is open (Epic 5). */
  promptHistory: boolean
  /** Live completion candidates (slash-name/args or file/@-mention) shown above the composer. */
  completions: CompletionItem[] | undefined
  /** Char offset in the input where an accepted completion should start replacing
   *  (gateway `replace_from` for slash args; the path-token start for @-mentions). */
  completionFrom: number
  /** Delegated subagents (from `subagent.*`), shown in the agents dashboard. */
  subagents: SubagentInfo[]
  /** Whether the agents dashboard overlay is open (/agents). */
  dashboard: boolean
  /** Subagent id the dashboard should preselect on open (tray Enter — Epic 2.7). */
  dashboardAgent: string | undefined
  /** Whether the OS background-process panel overlay is open (/processes). */
  backgroundPanel: boolean
  /** OS background processes (from `agents.list`) — shown in the /processes panel. */
  backgroundProcesses: BackgroundProcess[]
  /** In-flight background-PROMPT task ids (`/bg` → `prompt.background`, cleared on
   *  `background.complete`) — drives the `bg: N` status-bar badge. */
  bgTasks: string[]
  /** Transient busy indicator (the kaomoji face/verb from `thinking.delta`/`status.update`);
   *  shown above the composer WHILE a turn runs, cleared on `message.complete`. NOT transcript. */
  status: string | undefined
  /** Most recent background-activity notification (`notification.show`) — the OSC
   *  seam (terminalChrome) watches this to fire a desktop ping; the inline card
   *  lives in `messages`. Undefined until the first notification. */
  lastNotification: ActivityNotification | undefined
  /** The visible CHROME notice — a persistent status-bar banner with a lifecycle
   *  (credits/usage `kind:'sticky'|'ttl'`), distinct from the inline `messages`
   *  cards. Phase 3 renders it; the store owns its state + lifecycle. null = none. */
  notice: ActivityNotification | null
  /** A chrome notice held mid-turn (arrived while `info.running`) — applied on
   *  `message.complete` so a notice never flashes over a live reply. Latest-wins
   *  (a newer pending replaces an older). null = nothing held. */
  pendingNotice: ActivityNotification | null
  /** Live session chrome for the status bar (model/effort/cwd/branch/context/running). */
  info: SessionInfo
  /** Transient hint shown above the composer (e.g. "Ctrl+C again to quit" — item 11);
   *  takes visual priority over the busy `status` face. Undefined when none. */
  hint: string | undefined
  /** Startup tools/skills/MCP catalog (from `startup.catalog`) for the home panel (item 9). */
  catalog: Catalog | undefined
  /** Cached `/model` picker rows (mapped `model.options`). Prefetched at session
   *  bootstrap and refreshed after a switch, so `/model` opens INSTANTLY from
   *  memory instead of awaiting the slow RPC (it does network calls: pricing
   *  fetch + Nous tier check) on every open (Epic 7). */
  modelItems: PickerItem[] | undefined
  /** The current session id (shown in the home panel; updated on create/resume). */
  sessionId: string | undefined
  // ── display flags (utility commands — Epic 3) ────────────────────────────
  /** Compact transcript (/compact): collapses the blank line between turns/parts.
   *  Defaults OFF — the persisted `display.tui_compact` config doesn't reach the
   *  TUI via session.info, so the flag starts false each launch. */
  compact: boolean
  /** Global tool/reasoning detail mode (/details): collapsed (default) /
   *  expanded (bodies default-open) / hidden (runs fold to one muted line). */
  details: DetailsMode
}

const LRU_LIMIT = 1000

/** Read a string field off an unknown payload record (no `any`, no cast). */
function readStr(payload: { readonly [k: string]: unknown }, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' ? v : undefined
}

/** Read a number field off an unknown payload record. */
function readNum(payload: { readonly [k: string]: unknown }, key: string): number {
  const v = payload[key]
  return typeof v === 'number' ? v : 0
}

/** Read an optional number (undefined when absent) — distinguishes "0" from "missing". */
function readOptNum(payload: { readonly [k: string]: unknown }, key: string): number | undefined {
  const v = payload[key]
  return typeof v === 'number' ? v : undefined
}

/** Render a raw tool `result` for display: strings as-is, anything else pretty
 *  JSON — both then go through the same envelope-strip pipeline as result_text. */
function stringifyResult(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return undefined
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return undefined
  }
}

/**
 * Fold a `session.info` / `session.create.info` payload into a partial SessionInfo.
 * The loose wire JSON is decoded ONCE via `SessionInfoPatchSchema` (decode-at-
 * boundary); context/usage numbers are read from the nested `usage` object first,
 * falling back to the top level (the gateway shapes vary by RPC vs event). A
 * malformed payload decodes to `Option.none` → an empty patch (never crashes).
 * Only present fields are included so a partial patch can't clobber prior chrome.
 */
function readInfoPatch(payload: { readonly [k: string]: unknown }): Partial<SessionInfo> {
  const decoded = decodeSessionInfoPatch(payload)
  if (Option.isNone(decoded)) return {}
  return infoPatchFrom(decoded.value)
}

/** Build the SessionInfo patch from a decoded session.info payload. */
function infoPatchFrom(d: SessionInfoPatchDecoded): Partial<SessionInfo> {
  const patch: Partial<SessionInfo> = {}
  if (d.model) patch.model = d.model
  if (d.reasoning_effort) patch.effort = d.reasoning_effort
  if (d.fast !== undefined) patch.fast = d.fast
  if (d.provider) patch.provider = d.provider
  if (d.cwd) patch.cwd = d.cwd
  if (d.branch) patch.branch = d.branch
  if (d.title) patch.title = d.title
  if (d.running !== undefined) patch.running = d.running
  // prefer the nested usage.context_* numbers, else the top-level fallback.
  const used = d.usage?.context_used ?? d.context_used
  if (used !== undefined) patch.contextUsed = used
  const max = d.usage?.context_max ?? d.context_max
  if (max !== undefined) patch.contextMax = max
  const pct = d.usage?.context_percent ?? d.context_percent
  if (pct !== undefined) patch.contextPercent = pct
  const comp = d.usage?.compressions ?? d.compressions
  if (comp !== undefined) patch.compressions = comp
  if (d.usage?.cost_usd !== undefined) patch.costUsd = d.usage.cost_usd
  // null = "update check not resolved yet" — leave the prior value alone.
  if (typeof d.update_behind === 'number') patch.updateBehind = d.update_behind
  if (d.update_command) patch.updateCommand = d.update_command
  if (d.profile_name) patch.profileName = d.profile_name
  // Count *connected* servers, not configured-but-disabled ones, so the bar's
  // `mcp: N` matches the classic CLI banner (`sum(s.connected)`) and the Ink
  // SessionPanel headline. Each wire entry is `{name,transport,connected,tools}`
  // (Schema.Unknown elements — read `connected` defensively).
  if (d.mcp_servers) patch.mcpServers = countConnectedMcp(d.mcp_servers)
  return patch
}

/** Keep only the string elements of a decoded (unknown-element) array. */
function onlyStrings(items: ReadonlyArray<unknown> | undefined): string[] {
  return (items ?? []).filter((s): s is string => typeof s === 'string')
}

/** Count the *connected* MCP servers in a loose `mcp_servers` wire array.
 *  Each entry is `{name,transport,connected,tools}` but arrives as `unknown`
 *  (Schema.Unknown), so read `connected` defensively: only entries whose
 *  `connected` is exactly `true` count. A configured-but-disabled server
 *  (connected !== true) is excluded — matching the classic CLI banner's
 *  `sum(s.connected)` and the Ink SessionPanel headline. */
function countConnectedMcp(items: ReadonlyArray<unknown> | undefined): number {
  return (items ?? []).reduce<number>(
    (n, s) => (typeof s === 'object' && s !== null && (s as { connected?: unknown }).connected === true ? n + 1 : n),
    0
  )
}

function normalizeTodoStatus(s: unknown): TodoStatus {
  if (s === 'completed' || s === 'in_progress' || s === 'cancelled') return s
  return 'pending'
}

/** Parse a TodoSnapshot from a `todo` tool.complete payload — result.todos
 *  first, else args.todos. Returns undefined when there's no usable list (so a
 *  malformed call never clobbers a good prior snapshot). */
export function todoSnapshotFrom(result: unknown, args: unknown): TodoSnapshot | undefined {
  const fromObj = (o: unknown): unknown =>
    o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>)['todos'] : undefined
  const rawList = fromObj(result) ?? fromObj(args)
  if (!Array.isArray(rawList)) return undefined
  const todos: TodoItem[] = []
  for (const t of rawList) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    const content = typeof o['content'] === 'string' ? o['content'] : ''
    if (content) todos.push({ content, status: normalizeTodoStatus(o['status']) })
  }
  if (todos.length === 0) return undefined
  const counts: TodoCounts = { total: todos.length, completed: 0, in_progress: 0, pending: 0, cancelled: 0 }
  for (const t of todos) counts[t.status]++
  return { todos, counts }
}

/** Build the typed Catalog from a decoded startup.catalog result (item 9). An
 *  absent `enabled` flag means on; nameless toolsets/categories are dropped and
 *  non-string tool/server names are filtered (defensive — wire arrays are loose). */
function catalogFrom(d: CatalogDecoded): Catalog {
  return {
    mcp: { servers: onlyStrings(d.mcp?.servers) },
    skills: {
      total: d.skills?.total ?? 0,
      categories: (d.skills?.categories ?? [])
        .map(c => ({ count: c.count ?? 0, name: c.name ?? '' }))
        .filter(c => c.name)
    },
    tools: {
      total: d.tools?.total ?? 0,
      toolsets: (d.tools?.toolsets ?? [])
        .map(t => ({
          count: t.count ?? 0,
          enabled: t.enabled !== false,
          name: t.name ?? '',
          tools: onlyStrings(t.tools)
        }))
        .filter(t => t.name)
    }
  }
}

/** The subagent status implied by an event type (an explicit payload `status` wins). */
function subagentStatusFor(type: string): string {
  if (type === 'subagent.complete') return 'complete'
  if (type === 'subagent.thinking') return 'thinking'
  if (type === 'subagent.tool') return 'tool'
  if (type === 'subagent.progress') return 'working'
  if (type === 'subagent.text') return 'replying'
  return 'running'
}

export interface SessionStoreOptions {
  /** Fixture/diagnostic harnesses ONLY (scripts/fixture.ts `materialize`): bypass
   *  the handle-safe cap for a store that is never mounted into a renderer.
   *  Production stores must stay clamped — see HANDLE_SAFE_MAX_ROWS below. */
  readonly uncappedFixture?: boolean
}

export function createSessionStore(options?: SessionStoreOptions) {
  // Rolling cap on retained transcript rows. OpenTUI lays out via Yoga (WASM), whose
  // linear memory is grow-only — every live `<For>` row is a Yoga-node subtree, so an
  // uncapped `messages[]` ratchets the high-water mark up over a long session and never
  // gives it back. Capping the array in place (see `capMessages`) makes Solid's keyed
  // `<For>` UNMOUNT exactly the evicted oldest rows → `Renderable.destroy()` →
  // `yogaNode.free()`, returning those nodes to the WASM allocator's free list.
  //
  // The BINDING limit is NOT memory, it's the native handle table: @opentui/core
  // indexes every native object through ONE global 65,534-slot registry
  // (zig/handles.zig, 16-bit slot indices), and every text-bearing renderable
  // burns THREE slots (TextBuffer + TextBufferView + SyntaxStyle —
  // TextBufferRenderable.ts:77-80). The bench fixture measured ~47 handles/row
  // (~16 text renderables/row), so the table exhausts at ≈1,400 LIVE rows with
  // an uncaught "Failed to create SyntaxStyle" mid-mount (crash anatomy +
  // degrade shim: boundary/nativeHandles.ts). The previous default of 3000 was
  // therefore unreachable — the TUI crashed before the cap ever bound.
  //
  // HANDLE_SAFE_MAX_ROWS = 1000 ≈ 47k handles ≈ 72% of the table on the
  // realistic-fixture mix, leaving ~18k slots of headroom for chrome
  // (composer/pickers/dashboard) and heavier-than-fixture rows. Pathological
  // rows can still exceed it; nativeHandles.ts degrades (unstyled text)
  // instead of crashing. `HERMES_TUI_MAX_MESSAGES` can LOWER the cap but
  // never raise it past the ceiling. Read once per store. Trimmed turns aren't
  // lost — they live on the gateway and are recoverable via `/resume`.
  //
  // With transcript WINDOWING on (#27, S1+S2 in view/transcript.tsx — the
  // default), handles no longer scale with the store: out-of-window rows are
  // exact-height spacers and the mounted set is ~3 viewports (measured peak 31
  // rows over a 1500-row burst), so the scrollback ceiling returns to 3000
  // (the originally shipped default, regression documented in
  // docs/plans/opentui-fixes-audit.md §2). The HERMES_TUI_WINDOWING=0 escape
  // hatch mounts every row again, so it keeps the handle-safe 1000 clamp.
  const HANDLE_SAFE_MAX_ROWS = 1000
  const WINDOWED_MAX_ROWS = 3000
  const MESSAGE_CAP = (() => {
    if (options?.uncappedFixture) return Number.MAX_SAFE_INTEGER
    const windowing = envFlag(process.env.HERMES_TUI_WINDOWING, true)
    const ceiling = windowing ? WINDOWED_MAX_ROWS : HANDLE_SAFE_MAX_ROWS
    const raw = Number.parseInt(process.env.HERMES_TUI_MAX_MESSAGES ?? '', 10)
    const requested = Number.isFinite(raw) && raw > 0 ? raw : ceiling
    return Math.min(requested, ceiling)
  })()

  const [state, setState] = createStore<StoreState>({
    ready: false,
    messages: [],
    dropped: 0,
    theme: DEFAULT_THEME,
    prompt: undefined,
    composerDraft: '',
    latestTodos: undefined,
    pager: undefined,
    sessionPicker: undefined,
    picker: undefined,
    promptHistory: false,
    completions: undefined,
    completionFrom: 0,
    subagents: [],
    dashboard: false,
    dashboardAgent: undefined,
    backgroundPanel: false,
    backgroundProcesses: [],
    bgTasks: [],
    lastNotification: undefined,
    notice: null,
    pendingNotice: null,
    status: undefined,
    // startedAt is set ONCE here (store creation ≈ session start) — the status
    // bar's session-duration segment ticks from it; wire patches never carry it.
    info: { startedAt: Date.now() },
    hint: undefined,
    catalog: undefined,
    modelItems: undefined,
    sessionId: undefined,
    compact: false,
    details: 'collapsed'
  })

  // Monotonic part id (stable `key` per part so a new tool part below a streaming
  // text part doesn't remount/re-tokenize it).
  let partSeq = 0
  const nextId = () => `p${++partSeq}`

  // LRU id-dedup: events that carry a stable id are applied at most once.
  const applied = new Set<string>()
  function duplicate(id: string | undefined): boolean {
    if (!id) return false
    if (applied.has(id)) return true
    applied.add(id)
    if (applied.size > LRU_LIMIT) {
      const oldest = applied.values().next()
      if (!oldest.done) applied.delete(oldest.value)
    }
    return false
  }

  // Hydrate-while-buffering (resume): while a snapshot is loading, live events
  // queue here and replay after the snapshot is reconciled (opencode sync-v2).
  let buffering: GatewayEvent[] | null = null

  // Chrome-notice TTL timer (NOT store state — a transient handle, not reactive
  // data). At most ONE armed at a time: every applyNotice clears the prior before
  // arming a new one (latest-wins), and the callback nulls it on fire. Mirrors the
  // Ink turnController's single `noticeTimer` handle.
  let noticeTimer: ReturnType<typeof setTimeout> | undefined

  // Anti-flood for `gateway.stderr`: a crashing child can emit a torrent of
  // stderr lines, so we do NOT push each to the transcript. Instead we keep a
  // small ring of the most-recent lines and only surface a TAIL of it when a
  // failure event (start_timeout / exited) actually needs the diagnostic
  // context — so a healthy-but-chatty gateway never spams the chat.
  const STDERR_RING_LIMIT = 20
  const STDERR_TAIL = 5
  const stderrRing: string[] = []
  function stderrTail(): string {
    return stderrRing.slice(-STDERR_TAIL).join('\n')
  }

  function setSkin(skin: GatewaySkinDecoded | undefined): void {
    setState('theme', themeFromSkin(skin))
  }

  // Trim the transcript to MESSAGE_CAP, dropping the OLDEST rows IN PLACE via
  // `splice` (NOT a `slice`-reassign). A keyed `<For>` keeps rows by item
  // REFERENCE, so splicing the head unmounts only the evicted rows (freeing their
  // Yoga nodes) while the survivors keep their refs and are not remounted. A live
  // streaming assistant turn is always the LAST row, so head-trimming never drops it.
  function capMessages(draft: StoreState): void {
    const overflow = draft.messages.length - MESSAGE_CAP
    if (overflow > 0) {
      draft.messages.splice(0, overflow)
      draft.dropped += overflow
    }
  }

  // ── parts helpers (operate on a draft message inside produce) ───────────
  function appendPart(m: Message, type: 'text' | 'reasoning', text: string): void {
    const parts = (m.parts ??= [])
    const last = parts[parts.length - 1]
    if (last && last.type === type) last.text += text
    else parts.push({ type, id: nextId(), text })
  }

  /** The live (last) assistant message, optionally only when still streaming. */
  function liveAssistant(draft: StoreState, streamingOnly = false): Message | undefined {
    const last = draft.messages[draft.messages.length - 1]
    if (last && last.role === 'assistant' && (!streamingOnly || last.streaming)) return last
    return undefined
  }

  /** Ensure there's an open assistant turn to attach parts to (tool/reasoning). */
  function ensureAssistant(draft: StoreState): Message {
    const live = liveAssistant(draft, true)
    if (live) return live
    const created: Message = { role: 'assistant', text: '', parts: [], streaming: true }
    draft.messages.push(created)
    return created
  }

  /** Find a tool part by id in the CURRENT (last) assistant turn — a tool.complete
   *  always pairs with a tool.start in the live turn, so scoping there avoids
   *  matching a same-id tool in an older/resumed turn (and is O(parts), not O(all)). */
  function findToolPart(draft: StoreState, id: string): ToolPartState | undefined {
    const parts = liveAssistant(draft)?.parts
    if (!parts) return undefined
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]
      if (p && p.type === 'tool' && p.id === id) return p
    }
    return undefined
  }

  /** Push a user message (composer submit). */
  function pushUser(text: string) {
    setState(
      produce(draft => {
        draft.messages.push({ role: 'user', text })
        capMessages(draft)
      })
    )
  }

  /** Push a system line (slash output, errors, notices). */
  function pushSystem(text: string) {
    // slash/notice text is often ANSI-colored for the Ink TUI; strip codes so
    // they don't render as literal `[1;38m…` glyphs in the native engine (item 8).
    const clean = stripAnsi(text)
    setState(
      produce(draft => {
        draft.messages.push({ role: 'system', text: clean })
        capMessages(draft)
      })
    )
  }

  /** Push a background-activity notification as a distinct inline card (role
   *  `'notification'`) and record it as `lastNotification` for the OSC seam.
   *  NOT a plain system line — the card renders level-tinted, clearly chrome. */
  function pushNotification(n: ActivityNotification) {
    // Store INDEPENDENT clones in the message vs lastNotification: createStore
    // wraps a shared object reference into one node, which would alias every
    // card to the most-recent notification (the message text stays right, but the
    // nested payload bleeds). Distinct copies keep each card's payload its own.
    setState(
      produce(draft => {
        draft.messages.push({ role: 'notification', text: n.text, notification: { ...n } })
        capMessages(draft)
      })
    )
    setState('lastNotification', { ...n })
  }

  /** Drop the inline cards for a cleared notification key (`notification.clear`). */
  function clearNotificationCards(key: string) {
    setState(
      'messages',
      state.messages.filter(m => !(m.role === 'notification' && m.notification?.key === key))
    )
  }

  // ── chrome notice lifecycle (port of ui-tui turnController showNotice/
  // applyNotice/clearNotice/flushPendingNotice) — the persistent status-bar
  // banner, distinct from the inline `messages` cards. ────────────────────────

  /** Make a notice VISIBLE now (the actual `state.notice` write + TTL arming).
   *  Latest-wins: always clear any prior TTL timer first, so a fresh notice can't
   *  be expired by a stale predecessor's timer. A `ttl` kind with a positive
   *  ttlMs self-clears after ttlMs — but only if it's still the same notice on
   *  screen (an `id` guard, so a later notice that replaced it isn't yanked). */
  function applyNotice(n: ActivityNotification) {
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = undefined
    setState('notice', n)
    if (n.kind === 'ttl' && typeof n.ttlMs === 'number' && n.ttlMs > 0) {
      noticeTimer = setTimeout(() => {
        noticeTimer = undefined
        if (state.notice?.id === n.id) setState('notice', null)
      }, n.ttlMs)
    }
  }

  /** Show a chrome notice, deferring it mid-turn. While a turn runs (`info.running`)
   *  a banner would flash over the live reply, so HOLD it as `pendingNotice`
   *  (latest-wins — a newer pending just replaces the older) and apply it on
   *  message.complete (flushPendingNotice). Idle → apply immediately. */
  function showNotice(n: ActivityNotification) {
    if (state.info.running) setState('pendingNotice', n)
    else applyNotice(n)
  }

  /** Clear a notice by key (`notification.clear`) from BOTH the pending hold and
   *  the visible slot. A key lives in only one notice at a time, but clearing
   *  both is safe (and matches the Ink semantics). Clears the TTL timer when the
   *  visible notice is the one removed. */
  function clearNotice(key: string) {
    if (state.pendingNotice?.key === key) setState('pendingNotice', null)
    if (state.notice?.key === key) {
      if (noticeTimer) clearTimeout(noticeTimer)
      noticeTimer = undefined
      setState('notice', null)
    }
  }

  /** Apply any notice held mid-turn (call on message.complete). No-op when none. */
  function flushPendingNotice() {
    const p = state.pendingNotice
    if (!p) return
    setState('pendingNotice', null)
    applyNotice(p)
  }

  /** Reset all notice state (timer + visible + pending) — so a notice can't bleed
   *  across a /clear or /new into the next session. */
  function clearNoticeState() {
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = undefined
    setState('notice', null)
    setState('pendingNotice', null)
  }

  /** Clear the transcript (e.g. /clear, /new) and any tracked subagents. */
  function clearTranscript() {
    setState('messages', [])
    setState('subagents', [])
    setState('dropped', 0)
    // A fresh session has no plan — drop the pinned todo panel's snapshot.
    setState('latestTodos', undefined)
    // Drop the dedup history too — a fresh transcript should re-process any id.
    applied.clear()
    // A chrome notice must not survive a transcript reset (new session context).
    clearNoticeState()
    // /new and /clear start a fresh context: the status-bar usage gauges
    // (ctx %, tokens, cost, compressions) must zero out. They can't clear via a
    // later session.info because infoPatchFrom only MERGES present fields, so a
    // fresh session that omits them would leave the stale numbers. Delete them
    // here via produce (setState('info', fn) MERGES a returned partial, so an
    // omit-by-spread would NOT remove the keys). Keep stable session identity.
    setState(
      'info',
      produce(info => {
        delete info.contextUsed
        delete info.contextMax
        delete info.contextPercent
        delete info.costUsd
        delete info.compressions
      })
    )
  }

  /** Open / close the agents dashboard overlay (/agents). The optional `agentId`
   *  preselects that subagent's row (the tray's Enter — Epic 2.7). */
  function openDashboard(agentId?: string) {
    setState('dashboardAgent', agentId)
    setState('dashboard', true)
  }
  function closeDashboard() {
    setState('dashboard', false)
    setState('dashboardAgent', undefined)
  }

  function openBackgroundPanel() {
    setState('backgroundPanel', true)
  }
  function closeBackgroundPanel() {
    setState('backgroundPanel', false)
  }
  /** Replace the OS-process snapshot (drives the /processes panel). */
  function setBackgroundProcesses(procs: BackgroundProcess[]) {
    setState('backgroundProcesses', procs)
  }
  /** Track an in-flight background-prompt task (`/bg` start) — drives the `bg:` badge. */
  function addBgTask(id: string) {
    if (!state.bgTasks.includes(id)) setState('bgTasks', [...state.bgTasks, id])
  }
  function removeBgTask(id: string) {
    setState(
      'bgTasks',
      state.bgTasks.filter(t => t !== id)
    )
  }

  /** Open a local Y/N confirm dialog (non-gateway; e.g. /clear). */
  function setConfirm(message: string, onConfirm: () => void) {
    setState('prompt', { kind: 'confirm', message, onConfirm })
  }

  /** Open the pager overlay (long slash output: /status, /logs, …). */
  function openPager(title: string, text: string) {
    setState('pager', { title, text: stripAnsi(text) })
  }

  /** Close the pager overlay. */
  function closePager() {
    setState('pager', undefined)
  }

  /** Open the resume picker on the given tab (/sessions, /resume, boot picker). */
  function openSessionPicker(tab: SessionTabId = 'recent') {
    setState('sessionPicker', { tab })
  }

  /** Close the resume picker. */
  function closeSessionPicker() {
    setState('sessionPicker', undefined)
  }

  /** Open the generic picker (model picker, skills hub, …). */
  function openPicker(picker: PickerState) {
    setState('picker', picker)
  }

  /** Close the generic picker. */
  function closePicker() {
    setState('picker', undefined)
  }

  /** Open / close the Esc+Esc session prompt-history viewer (Epic 5). */
  function openPromptHistory() {
    setState('promptHistory', true)
  }
  function closePromptHistory() {
    setState('promptHistory', false)
  }

  /** Cache the mapped `/model` picker rows (instant open — Epic 7). */
  function setModelItems(items: PickerItem[]) {
    setState('modelItems', items)
  }

  /** Set / clear the transient composer hint ("Ctrl+C again to quit" — item 11). */
  function setHint(text: string | undefined): void {
    setState('hint', text)
  }
  // Per-block copy feedback (design pass piece 2): deep view nodes flash
  // "Copied" on this store's hint line via the notify seam — the same surface
  // the entry's flashHint uses. One live store per app; latest wins.
  registerNotifier(setHint)

  /** /compact — set the compact-transcript display flag (Epic 3). */
  function setCompact(on: boolean): void {
    setState('compact', on)
  }

  /** /details — set the global tool/reasoning detail mode (Epic 3). */
  function setDetails(mode: DetailsMode): void {
    setState('details', mode)
  }

  /** Merge a session-info patch into the chrome state (status bar — item 14). */
  function applyInfo(raw: { readonly [k: string]: unknown }): void {
    const patch = readInfoPatch(raw)
    if (Object.keys(patch).length) setState('info', prev => ({ ...prev, ...patch }))
  }

  /** Set / clear the live completion candidates (composer dropdown). `from` is the
   *  input char offset an accepted item replaces from (slash-arg / @-mention splice). */
  function setCompletions(items: CompletionItem[], from = 0) {
    setState('completions', items.length ? items : undefined)
    setState('completionFrom', items.length ? Math.max(0, from) : 0)
  }
  function clearCompletions() {
    setState('completions', undefined)
    setState('completionFrom', 0)
  }

  /** Reduce a decoded gateway event into the store. The sole boundary->Solid sink. */
  function apply(event: GatewayEvent): void {
    if (buffering) {
      buffering.push(event)
      return
    }
    applyNow(event)
  }

  function applyNow(event: GatewayEvent): void {
    switch (event.type) {
      case 'gateway.ready':
        setState('ready', true)
        // Clear any transient status: on a recovery-respawn ready this drops the
        // lingering 'gateway recovering (attempt N)…' line; no-op on first connect.
        setState('status', undefined)
        setSkin(event.payload?.skin)
        break
      case 'skin.changed':
        setSkin(event.payload)
        break
      case 'session.info':
        applyInfo(event.payload)
        break
      case 'message.start':
        setState('status', undefined)
        // Flash-and-yield: a credits usage/grant notice yields to the live turn it
        // precedes (it's stale the moment the user sends), so clear it before the
        // turn opens. Sticky credits notices (e.g. depleted) persist. Port of the
        // Ink turnController startMessage flash-and-yield.
        {
          const k = state.notice?.key
          if (k === 'credits.usage' || k === 'credits.grant_spent') clearNotice(k)
        }
        setState('info', prev => ({ ...prev, running: true }))
        setState(
          produce(draft => {
            draft.messages.push({ role: 'assistant', text: '', parts: [], streaming: true })
            capMessages(draft)
          })
        )
        break
      case 'message.delta': {
        // prefer `text` over `rendered` (gotcha §8 #4 — rendered is incremental Rich-ANSI).
        const text = event.payload?.text ?? ''
        if (!text) break
        setState(
          produce(draft => {
            const live = liveAssistant(draft, true)
            if (live) appendPart(live, 'text', text)
          })
        )
        break
      }
      case 'message.complete':
        setState(
          produce(draft => {
            // complete-only gateways may send `message.complete{text}` with no prior
            // start/delta → create the turn so the final text isn't dropped.
            const finalText = event.payload?.text
            const live = liveAssistant(draft, true) ?? (finalText ? ensureAssistant(draft) : undefined)
            if (!live) return
            // If no deltas arrived (complete-only gateways), seed the full text once.
            const hasText = (live.parts ?? []).some(p => p.type === 'text' && p.text.length > 0)
            if (finalText && !hasText) appendPart(live, 'text', finalText)
            live.streaming = false
          })
        )
        setState('status', undefined)
        setState('info', prev => ({ ...prev, running: false }))
        // Apply any chrome notice held mid-turn now the turn's done (no flash over
        // a live reply). No-op when nothing was held.
        flushPendingNotice()
        // message.complete carries the latest usage/context — refresh the bar.
        if (event.payload) applyInfo(event.payload)
        break
      // thinking.delta / status.update are the TRANSIENT busy indicator (kaomoji
      // face/verb) — route them to the status line, NOT the transcript (gotcha: Ink
      // shows these as a FaceTicker, not message content).
      case 'thinking.delta':
      case 'status.update': {
        const text = event.payload?.text ?? ''
        if (text) setState('status', text)
        break
      }
      // notification.show — background-activity notice (process/run state change,
      // credits, etc.). Renders as a distinct inline card (NOT a plain line) and
      // records lastNotification so the OSC seam can ping a blurred terminal.
      case 'notification.show': {
        const n = parseNotification(event.payload)
        if (!n) break
        // Route by chrome-ness. Approach (a): lastNotification (the OSC seam) is
        // recorded by `pushNotification` for the CARD path, so we set it here only
        // for the CHROME path — avoids double-setting and keeps the existing
        // pushNotification callers (background.complete) recording it correctly.
        if (isChromeNotice(n)) {
          setState('lastNotification', { ...n }) // OSC seam (distinct clone — aliasing footgun)
          showNotice({ ...n }) // distinct clone again: notice + lastNotification must not share a ref
        } else {
          pushNotification(n) // pushNotification records lastNotification itself (card path)
        }
        break
      }
      case 'notification.clear': {
        const key = event.payload?.key
        if (key) {
          clearNotificationCards(key) // inline-card path
          clearNotice(key) // chrome path (key lives in one path; both is safe)
        }
        break
      }
      // A background PROMPT (`/bg`) finished: drop it from the in-flight set (the
      // `bg:` badge) and surface its result as a distinct inline completion card
      // (a completion-ish kind → also fires the OSC desktop ping).
      case 'background.complete': {
        removeBgTask(event.payload.task_id)
        pushNotification({
          id: `bg:${event.payload.task_id}`,
          kind: 'background task complete',
          level: 'info',
          text: `bg ${event.payload.task_id} → ${event.payload.text}`
        })
        break
      }
      // reasoning.delta is the model's actual reasoning — a (dim) transcript part.
      case 'reasoning.delta': {
        const text = event.payload?.text ?? ''
        if (!text) break
        setState(
          produce(draft => {
            appendPart(ensureAssistant(draft), 'reasoning', text)
          })
        )
        break
      }
      case 'tool.start': {
        const id = readStr(event.payload, 'tool_id')
        if (!id) break
        const name = readStr(event.payload, 'name') ?? 'tool'
        // `context` = build_tool_preview's primary-arg line (always sent); `args_text`
        // = redacted full-arg JSON (verbose mode only). Surfacing these is item 2.
        const argsPreview = readStr(event.payload, 'context')
        const argsText = readStr(event.payload, 'args_text')
        setState(
          produce(draft => {
            const live = ensureAssistant(draft)
            const part: ToolPartState = { type: 'tool', id, name, state: 'running', startedAt: Date.now() }
            if (argsPreview) part.argsPreview = argsPreview
            if (argsText) part.argsText = argsText
            ;(live.parts ??= []).push(part)
          })
        )
        break
      }
      case 'tool.complete': {
        const id = readStr(event.payload, 'tool_id')
        if (!id) break
        const name = readStr(event.payload, 'name')
        // explicit payload error wins; else derive from the `{"error": …}` result
        // convention (the only failure signal the live gateway actually ships).
        const error = readStr(event.payload, 'error')
        const summary = readStr(event.payload, 'summary')
        // Tool-output retention flag (W3, glitch 2026-06-14): when OFF, the rich
        // result body + raw result/args dicts are neither built nor stored (Ink
        // parity — Ink keeps only a context line). KEEP either way: name, state,
        // duration, error, summary, argsPreview, and the file-edit diff (a diff
        // is a high-value surface, not generic "output"). This is the biggest
        // memory lever (the OpenTUI-vs-Ink retention asymmetry).
        const keepOutputs = toolOutputsEnabled()
        // `result_text` is verbose-gated, but the raw `result` is ALWAYS sent —
        // when the verbose text is absent, derive the display body from `result`
        // (so e.g. bash output still renders in non-verbose sessions). Then peel
        // the gateway's "[showing verbose tail; omitted …]" label (item 2) before
        // envelope-stripping, so the body is clean and the note renders tidily.
        // Skip the whole body-build when outputs are OFF (nothing consumes it).
        let resultText = ''
        let lineCount = 0
        let omittedNote: string | undefined
        if (keepOutputs) {
          let rawBody: string
          ;({ body: rawBody, omittedNote } = stripOmittedNote(
            readStr(event.payload, 'result_text') ?? stringifyResult(event.payload['result']) ?? summary ?? ''
          ))
          // The view cap is UNLIMITED (HERMES_TUI_TOOL_OUTPUT_LINES unset/0 — the
          // default), but a gateway-capped `result_text` (omittedNote) is only a
          // TAIL — substituting the always-full raw `result` is the only way the
          // uncapped view can actually show everything. Same display pipeline
          // (envelope strip) — and the same raw-result redaction tradeoff — as the
          // existing non-verbose stringifyResult fallback above. The omitted note
          // no longer applies to the full body. With an explicit FINITE cap the
          // gateway tail + note are kept (the user asked for a bounded view; the
          // view-side "+N more lines" stays honest below that). File-edit JSON
          // results stay parseable, so fileTool's diffOutputPlan still suppresses
          // the diff echo. The redacted-argsText precedence is untouched.
          if (omittedNote && envOutputUnlimited(process.env.HERMES_TUI_TOOL_OUTPUT_LINES)) {
            const full = stringifyResult(event.payload['result'])
            if (full !== undefined) {
              rawBody = full
              omittedNote = undefined
            }
          }
          resultText = stripToolEnvelope(rawBody)
          lineCount = resultText ? resultText.replace(/\s+$/, '').split('\n').length : 0
        }
        // `args` (full dict) is always sent; stringify as the expanded-view args
        // when verbose `args_text` wasn't captured on start. `duration_s` → header.
        const argsObj = event.payload['args']
        const duration = readOptNum(event.payload, 'duration_s')
        // FULL raw unified diff (file-edit tools; gateway caps at 512KB). Stats
        // are computed once here, not per render. Kept even when outputs are OFF.
        const diffUnified = readStr(event.payload, 'diff_unified')
        setState(
          produce(draft => {
            let part = findToolPart(draft, id)
            if (!part) {
              // complete without a matching start — append a settled tool part.
              part = { type: 'tool', id, name: name ?? 'tool', state: 'running' }
              ;(ensureAssistant(draft).parts ??= []).push(part)
            }
            part.state = 'complete'
            if (name) part.name = name
            if (summary) part.summary = summary
            if (error) part.error = error
            if (duration !== undefined) part.duration = duration
            if (diffUnified) {
              part.diffUnified = diffUnified
              part.diffStats = diffStats(diffUnified)
            }
            // Tool-output bodies (W3): only retained when outputs are ON. With no
            // resultText/result, defaultRenderer.expandable() is false → header-
            // only row (Ink parity). argsPreview (from tool.start) is untouched.
            if (keepOutputs) {
              part.lineCount = lineCount
              if (resultText) part.resultText = resultText
              if (omittedNote) part.omittedNote = omittedNote
              // structured dict results feed the per-tool renderers (read_file
              // content, search matches, clarify Q&A, skill_view description).
              const resultObj = event.payload['result']
              if (resultObj && typeof resultObj === 'object' && !Array.isArray(resultObj))
                part.result = resultObj as Record<string, unknown>
              if (argsObj && typeof argsObj === 'object') {
                // structured args feed the per-tool renderers (labeled fields, bash command).
                if (!Array.isArray(argsObj)) part.args = argsObj as Record<string, unknown>
                if (!part.argsText) {
                  try {
                    part.argsText = JSON.stringify(argsObj, null, 2)
                  } catch {
                    /* unstringifiable args — leave unset */
                  }
                }
              }
            }
          })
        )
        // Todo panel (live tracker): capture the latest todo snapshot from EVERY
        // `todo` tool.complete, REGARDLESS of HERMES_TUI_TOOL_OUTPUTS (the pinned
        // panel is not a tool body). Set OUTSIDE the produce() above — it's a
        // separate top-level slice, not part of the message tree. Keeps list
        // order (= priority); never re-sorts.
        if (name === 'todo') {
          const snap = todoSnapshotFrom(event.payload['result'], event.payload['args'])
          if (snap) setState('latestTodos', snap)
        }
        break
      }
      // ── blocking prompts (spec §8 #6 — unhandled = the agent deadlocks) ──
      case 'clarify.request':
        setState('prompt', {
          kind: 'clarify',
          question: event.payload.question ?? '',
          // decoded choices are readonly — copy to the store's mutable string[]
          choices: event.payload.choices ? [...event.payload.choices] : null,
          requestId: event.payload.request_id
        })
        break
      case 'approval.request':
        setState('prompt', { kind: 'approval', command: event.payload.command, description: event.payload.description })
        break
      case 'sudo.request':
        setState('prompt', { kind: 'sudo', requestId: event.payload.request_id })
        break
      case 'secret.request':
        setState('prompt', {
          kind: 'secret',
          envVar: event.payload.env_var,
          prompt: event.payload.prompt,
          requestId: event.payload.request_id
        })
        break
      // ── subagents (agents dashboard) — track the delegation tree by id ──
      case 'subagent.spawn_requested':
      case 'subagent.start':
      case 'subagent.thinking':
      case 'subagent.tool':
      case 'subagent.progress':
      case 'subagent.complete':
      case 'subagent.text': {
        const id = readStr(event.payload, 'subagent_id')
        if (!id) break
        setState(
          produce(draft => {
            let sa = draft.subagents.find(s => s.id === id)
            if (!sa) {
              sa = { depth: readNum(event.payload, 'depth'), goal: '', id, status: 'running' }
              draft.subagents.push(sa)
            }
            const goal = readStr(event.payload, 'goal')
            if (goal) sa.goal = goal
            const model = readStr(event.payload, 'model')
            if (model) sa.model = model
            const parent = readStr(event.payload, 'parent_id')
            if (parent) sa.parentId = parent
            const summary = readStr(event.payload, 'summary')
            if (summary) sa.summary = summary
            const tool = readStr(event.payload, 'tool_name')
            if (tool) sa.lastTool = tool
            sa.status = readStr(event.payload, 'status') ?? subagentStatusFor(event.type)

            // Live trace (item 15): a concise per-subagent activity log. Thinking
            // deltas update a transient `thought` (not appended — they'd flood).
            const text = readStr(event.payload, 'text')
            const trace = (sa.trace ??= [])
            if (event.type === 'subagent.start') trace.push({ kind: 'start', text: goal ?? sa.goal ?? 'started' })
            else if (event.type === 'subagent.tool' && tool)
              trace.push({ kind: 'tool', text: text ? `${tool} — ${text}` : tool })
            else if (event.type === 'subagent.progress' && text) trace.push({ kind: 'progress', text })
            else if (event.type === 'subagent.complete') trace.push({ kind: 'summary', text: summary ?? 'done' })
            else if (event.type === 'subagent.thinking' && text) sa.thought = text
            // Per-token reply text (subagent.text): COALESCE into one growing
            // 'reply' line. The server mirrors this once per token, so appending
            // to the last reply entry (vs pushing) keeps the trace from flooding.
            else if (event.type === 'subagent.text' && text) {
              const last = trace[trace.length - 1]
              if (last && last.kind === 'reply') last.text += text
              else trace.push({ kind: 'reply', text })
            }
            if (trace.length > SUBAGENT_TRACE_LIMIT) trace.splice(0, trace.length - SUBAGENT_TRACE_LIMIT)
          })
        )
        break
      }
      // ── gateway lifecycle / transport errors (auto-heal foundations) ──
      // The child exited mid-turn. THE key bug fix: clear the frozen `running`
      // spinner (no message.complete will ever arrive for the lost reply), tell
      // the user their in-flight reply was lost, and show a recovering status.
      case 'gateway.exited': {
        setState('info', prev => ({ ...prev, running: false }))
        // A turn can also end via the child exiting mid-reply (no message.complete) —
        // flush any held notice here too, the third turn-end site (Ink interruptTurn).
        flushPendingNotice()
        // Neutral status: we don't ALWAYS recover (budget exhaustion). The
        // "recovering…" wording now comes from the gateway.recovering case,
        // which fires only when a respawn is actually scheduled.
        setState('status', 'gateway exited')
        const reason = event.payload?.reason
        const base = 'gateway exited — recovering your session (any in-flight reply was lost)'
        pushSystem(reason ? `${base}: ${reason}` : base)
        break
      }
      // A respawn+resume attempt is in flight — reflect the attempt in the status.
      case 'gateway.recovering': {
        const attempt = event.payload?.attempt
        setState('status', attempt ? `gateway recovering (attempt ${attempt})…` : 'gateway recovering…')
        break
      }
      // Collect stderr into a bounded ring (NOT the transcript) — see stderrRing.
      case 'gateway.stderr': {
        stderrRing.push(event.payload.line)
        if (stderrRing.length > STDERR_RING_LIMIT) stderrRing.splice(0, stderrRing.length - STDERR_RING_LIMIT)
        break
      }
      // The gateway never reached `gateway.ready` — surface the failure with any
      // stderr tail (payload is a loose Record; read defensively).
      case 'gateway.start_timeout': {
        const detail = readStr(event.payload, 'stderr') ?? readStr(event.payload, 'message') ?? stderrTail()
        pushSystem(detail ? `gateway failed to start:\n${detail}` : 'gateway failed to start')
        break
      }
      case 'gateway.protocol_error': {
        const preview = event.payload?.preview
        pushSystem(preview ? `gateway protocol error: ${preview}` : 'gateway protocol error')
        break
      }
      case 'error': {
        const message = event.payload?.message
        pushSystem(message ? `error: ${message}` : 'error')
        // A turn can end via error without message.complete — flush any held
        // notice here too, matching Ink recordError.
        flushPendingNotice()
        break
      }
      // Other event types (chrome) are reduced in later phases; unhandled members
      // are intentionally ignored here.
    }
  }

  /** Clear the active blocking prompt (after it's answered/cancelled). */
  function clearPrompt(): void {
    setState('prompt', undefined)
  }

  /** Persist the composer's in-progress draft (survives composer unmount when a
   *  blocking prompt replaces it). Cleared on submit. */
  function setComposerDraft(text: string): void {
    setState('composerDraft', text)
  }

  // ── resume hydrate (opencode sync-v2): buffer live events while the snapshot
  // loads, then replace history + replay the buffer in order. Split into begin/
  // commit so the buffer can span an async `session.resume` RPC.
  /** Start buffering live events (call BEFORE the async resume RPC). Idempotent. */
  function beginBuffer(): void {
    if (!buffering) buffering = []
  }

  /** Replace history with the resume snapshot, then replay events buffered meanwhile. */
  function commitSnapshot(snapshot: Message[]): void {
    // Resume replaces session context — a prior session's notice/timer must not
    // bleed in; mirrors Ink reset(). Deliberate tradeoff: a same-session
    // auto-heal reconnect momentarily drops a standing sticky banner, which the
    // gateway re-emits on the next header parse — acceptable vs. cross-session
    // bleed + a leaked timer.
    clearNoticeState()
    // …same reasoning for the pinned todo panel: a resumed/different session must
    // not inherit the prior session's plan. The resumed session re-emits its own
    // `todo` snapshot if it has one (mirrors clearTranscript's reset).
    setState('latestTodos', undefined)
    // Slice to the cap BEFORE the first setState, not after. Yoga (WASM) layout
    // memory is grow-only, so even a TRANSIENT mount of an over-cap resume
    // snapshot would permanently ratchet the high-water mark — a set-then-trim
    // briefly hands the full fetched history to <For>. Pre-slicing guarantees
    // resuming ANY session mounts at most MESSAGE_CAP rows. (Events buffered
    // across the resume RPC, replayed below, self-cap via capMessages per push.)
    // With windowing ON (HERMES_TUI_WINDOWING — view/transcript.tsx S2) the
    // view mounts only the BOTTOM window of this snapshot anyway: rows created
    // deep in a bulk replace start as line-count-estimate spacers and are
    // measured lazily. The pre-slice still bounds the windowing-OFF path and
    // the store's own JS retention.
    const capped = snapshot.length > MESSAGE_CAP ? snapshot.slice(-MESSAGE_CAP) : snapshot
    setState('messages', capped)
    // A resume is a fresh view → SET (not accumulate) the dropped count to what the
    // snapshot slice hid, so the notice reflects this session. Live pushes add to it.
    setState('dropped', snapshot.length - capped.length)
    const pending = buffering ?? []
    buffering = null
    for (const event of pending) applyNow(event)
  }

  /** Synchronous convenience: buffer → load → commit (used by tests). */
  function hydrate(loadSnapshot: () => Message[]): void {
    beginBuffer()
    commitSnapshot(loadSnapshot())
  }

  /**
   * Map the loose `startup.catalog` response into the typed Catalog (item 9).
   * Decoded ONCE via `CatalogSchema` (decode-at-boundary); garbage decodes to
   * `Option.none` → the catalog is left unset rather than crashing the panel.
   */
  function setCatalog(raw: unknown): void {
    const decoded = decodeCatalog(raw)
    if (Option.isNone(decoded)) return
    setState('catalog', catalogFrom(decoded.value))
  }

  function setSessionId(sid: string | undefined): void {
    setState('sessionId', sid)
  }

  return {
    state,
    apply,
    pushUser,
    pushSystem,
    pushNotification,
    showNotice,
    clearNotice,
    setCatalog,
    setSessionId,
    clearTranscript,
    setConfirm,
    openPager,
    closePager,
    openSessionPicker,
    closeSessionPicker,
    openPicker,
    closePicker,
    openPromptHistory,
    closePromptHistory,
    setModelItems,
    setCompletions,
    clearCompletions,
    applyInfo,
    setHint,
    setCompact,
    setDetails,
    openDashboard,
    closeDashboard,
    openBackgroundPanel,
    closeBackgroundPanel,
    setBackgroundProcesses,
    addBgTask,
    hydrate,
    beginBuffer,
    commitSnapshot,
    duplicate,
    clearPrompt,
    setComposerDraft
  } as const
}

export type SessionStore = ReturnType<typeof createSessionStore>
