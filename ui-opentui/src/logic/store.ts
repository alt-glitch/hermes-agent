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
import type { BillingOverlayState, SubscriptionOverlayState } from '../boundary/billing.ts'
import type { CommandsCatalogResponse } from '../boundary/schema/SessionCommandResponses.ts'
import { decodeSessionActiveListResponse, type ActiveItem } from '../boundary/schema/SessionOrchestratorResponses.ts'
import {
  decodeDelegationPauseResponse,
  decodeDelegationStatusResponse,
  decodeSpawnTreeLoadResponse,
  type SpawnTreeSubagent
} from '../boundary/schema/Delegation.ts'
import {
  decodeCatalog,
  decodeSessionInfoPatch,
  type CatalogDecoded,
  type SessionInfoPatchDecoded
} from '../boundary/schema/SessionInfo.ts'
import type { DetailsMode, DetailsSection, DetailsSections } from './details.ts'
import {
  applyDelegationState,
  clearAgentsNudgeTurn,
  configureAgentsNudge as configureAgentsNudgeState,
  considerAgentsNudge,
  createAgentsNudgeState,
  createDelegationState,
  resolveActiveSubagentCount,
  startAgentsNudgeTurn,
  type ActiveSubagentCount,
  type AgentsNudgeState,
  type DelegationState
} from './agentStatus.ts'
import { diffStats, type DiffStats } from './diff.ts'
import { DEFAULT_BUSY_INPUT_MODE, queueAccepts, type BusyInputMode } from './busyQueue.ts'
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
import {
  captureLiveSpawnTree,
  emptySpawnHistory,
  loadSpawnTree,
  SPAWN_HISTORY_LIMIT,
  type SpawnAgentRecord,
  type SpawnHistoryState,
  type SpawnSnapshot
} from './spawnHistory.ts'
import {
  isTerminalStatus,
  keepTerminalElseRunning,
  normalizeTerminalStatus,
  type SubagentStatus
} from './subagentTree.ts'
import { approvalPolicy, type ApprovalChoicePolicy } from './approval.ts'

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
  /** Bounded transient live progress; never replaces durable argsPreview. */
  progressPreview?: string
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
  | { type: 'moa'; id: string; text: string }
  | ToolPartState

export interface Message {
  readonly role: 'user' | 'assistant' | 'system' | 'notification'
  /** Client-only identity for an optimistic composer row. It is never sent to
   * the gateway and lets the submission lease remove exactly that row when a
   * pre-start rejection proves it was never committed to session history. */
  clientId?: string
  /** Correlates a local pending-steer notice with the gateway event that proves
   * the steer was consumed, promoted into a turn, or terminally failed. */
  steerSubmissionId?: string
  /** Visible client-only activity that never enters gateway/SQLite history. */
  localOnly?: 'shell'
  /** Flat body for user/system rows (and settled/resumed assistant rows). */
  text: string
  /** Ordered parts for a live assistant turn; absent for user/system. */
  parts?: Part[]
  streaming?: boolean
  /** Background-activity card payload (role `'notification'` only) — rendered as
   *  an inline NotificationCard instead of a normal role row. */
  notification?: ActivityNotification
  /** Skill-invocation payload (role `'user'` only) — when a skill slash command
   *  (e.g. `/dogfood`) is submitted, the FULL skill body still goes to the model
   *  (it lives in `text`, the API/`/copy` source), but the transcript renders a
   *  COLLAPSED row (`▶ /dogfood · 312 lines`) instead of dumping the whole body.
   *  `command` is the slash invocation as typed (incl. args); `lineCount` is the
   *  body's line count for the header. (glitch 2026-06-23) */
  skill?: { command: string; lineCount: number }
  /** Wall-clock send/receive time in unix SECONDS (matches the server's per-message
   *  `timestamp` key — a sanctioned NON-WIRE field, stripped before the API call).
   *  Rendered as a muted `[HH:MM]` prefix only when /timestamps is ON. Optional:
   *  live rows that lack a stored timestamp NEVER get a fabricated one. */
  timestamp?: number
}

/** An image queued on the gateway for the next prompt, mirrored locally so the
 * composer can render and remove it before submission. The literal token is
 * part of the draft, matching the OpenCode/free-code attachment affordance. */
export interface PendingImageAttachment {
  readonly id: number
  readonly token: string
  readonly path: string
  readonly name?: string
  readonly width?: number
  readonly height?: number
  readonly tokenEstimate?: number
}

/** Local destructive-confirm copy/styling (gateway prompts use their own types). */
export interface ConfirmSpec {
  readonly title: string
  readonly detail?: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly danger?: boolean
}

export type ConfirmRequest = string | ConfirmSpec

/**
 * A BLOCKING interactive request from the agent (spec §8 #6 — unhandled = deadlock).
 * Each is answered via the matching `*.respond` RPC; Esc/Ctrl+C sends deny/empty.
 */
export type ActivePrompt =
  | { kind: 'clarify'; question: string; choices: string[] | null; requestId: string }
  | { kind: 'approval'; allowPermanent: ApprovalChoicePolicy; command: string; description: string }
  | { kind: 'sudo'; requestId: string }
  | { kind: 'secret'; envVar: string; prompt: string; requestId: string }
  // local (non-gateway) Y/N confirm — e.g. /clear, /new (spec §2a)
  | { kind: 'confirm'; spec: ConfirmSpec; onConfirm: () => void }

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
  /** Start the tabbed picker on its combined All page instead of the current
   *  item's group. */
  initialTab?: 'all' | 'current'
  /** Mount immediately, then hydrate rows through the registered refresh seam. */
  initialRefresh?: boolean
  /** Empty-state copy while initial hydration is in flight. */
  loadingLabel?: string
  /** Retryable failure copy after initial hydration fails. */
  errorLabel?: string
}

export interface CustomModelSetupState {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  onSaved: (switchValue: string) => void
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

export interface SubagentOutputEntry {
  isError: boolean
  preview: string
  tool: string
}

/**
 * A delegated subagent in the canonical f7 Ink shape. The gateway speaks
 * snake_case; the reducer maps every known field once into this camelCase
 * model. Trace/thought/lastTool remain as compatibility projections for the
 * existing OpenTUI detail view while the richer dashboard consumes the arrays.
 */
export interface SubagentInfo {
  apiCalls?: number
  childSessionId?: string
  costUsd?: number
  depth: number
  durationSeconds?: number
  filesRead?: string[]
  filesWritten?: string[]
  goal: string
  id: string
  index?: number
  inputTokens?: number
  iteration?: number
  model?: string
  notes?: string[]
  outputTail?: SubagentOutputEntry[]
  outputTokens?: number
  parentId?: null | string
  reasoningTokens?: number
  startedAt?: number
  status: string
  summary?: string
  taskCount?: number
  thinking?: string[]
  toolCount?: number
  tools?: string[]
  toolsets?: string[]
  lastTool?: string
  /** Live activity trace (item 15) — typed entries, newest last; rendered by kind. */
  trace?: TraceEntry[]
  /** Latest thinking text (transient; not appended to the trace to avoid flooding). */
  thought?: string
}

/** Cap on a subagent's retained trace lines. */
const SUBAGENT_TRACE_LIMIT = 200
const SUBAGENT_THINKING_LIMIT = 6
const SUBAGENT_NOTES_LIMIT = 6
const SUBAGENT_TOOLS_LIMIT = 8
const MOA_REFERENCE_LIMIT = 16
const MOA_REFERENCE_TEXT_LIMIT = 8_192
const MOA_TURN_TEXT_LIMIT = 65_536
const MOA_STORE_TEXT_LIMIT = 524_288
const TOOL_PROGRESS_LIMIT = 512

/** Transport-free persistence request emitted alongside an in-memory archive.
 * The entry layer drains this bounded FIFO and performs `spawn_tree.save`; the
 * reducer itself never owns or awaits a gateway. Times match that RPC (seconds). */
export interface SpawnTreeSaveIntent {
  readonly snapshotId: string
  readonly request: {
    readonly finished_at: number
    readonly label: string
    readonly session_id: string
    readonly started_at: null | number
    readonly subagents: readonly SpawnAgentRecord[]
  }
}

export interface AgentsDashboardDiffPair {
  readonly baseline: SpawnSnapshot
  readonly candidate: SpawnSnapshot
}

export interface AgentsDashboardOpenOptions {
  readonly agentId?: string
  readonly diffPair?: AgentsDashboardDiffPair
  /** 0 = live; N = Nth newest process-global archive. */
  readonly initialHistoryIndex?: number
}

function epochMilliseconds(value: number): number {
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value
}

function pushUniqueBounded(values: string[], value: string, limit: number): void {
  if (!value || values.at(-1) === value) return
  values.push(value)
  if (values.length > limit) values.splice(0, values.length - limit)
}

function formatSubagentTool(name: string, preview: string): string {
  const label =
    name
      .split('_')
      .filter(Boolean)
      .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(' ') || name
  const compact = preview.replace(/\s+/g, ' ').trim()
  const bounded = compact.length > 64 ? `${compact.slice(0, 63)}…` : compact
  return bounded ? `${label}("${bounded}")` : label
}

function makeSubagent(payload: SpawnTreeSubagent, id: string, status: SubagentStatus): SubagentInfo {
  const subagent: SubagentInfo = {
    depth: payload.depth ?? 0,
    goal: payload.goal ?? '',
    id,
    index: payload.task_index ?? 0,
    notes: [],
    parentId: payload.parent_id ?? null,
    startedAt: payload.started_at === undefined ? Date.now() : epochMilliseconds(payload.started_at),
    status,
    taskCount: payload.task_count ?? 1,
    thinking: [],
    toolCount: payload.tool_count ?? 0,
    tools: [],
    trace: []
  }
  mergeSubagentPayload(subagent, payload)
  return subagent
}

/** Map every known rich snake_case field without erasing values omitted by a
 * partial streaming event. Event-specific activity/status changes are applied
 * after this shared projection. */
function mergeSubagentPayload(subagent: SubagentInfo, payload: SpawnTreeSubagent): void {
  if (payload.api_calls !== undefined) subagent.apiCalls = payload.api_calls
  if (payload.child_session_id !== undefined) subagent.childSessionId = payload.child_session_id
  if (payload.cost_usd !== undefined) subagent.costUsd = payload.cost_usd
  if (payload.depth !== undefined) subagent.depth = payload.depth
  if (payload.duration_seconds !== undefined) subagent.durationSeconds = payload.duration_seconds
  if (payload.files_read !== undefined) subagent.filesRead = [...payload.files_read]
  if (payload.files_written !== undefined) subagent.filesWritten = [...payload.files_written]
  if (payload.goal) subagent.goal = payload.goal
  if (payload.input_tokens !== undefined) subagent.inputTokens = payload.input_tokens
  if (payload.iteration !== undefined) subagent.iteration = payload.iteration
  if (typeof payload.model === 'string') subagent.model = payload.model
  if (payload.notes !== undefined) subagent.notes = [...payload.notes].slice(-SUBAGENT_NOTES_LIMIT)
  if (payload.output_tail !== undefined) {
    subagent.outputTail = payload.output_tail.map(entry => ({
      isError: entry.is_error === true,
      preview: entry.preview ?? '',
      tool: entry.tool ?? 'tool'
    }))
  }
  if (payload.output_tokens !== undefined) subagent.outputTokens = payload.output_tokens
  if (payload.parent_id !== undefined) subagent.parentId = payload.parent_id
  if (payload.reasoning_tokens !== undefined) subagent.reasoningTokens = payload.reasoning_tokens
  if (payload.started_at !== undefined) subagent.startedAt = epochMilliseconds(payload.started_at)
  if (payload.summary !== undefined) subagent.summary = payload.summary
  if (payload.task_count !== undefined) subagent.taskCount = payload.task_count
  if (payload.task_index !== undefined) subagent.index = payload.task_index
  if (payload.thinking !== undefined) subagent.thinking = [...payload.thinking].slice(-SUBAGENT_THINKING_LIMIT)
  if (payload.tool_count !== undefined) subagent.toolCount = payload.tool_count
  if (payload.tools !== undefined) subagent.tools = [...payload.tools].slice(-SUBAGENT_TOOLS_LIMIT)
  if (payload.toolsets !== undefined) subagent.toolsets = [...payload.toolsets]
  const lastTool = payload.last_tool ?? payload.tool_name
  if (lastTool !== undefined) subagent.lastTool = lastTool
}

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
  /** First-class project resolved by the gateway for the active cwd. `null`
   *  deliberately clears a prior project when the session changes workspace. */
  projectName?: string | null
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
  /** Registry-backed background delegation count. Presence is authoritative,
   *  including zero; local live rows are only a compatibility fallback. */
  activeSubagents?: number
  /** Commits behind the remote (`update_behind`) — null/absent until the async
   *  update check resolves; >0 drives the transient update notice in the bar. */
  updateBehind?: number
  /** The recommended update command (`update_command`), paired with updateBehind. */
  updateCommand?: string
  /** Active profile name (`profile_name`); the bar badges it when non-default. */
  profileName?: string
  /** Count of connected MCP servers from `session.info`; the status bar uses
   *  this only as a fallback until the enabled startup catalog is available. */
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
  readonly readiness: {
    readonly status: 'ready' | 'pending' | 'failed'
    readonly warning: string | undefined
    readonly retryAfterMs: number | undefined
  }
}

/** Bounded server-directed retry for a catalog whose authoritative agent build
 * is still pending. Ready/failed/legacy responses stop; malformed delays never
 * create a hot loop. */
export function startupCatalogRetryDelay(catalog: Catalog | undefined): number | undefined {
  if (catalog?.readiness.status !== 'pending') return undefined
  const raw = catalog.readiness.retryAfterMs
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined
  return Math.max(250, Math.min(30_000, Math.trunc(raw)))
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
  /** Images queued for this session's next prompt. Session-owned: never carry
   * them across clear/new/resume boundaries. */
  pendingImages: PendingImageAttachment[]
  /** Monotonic imperative-clear signal for Ctrl+C. The native textarea is
   * uncontrolled, so changing only composerDraft would leave visible bytes. */
  composerClearVersion: number
  /** Monotonic imperative-replace signal for `/undo` and dispatch `prefill`
   * responses. The mounted native textarea observes it and adopts composerDraft. */
  composerReplaceVersion: number
  /** The latest todo-tool snapshot, captured from every `todo` tool.complete
   *  REGARDLESS of HERMES_TUI_TOOL_OUTPUTS (the pinned TodoPanel is a live
   *  tracker, not a tool body). undefined until the agent first calls `todo`. */
  latestTodos: TodoSnapshot | undefined
  /** The open pager overlay (replaces the transcript while set); undefined when none. */
  pager: PagerState | undefined
  /** The open resume picker (replaces the composer while set); undefined when none. */
  sessionPicker: SessionPickerOverlay | undefined
  /** Process-global attachable sessions in this gateway. Updated by the
   * single-flight active-session poll; survives session-owned resets. */
  liveSessionCount: number
  /** Last decoded active-list snapshot, shared by chrome and the Sessions
   * orchestrator so opening the overlay does not add a duplicate poller. */
  liveSessions: readonly ActiveItem[]
  /** The open generic picker (model/skills/…); undefined when none. */
  picker: PickerState | undefined
  /** Staged local/custom-provider setup launched from /model. */
  customModelSetup: CustomModelSetupState | undefined
  /** Whether the Esc+Esc session prompt-history viewer is open (Epic 5). */
  promptHistory: boolean
  /** Live completion candidates (slash-name/args or file/@-mention) shown above the composer. */
  completions: CompletionItem[] | undefined
  /** Char offset in the input where an accepted completion should start replacing
   *  (gateway `replace_from` for slash args; the path-token start for @-mentions). */
  completionFrom: number
  /** Delegated subagents (from `subagent.*`), shown in the agents dashboard. */
  subagents: SubagentInfo[]
  /** Process-global newest-first in-memory archives (Ink `/replay` parity). */
  spawnHistory: SpawnHistoryState
  /** Process-global bounded persistence FIFO; drained outside the reducer and
   *  retained across adoption until a definitive ACK/failure settles it. */
  spawnTreeSaveIntents: SpawnTreeSaveIntent[]
  /** Once-per-turn `/agents` discovery state + pending render decision. */
  agentsNudge: AgentsNudgeState
  agentsNudgePending: boolean
  /** Process-global delegation pause/cap state hydrated from control RPCs. */
  delegation: DelegationState
  /** Whether the agents dashboard overlay is open (/agents). */
  dashboard: boolean
  /** Subagent id the dashboard should preselect on open (tray Enter — Epic 2.7). */
  dashboardAgent: string | undefined
  /** Initial replay cursor captured at overlay-open time (0 = live). */
  dashboardHistoryIndex: number
  /** Optional semantic replay pair; owned here so slash dispatch can open it. */
  dashboardDiffPair: AgentsDashboardDiffPair | undefined
  /** Whether the OS background-process panel overlay is open (/processes). */
  backgroundPanel: boolean
  /** Whether the learning Journey timeline overlay is open. */
  journey: boolean
  /** Whether the interactive Plugins Hub is open. */
  pluginsHub: boolean
  /** Whether the searchable Pet gallery is open. */
  petPicker: boolean
  /** The open /topup overlay (full-screen modal; undefined when closed). */
  billing: BillingOverlayState | undefined
  /** The open /subscription plan-management overlay. */
  subscription: SubscriptionOverlayState | undefined
  /** OS background processes (from `agents.list`) — shown in the /processes panel. */
  backgroundProcesses: BackgroundProcess[]
  /** In-flight background-PROMPT task ids (`/bg` → `prompt.background`, cleared on
   *  `background.complete`) — drives the `bg: N` status-bar badge. */
  bgTasks: string[]
  /** Process-global voice-mode chrome. */
  voice: VoiceState
  /** Process-global browser connection/progress chrome. */
  browser: BrowserState
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
  /** Prompts submitted while a turn is running (info.running) — queued here and
   *  drained one-per-turn-completion by the entry's onTurnComplete drain. NOT the
   *  transcript. */
  queuedPrompts: string[]
  /** Queue row currently loaded into the composer for edit/send/delete. */
  queueEditIndex: number | undefined
  /** Live session chrome for the status bar (model/effort/cwd/branch/context/running). */
  info: SessionInfo
  /** Transient hint shown above the composer (e.g. "Ctrl+C again to quit" — item 11);
   *  takes visual priority over the busy `status` face. Undefined when none. */
  hint: string | undefined
  /** Startup tools/skills/MCP catalog (from `startup.catalog`) for the home panel (item 9). */
  catalog: Catalog | undefined
  /** Cached, Effect-decoded slash catalog. `/help` reads this synchronously,
   *  matching Ink's post-ready catalog hydration instead of refetching on every
   *  invocation. Process-global command metadata survives session switches. */
  commandCatalog: CommandsCatalogResponse | undefined
  /** Cached `/model` picker rows (mapped `model.options`). Prefetched at session
   *  bootstrap and refreshed after a switch, so `/model` opens INSTANTLY from
   *  memory instead of awaiting the slow RPC (it does network calls: pricing
   *  fetch + Nous tier check) on every open (Epic 7). */
  modelItems: PickerItem[] | undefined
  /** The current session id (shown in the home panel; updated on create/resume). */
  sessionId: string | undefined
  /** Persisted DB/session key used only for resume sidecars and crash recovery. */
  resumeId: string | undefined
  // ── display flags (utility commands — Epic 3) ────────────────────────────
  /** Compact transcript (/compact): collapses the blank line between turns/parts.
   *  Defaults OFF — the persisted `display.tui_compact` config doesn't reach the
   *  TUI via session.info, so the flag starts false each launch. */
  compact: boolean
  /** Global tool/reasoning detail mode (/details): collapsed (default) /
   *  expanded (bodies default-open) / hidden (runs fold to one muted line). */
  details: DetailsMode
  detailsCommandOverride: boolean
  detailsSections: DetailsSections
  /** Show a muted `[HH:MM]` time next to each transcript message that carries a
   *  stored unix `timestamp` (/timestamps — port of upstream 5ff11a689). Defaults
   *  OFF; like `compact`, the persisted pref doesn't reach the TUI via session.info,
   *  so it starts false each launch. */
  timestamps: boolean
  /** /reasoning full — expand ALL thinking ("Thinking"/"Thought") sections to show
   *  their full body, independently of the global /details mode. Defaults OFF;
   *  bare `/reasoning` syncs it from the persisted `display.reasoning_full` (via
   *  config.get), so it reflects the saved pref on first invocation. */
  reasoningFull: boolean
  /** Persisted display.busy_input_mode mirrored into the live submit policy. */
  busyInputMode: BusyInputMode
}

export interface VoiceState {
  enabled: boolean
  tts: boolean
  recording: boolean
  processing: boolean
  recordKey: string
}

export interface BrowserState {
  connected: boolean
  url?: string
  lastProgress?: string
}

const LRU_LIMIT = 1000

/** Read a string field off an unknown payload record (no `any`, no cast). */
function readStr(payload: { readonly [k: string]: unknown }, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' ? v : undefined
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
function readInfoPatch(payload: object): Partial<SessionInfo> {
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
  if (d.project !== undefined) patch.projectName = d.project?.name.trim() || null
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
  const activeSubagents = d.usage?.active_subagents ?? d.active_subagents
  if (activeSubagents !== undefined) patch.activeSubagents = activeSubagents
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
  const warning = d.readiness?.warning?.trim()
  return {
    mcp: { servers: onlyStrings(d.mcp?.servers) },
    readiness: {
      status: d.readiness?.status ?? 'ready',
      retryAfterMs: d.readiness?.retry_after_ms,
      warning: warning || undefined
    },
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
    pendingImages: [],
    composerClearVersion: 0,
    composerReplaceVersion: 0,
    latestTodos: undefined,
    pager: undefined,
    sessionPicker: undefined,
    liveSessionCount: 0,
    liveSessions: [],
    picker: undefined,
    customModelSetup: undefined,
    promptHistory: false,
    completions: undefined,
    completionFrom: 0,
    subagents: [],
    spawnHistory: emptySpawnHistory(),
    spawnTreeSaveIntents: [],
    agentsNudge: createAgentsNudgeState(),
    agentsNudgePending: false,
    delegation: createDelegationState(),
    dashboard: false,
    dashboardAgent: undefined,
    dashboardHistoryIndex: 0,
    journey: false,
    pluginsHub: false,
    petPicker: false,
    dashboardDiffPair: undefined,
    backgroundPanel: false,
    billing: undefined,
    subscription: undefined,
    backgroundProcesses: [],
    bgTasks: [],
    voice: { enabled: false, tts: false, recording: false, processing: false, recordKey: 'ctrl+b' },
    browser: { connected: false },
    lastNotification: undefined,
    notice: null,
    pendingNotice: null,
    queuedPrompts: [],
    queueEditIndex: undefined,
    status: undefined,
    // startedAt is set ONCE here (store creation ≈ session start) — the status
    // bar's session-duration segment ticks from it; wire patches never carry it.
    info: { startedAt: Date.now() },
    hint: undefined,
    catalog: undefined,
    commandCatalog: undefined,
    modelItems: undefined,
    sessionId: undefined,
    resumeId: undefined,
    compact: false,
    details: 'collapsed',
    detailsCommandOverride: false,
    detailsSections: {},
    timestamps: false,
    reasoningFull: false,
    busyInputMode: DEFAULT_BUSY_INPUT_MODE
  })

  // Monotonic part id (stable `key` per part so a new tool part below a streaming
  // text part doesn't remount/re-tokenize it).
  let partSeq = 0
  const nextId = () => `p${++partSeq}`
  let clientMessageSeq = 0
  const nextClientMessageId = () => `u${++clientMessageSeq}`

  // LRU id-dedup: events that carry a stable id are applied at most once.
  const applied = new Set<string>()
  // A completion can race ahead of the session.steer RPC response on separate
  // gateway threads. Remember recent acknowledgements so a late local notice
  // cannot be inserted after its authoritative removal event already passed.
  const settledSteerSubmissionIds = new Set<string>()
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

  // External side effects (currently the billing device-flow browser opener)
  // must happen only after an event is COMMITTED to the active session. Calling
  // this from applyNow means buffered resume events wait for commit/abort
  // filtering; a rejected stale-SID event can never open a URL or print copy.
  let onCommittedEvent: ((event: GatewayEvent) => void) | undefined

  function registerCommittedEventHandler(handler: (event: GatewayEvent) => void): void {
    onCommittedEvent = handler
  }

  // Chrome-notice TTL timer (NOT store state — a transient handle, not reactive
  // data). At most ONE armed at a time: every applyNotice clears the prior before
  // arming a new one (latest-wins), and the callback nulls it on fire. Mirrors the
  // Ink turnController's single `noticeTimer` handle.
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let statusRestoreTimer: ReturnType<typeof setTimeout> | undefined
  let lastStatusNote = ''

  function clearStatusRestoreTimer(): void {
    if (statusRestoreTimer) clearTimeout(statusRestoreTimer)
    statusRestoreTimer = undefined
  }

  function scheduleStatusRestore(delayMs: number): void {
    clearStatusRestoreTimer()
    statusRestoreTimer = setTimeout(() => {
      statusRestoreTimer = undefined
      setState('status', undefined)
    }, delayMs)
    statusRestoreTimer.unref()
  }

  // Anti-flood for gateway.stderr. `/logs` reads the authoritative transport
  // ring from GatewayService; the store retains only a short startup-failure
  // tail so stderr never floods the transcript or holds an unbounded line.
  const STDERR_RING_LIMIT = 20
  const STDERR_LINE_LIMIT = 4096
  const STDERR_TRUNCATED_SUFFIX = '… [truncated]'
  const STDERR_TAIL = 5
  const stderrRing: string[] = []
  function pushStderr(line: string): void {
    const bounded =
      line.length <= STDERR_LINE_LIMIT
        ? line
        : `${line.slice(0, STDERR_LINE_LIMIT - STDERR_TRUNCATED_SUFFIX.length)}${STDERR_TRUNCATED_SUFFIX}`
    stderrRing.push(bounded)
    if (stderrRing.length > STDERR_RING_LIMIT) stderrRing.splice(0, stderrRing.length - STDERR_RING_LIMIT)
  }
  function stderrTail(): string {
    return stderrRing.slice(-STDERR_TAIL).join('\n')
  }

  function setSkin(skin: GatewaySkinDecoded | undefined): void {
    setState('theme', themeFromSkin(skin))
  }

  // Trim the transcript to MESSAGE_CAP, dropping the OLDEST non-live rows IN
  // PLACE via `splice` (NOT a `slice`-reassign). A keyed `<For>` keeps rows by
  // item REFERENCE, so splicing unmounts only evicted rows (freeing their Yoga
  // nodes) while survivors keep their refs and are not remounted. Client-local
  // shell/notification rows may follow the live assistant, so explicitly protect
  // the newest streaming turn instead of relying on it being the array tail.
  function capMessages(draft: StoreState): void {
    const overflow = draft.messages.length - MESSAGE_CAP
    if (overflow > 0) {
      let protectedIndex = -1
      for (let index = draft.messages.length - 1; index >= 0; index--) {
        const message = draft.messages[index]
        if (message?.role === 'assistant' && message.streaming) {
          protectedIndex = index
          break
        }
      }
      for (let remaining = overflow; remaining > 0; remaining--) {
        const removeIndex = protectedIndex === 0 ? 1 : 0
        draft.messages.splice(removeIndex, 1)
        if (protectedIndex > removeIndex) protectedIndex -= 1
      }
      draft.dropped += overflow
    }
  }

  // ── parts helpers (operate on a draft message inside produce) ───────────
  function sameVisibleText(a: string | undefined, b: string | undefined): boolean {
    const left = a?.replace(/\r\n?/gu, '\n').trim() ?? ''
    const right = b?.replace(/\r\n?/gu, '\n').trim() ?? ''
    return !!left && left === right
  }

  function visibleText(message: Message | undefined): string {
    return (message?.parts ?? [])
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('')
  }

  function appendPart(m: Message, type: 'text' | 'reasoning', text: string): void {
    const parts = (m.parts ??= [])
    const last = parts[parts.length - 1]
    if (last && last.type === type) last.text += text
    else parts.push({ type, id: nextId(), text })
  }

  function hasReasoning(message: Message): boolean {
    return (message.parts ?? []).some(part => part.type === 'reasoning' && part.text.trim().length > 0)
  }

  /** Completion/fallback reasoning is authoritative only when no streamed
   * reasoning exists. This preserves one ordered part and prevents duplicate
   * long reasoning bodies from `reasoning.available`/`message.complete`. */
  function appendFallbackReasoning(draft: StoreState, text: string | undefined, answer?: string): void {
    const value = text?.trim()
    if (!value) return
    const assistant = liveAssistant(draft) ?? ensureAssistant(draft)
    const visibleAnswer = (assistant.parts ?? [])
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('')
    if (sameVisibleText(value, answer) || sameVisibleText(value, visibleAnswer)) return
    if (hasReasoning(assistant)) return
    const parts = (assistant.parts ??= [])
    const firstText = parts.findIndex(part => part.type === 'text')
    parts.splice(firstText < 0 ? parts.length : firstText, 0, { type: 'reasoning', id: nextId(), text: value })
  }

  function dropAnswerDuplicateReasoning(message: Message, answer: string | undefined): void {
    if (!answer || !message.parts) return
    for (let index = message.parts.length - 1; index >= 0; index--) {
      const part = message.parts[index]
      if (part?.type === 'reasoning' && sameVisibleText(part.text, answer)) {
        message.parts.splice(index, 1)
      }
    }
  }
  /** Reconcile the server's authoritative final text without duplicating
   * streamed segments. Prefix-compatible finals only append their unseen tail;
   * corrected finals collapse prior text parts into one final part at the last
   * text position while preserving every reasoning/tool/MoA part and its order. */
  function reconcileFinalText(message: Message, finalText: string | undefined): void {
    const final = finalText?.trim()
    if (!final) return
    const parts = (message.parts ??= [])
    const textIndexes: number[] = []
    let streamed = ''
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      if (part?.type !== 'text') continue
      textIndexes.push(index)
      streamed += part.text
    }
    if (!textIndexes.length) {
      parts.push({ type: 'text', id: nextId(), text: final })
      return
    }
    if (final === streamed) return
    if (final.startsWith(streamed)) {
      const last = parts[textIndexes[textIndexes.length - 1] ?? -1]
      if (last?.type === 'text') last.text += final.slice(streamed.length)
      return
    }
    const lastIndex = textIndexes[textIndexes.length - 1]
    const last = lastIndex === undefined ? undefined : parts[lastIndex]
    if (!last || last.type !== 'text') return
    last.text = final
    for (let index = textIndexes.length - 2; index >= 0; index--) {
      const removeAt = textIndexes[index]
      if (removeAt !== undefined) parts.splice(removeAt, 1)
    }
  }

  function findRunningToolByName(draft: StoreState, name: string): ToolPartState | undefined {
    const parts = liveAssistant(draft)?.parts
    if (!parts) return undefined
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index]
      if (part?.type === 'tool' && part.state === 'running' && part.name === name) return part
    }
    return undefined
  }

  /** The newest assistant message, optionally only when still streaming.
   *
   * Client-local transcript rows (shell commands/output, slash feedback, and
   * background notification cards) may be appended while a model turn is still
   * streaming. The assistant therefore is not guaranteed to be the array tail.
   * Walk backward to preserve the one live turn's identity across those rows;
   * callers then update that same message instead of dropping deltas or creating
   * a second orphan assistant. */
  function liveAssistant(draft: StoreState, streamingOnly = false): Message | undefined {
    for (let index = draft.messages.length - 1; index >= 0; index--) {
      const message = draft.messages[index]
      if (message?.role === 'assistant' && (!streamingOnly || message.streaming)) return message
    }
    return undefined
  }

  /** Settle a turn that ended without message.complete. Empty native caret rows
   * are removed; partial/tool content remains visible but no longer streams. */
  function settleFailedAssistant(draft: StoreState): void {
    for (let index = draft.messages.length - 1; index >= 0; index--) {
      const message = draft.messages[index]
      if (message?.role !== 'assistant' || !message.streaming) continue
      const hasParts = (message.parts?.length ?? 0) > 0
      if (!message.text && !hasParts) draft.messages.splice(index, 1)
      else message.streaming = false
      break
    }
  }

  /** Ensure there's an open assistant turn to attach parts to (tool/reasoning). */
  function ensureAssistant(draft: StoreState): Message {
    const live = liveAssistant(draft, true)
    if (live) return live
    const created: Message = {
      role: 'assistant',
      text: '',
      parts: [],
      streaming: true,
      timestamp: Math.floor(Date.now() / 1000)
    }
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
    const clientId = nextClientMessageId()
    setState(
      produce(draft => {
        // Stamp the user turn with wall-clock send time (unix SECONDS — matches the
        // server's non-wire `timestamp` key) so /timestamps can render [HH:MM].
        draft.messages.push({ clientId, role: 'user', text, timestamp: Math.floor(Date.now() / 1000) })
        capMessages(draft)
      })
    )
    return clientId
  }

  function pushLocalUser(text: string, localOnly: 'shell') {
    const clientId = nextClientMessageId()
    setState(
      produce(draft => {
        draft.messages.push({
          clientId,
          localOnly,
          role: 'user',
          text,
          timestamp: Math.floor(Date.now() / 1000)
        })
        capMessages(draft)
      })
    )
    return clientId
  }

  /** Push a SKILL invocation as a user row that renders COLLAPSED (the full body
   *  stays in `text` for the API/copy, but the transcript shows `▶ /name · N
   *  lines` instead of dumping the whole skill body). `command` is the slash
   *  invocation as typed (incl. args); `body` is the full skill content that the
   *  caller ALSO sends to the model via prompt.submit. (glitch 2026-06-23) */
  function pushSkill(command: string, body: string) {
    const clientId = nextClientMessageId()
    const lineCount = body ? body.split('\n').length : 0
    setState(
      produce(draft => {
        draft.messages.push({
          clientId,
          role: 'user',
          text: body,
          skill: { command, lineCount },
          timestamp: Math.floor(Date.now() / 1000)
        })
        capMessages(draft)
      })
    )
    return clientId
  }

  /** Remove one still-optimistic user row without touching later local chrome
   * or the previous committed exchange. Returns false after a snapshot/cap has
   * already removed it, which is harmless and keeps the operation idempotent. */
  function removeClientMessage(clientId: string): boolean {
    const index = state.messages.findIndex(message => message.clientId === clientId)
    if (index < 0) return false
    setState(
      'messages',
      state.messages.filter(message => message.clientId !== clientId)
    )
    return true
  }

  /** Push a pending direct-steer notice. Unlike ordinary slash output, this is
   * removed only by an authoritative gateway correlation id. */
  function pushPendingSteer(clientSubmissionId: string, text: string) {
    if (settledSteerSubmissionIds.has(clientSubmissionId)) return
    const clean = stripAnsi(text)
    setState(
      produce(draft => {
        draft.messages.push({ role: 'system', steerSubmissionId: clientSubmissionId, text: clean })
        capMessages(draft)
      })
    )
  }

  function settlePendingSteers(clientSubmissionIds: readonly string[] | undefined) {
    if (!clientSubmissionIds?.length) return
    for (const id of clientSubmissionIds) {
      settledSteerSubmissionIds.add(id)
      if (settledSteerSubmissionIds.size > LRU_LIMIT) {
        const oldest = settledSteerSubmissionIds.values().next()
        if (!oldest.done) settledSteerSubmissionIds.delete(oldest.value)
      }
    }
    const settled = new Set(clientSubmissionIds)
    setState(
      'messages',
      state.messages.filter(message => !message.steerSubmissionId || !settled.has(message.steerSubmissionId))
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

  // ── client busy queue (transport-free) ───────────────────────────────────
  // A prompt submitted while a turn runs can't go straight to the gateway (the
  // server rejects with 4009 "session busy"), so the entry's submit-guard parks
  // it here and the entry drains one per turn-completion via the registered
  // onTurnComplete handler below. The store NEVER touches the gateway — it only
  // owns the FIFO queue + the completion hook.
  let onTurnComplete: (() => void) | undefined

  // The drain fires on the SERVER-confirmed end of a turn — the running
  // true→false edge in a `session.info` (see applyInfo). It does NOT fire on
  // `message.complete`: the gateway emits message.complete BEFORE it clears its
  // server-side `running` flag (server.py emits complete at ~7076 but only sets
  // session["running"]=False in the finally block at ~7224, after the
  // /goal-continuation hook), so draining there races a still-busy session →
  // 4009 bounces + duplicate submits. message.complete STILL flips info.running
  // false LOCALLY (optimistic UI — the spinner must stop instantly; see
  // statusLineSpinner.test.tsx), which means by the time the server's
  // session.info(running:false) lands, state.info.running is ALREADY false and a
  // naive wasRunning-edge would never see the true→false transition. So we track
  // turn-in-flight SEPARATELY from the optimistic UI flag: message.start arms it,
  // and applyInfo disarms+drains on the server's session.info(running:false). The
  // server reliably emits that session.info in run()'s finally (server.py ~7227)
  // after EVERY turn (success/error/interrupt), so the drain always fires once.
  let turnInFlight = false
  // The latest interim assistant text part identifies the provisional answer
  // that message.complete may settle in place when response_previewed is true.
  let interimTextPartId: string | undefined

  // Separate from `turnInFlight`: message.complete optimistically settles the
  // UI before the authoritative session.info(false), so a child exit in that
  // gap must not archive the same turn twice. message.start re-opens the slot.
  let agentsTurnArchived = true

  function saveIntentFor(snapshot: SpawnSnapshot): SpawnTreeSaveIntent {
    return {
      snapshotId: snapshot.id,
      request: {
        finished_at: snapshot.finishedAtMs / 1000,
        label: snapshot.label.slice(0, 120),
        session_id: snapshot.sessionId ?? 'default',
        started_at: snapshot.startedAtMs / 1000,
        subagents: snapshot.subagents
      }
    }
  }

  /** Archive terminal rows synchronously before clearing. Active background
   * rows may survive a parent turn boundary; hard session/gateway boundaries
   * still clear the entire tree. Persistence remains a bounded process-global
   * delivery intent so adoption cannot drop a captured tree. */
  function archiveAndClearSubagents(capture: boolean, preserveActive = false): SpawnSnapshot | null {
    const archivedRows = preserveActive ? state.subagents.filter(sa => isTerminalStatus(sa.status)) : state.subagents
    let snapshot: SpawnSnapshot | null = null
    if (capture && archivedRows.length > 0) {
      const captured = captureLiveSpawnTree(state.spawnHistory, archivedRows, {
        sessionId: state.sessionId ?? null
      })
      snapshot = captured.snapshot
      if (snapshot) {
        setState('spawnHistory', captured.state)
        const intent = saveIntentFor(snapshot)
        setState('spawnTreeSaveIntents', previous => [...previous, intent].slice(-SPAWN_HISTORY_LIMIT))
      }
    }
    if (state.subagents.length > 0) {
      setState('subagents', preserveActive ? current => current.filter(sa => !isTerminalStatus(sa.status)) : [])
    }
    setState('agentsNudge', current => clearAgentsNudgeTurn(current))
    setState('agentsNudgePending', false)
    return snapshot
  }

  function maybeQueueAgentsNudge(): void {
    const turnId = state.agentsNudge.activeTurnId
    if (turnId === null) return
    const decision = considerAgentsNudge(state.agentsNudge, { overlayOpen: state.dashboard, turnId })
    if (decision.state !== state.agentsNudge) setState('agentsNudge', decision.state)
    if (decision.shouldNudge) setState('agentsNudgePending', true)
  }

  function configureAgentsNudge(value: unknown): void {
    setState('agentsNudge', current => configureAgentsNudgeState(current, value))
    if (value === false) setState('agentsNudgePending', false)
  }

  function consumeAgentsNudge(): boolean {
    if (!state.agentsNudgePending) return false
    setState('agentsNudgePending', false)
    return true
  }

  function activeSubagentCount(): ActiveSubagentCount {
    return resolveActiveSubagentCount(state.info.activeSubagents, state.subagents)
  }

  function nextSpawnTreeSaveIntent(): SpawnTreeSaveIntent | undefined {
    return state.spawnTreeSaveIntents[0]
  }

  /** Remove an intent only after the entry layer has a definitive outcome.
   * Ambiguous transport failures leave it queued for an explicit retry. */
  function settleSpawnTreeSaveIntent(snapshotId: string): boolean {
    if (!state.spawnTreeSaveIntents.some(intent => intent.snapshotId === snapshotId)) return false
    setState('spawnTreeSaveIntents', previous => previous.filter(intent => intent.snapshotId !== snapshotId))
    return true
  }

  /** Decode and ingest one `spawn_tree.load` result without touching live rows. */
  function loadSpawnTreeSnapshot(payload: unknown, path?: string): SpawnSnapshot | null {
    const decoded = decodeSpawnTreeLoadResponse(payload)
    if (Option.isNone(decoded)) return null
    const loaded = loadSpawnTree(state.spawnHistory, decoded.value, path === undefined ? {} : { path })
    if (loaded.snapshot) setState('spawnHistory', loaded.state)
    return loaded.snapshot
  }

  /** Register the drain callback the entry runs once per server-confirmed
   *  turn-completion (the entry owns the gateway; the store stays transport-free). */
  function registerTurnCompleteHandler(fn: () => void): void {
    onTurnComplete = fn
  }

  /** Park a prompt at the FIFO tail (or head for a queue-edit fallback).
   * Returns false when the explicit memory ceiling would be exceeded. */
  function enqueuePrompt(text: string, front = false): boolean {
    if (!text || !queueAccepts(state.queuedPrompts, text)) return false
    setState('queuedPrompts', prev => (front ? [text, ...prev] : [...prev, text]))
    if (front && state.queueEditIndex !== undefined) {
      setState('queueEditIndex', state.queueEditIndex + 1)
    }
    return true
  }

  /** Pop the FIFO head (oldest queued prompt) and remove it; undefined if empty. */
  function dequeuePrompt(): string | undefined {
    const head = state.queuedPrompts[0]
    if (head === undefined) return undefined
    setState('queuedPrompts', prev => prev.slice(1))
    if (state.queueEditIndex !== undefined) {
      setState('queueEditIndex', index => (index === undefined || index === 0 ? undefined : index - 1))
    }
    return head
  }

  /** Remove one queued row and return it. Indices outside the live queue are inert. */
  function removeQueuedPrompt(index: number): string | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.queuedPrompts.length) return undefined
    const removed = state.queuedPrompts[index]
    setState('queuedPrompts', prev => prev.filter((_, row) => row !== index))
    setState('queueEditIndex', current => {
      if (current === undefined || current === index) return undefined
      return current > index ? current - 1 : current
    })
    return removed
  }

  /** Replace an edited queue row without weakening the queue's memory ceiling. */
  function replaceQueuedPrompt(index: number, text: string): boolean {
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.queuedPrompts.length || !text) return false
    if (!queueAccepts(state.queuedPrompts, text, index)) return false
    setState('queuedPrompts', index, text)
    return true
  }

  function setQueueEditIndex(index: number | undefined): void {
    if (index === undefined) {
      setState('queueEditIndex', undefined)
      return
    }
    if (Number.isSafeInteger(index) && index >= 0 && index < state.queuedPrompts.length) {
      setState('queueEditIndex', index)
    }
  }

  /** Drop every queued prompt (e.g. /clear, /new). */
  function clearQueue(): void {
    setState('queuedPrompts', [])
    setState('queueEditIndex', undefined)
  }

  /** How many prompts are currently queued. */
  function queuedCount(): number {
    return state.queuedPrompts.length
  }

  /** Clear the transcript (e.g. /clear, /new) and any tracked subagents. */
  function clearTranscript() {
    setState('messages', [])
    archiveAndClearSubagents(false)
    agentsTurnArchived = true
    setState('dropped', 0)
    // A fresh session has no plan — drop the pinned todo panel's snapshot.
    setState('latestTodos', undefined)
    // Drop the dedup history too — a fresh transcript should re-process any id.
    applied.clear()
    // A chrome notice must not survive a transcript reset (new session context).
    clearNoticeState()
    // A fresh session must not carry over prompts queued against the OLD turn —
    // they'd drain into the new session's first completion (cross-session bleed).
    clearQueue()
    // Disarm the busy-queue drain edge: a reset mid-turn must not leave it armed,
    // or the next session.info(running:false) would fire a (harmless, queue-empty)
    // drain attributed to a turn that no longer exists.
    turnInFlight = false
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
        delete info.activeSubagents
      })
    )
  }

  /**
   * Atomically clear every session-owned slice while preserving process/global
   * state (gateway readiness, theme, display preferences, prompt history data,
   * and the OS background-process snapshot). This is the hard boundary used by
   * real session replacement; unlike `clearTranscript`, it must not retain a
   * sparse old `info` field or an overlay/cache tied to the closed session.
   */
  function resetSessionOwnedState(
    sessionId: string | undefined,
    rawInfo?: { readonly [k: string]: unknown },
    snapshot: Message[] = [],
    resumeId: string | undefined = sessionId,
    turnRunning = false,
    startedAtMs: number = Date.now()
  ): void {
    clearStatusRestoreTimer()
    lastStatusNote = ''
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = undefined
    applied.clear()
    buffering = null
    // A live activate/resume can attach after message.start already fired.
    // The snapshot must arm the server-confirmed-idle queue-drain latch.
    turnInFlight = turnRunning
    agentsTurnArchived = true
    const info: SessionInfo = { startedAt: startedAtMs, ...(rawInfo ? readInfoPatch(rawInfo) : {}) }
    const capped = snapshot.length > MESSAGE_CAP ? snapshot.slice(-MESSAGE_CAP) : snapshot

    setState(
      produce(draft => {
        draft.messages = capped
        draft.dropped = snapshot.length - capped.length
        draft.prompt = undefined
        draft.composerDraft = ''
        draft.pendingImages = []
        draft.composerClearVersion += 1
        draft.latestTodos = undefined
        draft.pager = undefined
        draft.sessionPicker = undefined
        draft.picker = undefined
        draft.customModelSetup = undefined
        draft.promptHistory = false
        draft.completions = undefined
        draft.completionFrom = 0
        draft.subagents = []
        draft.agentsNudge = clearAgentsNudgeTurn(draft.agentsNudge)
        draft.agentsNudgePending = false
        draft.dashboard = false
        draft.dashboardAgent = undefined
        draft.journey = false
        draft.pluginsHub = false
        draft.petPicker = false
        draft.dashboardHistoryIndex = 0
        draft.dashboardDiffPair = undefined
        draft.backgroundPanel = false
        draft.billing = undefined
        draft.subscription = undefined
        draft.bgTasks = []
        draft.status = undefined
        draft.lastNotification = undefined
        draft.notice = null
        draft.pendingNotice = null
        draft.queuedPrompts = []
        draft.queueEditIndex = undefined
        draft.info = info
        draft.hint = undefined
        draft.catalog = undefined
        draft.modelItems = undefined
        draft.sessionId = sessionId
        draft.resumeId = resumeId
      })
    )
  }

  /** The prior gateway session was closed; leave an honest no-session UI. */
  function detachSession(): void {
    resetSessionOwnedState(undefined)
  }

  /** Adopt a newly-created live session with REPLACEMENT (not merge) semantics. */
  function adoptFreshSession(
    sessionId: string,
    rawInfo?: { readonly [k: string]: unknown },
    resumeId: string = sessionId
  ): void {
    resetSessionOwnedState(sessionId, rawInfo, [], resumeId)
  }

  /**
   * Atomically adopt a resumed live session, then replay only buffered events
   * that the caller proves belong to that live SID. This prevents coalesced
   * events from the prior session crossing the resume boundary.
   */
  function commitSessionSnapshot(
    sessionId: string,
    snapshot: Message[],
    rawInfo: { readonly [k: string]: unknown } | undefined,
    acceptEvent: (event: GatewayEvent) => boolean,
    resumeId: string = sessionId,
    turnRunning = false,
    startedAtMs: number = Date.now()
  ): void {
    const pending = buffering ?? []
    resetSessionOwnedState(sessionId, rawInfo, snapshot, resumeId, turnRunning, startedAtMs)
    for (const event of pending) if (acceptEvent(event)) applyNow(event)
  }

  /** Cancel a failed resume and replay events buffered for the still-active session. */
  function abortBuffer(acceptEvent: (event: GatewayEvent) => boolean = () => true): void {
    const pending = buffering ?? []
    buffering = null
    for (const event of pending) if (acceptEvent(event)) applyNow(event)
  }

  function isBuffering(): boolean {
    return buffering !== null
  }

  /** Includes the message.complete → server-confirmed-idle settle window. */
  function isTurnInFlight(): boolean {
    return turnInFlight
  }

  /** Open / close the agents dashboard overlay. A string preserves the tray's
   * historical preselect API; slash commands pass replay/diff options. */
  function openDashboard(input?: string | AgentsDashboardOpenOptions) {
    const options: AgentsDashboardOpenOptions = typeof input === 'string' ? { agentId: input } : (input ?? {})
    const rawIndex = options.initialHistoryIndex ?? 0
    const requested = Number.isFinite(rawIndex) ? Math.max(0, Math.floor(rawIndex)) : 0
    setState('dashboardAgent', options.agentId)
    setState('dashboardHistoryIndex', Math.min(requested, state.spawnHistory.snapshots.length))
    setState('dashboardDiffPair', options.diffPair)
    setState('dashboard', true)
    setState('agentsNudgePending', false)
  }
  function closeDashboard() {
    setState('dashboard', false)
    setState('dashboardAgent', undefined)
    setState('dashboardHistoryIndex', 0)
    setState('dashboardDiffPair', undefined)
  }

  function openBackgroundPanel() {
    setState('backgroundPanel', true)
  }
  function openJourney() {
    setState('journey', true)
  }
  function openPluginsHub() {
    setState('pluginsHub', true)
  }
  function closePluginsHub() {
    setState('pluginsHub', false)
  }
  function openPetPicker() {
    setState('petPicker', true)
  }
  function closePetPicker() {
    setState('petPicker', false)
  }

  function closeJourney() {
    setState('journey', false)
  }
  function closeBackgroundPanel() {
    setState('backgroundPanel', false)
  }

  /** Open the /topup overlay with the fetched gateway state + ctx bundle. */
  function openBilling(overlay: BillingOverlayState) {
    setState('billing', overlay)
  }
  function closeBilling() {
    setState('billing', undefined)
  }
  /** Patch the open billing overlay (screen transitions + pending charge). The
   *  overlay is a state machine; the view drives transitions through this. */
  function patchBilling(next: Partial<BillingOverlayState>) {
    if (!state.billing) return
    setState('billing', prev => (prev ? { ...prev, ...next } : prev))
  }
  function openSubscription(overlay: SubscriptionOverlayState) {
    setState('subscription', overlay)
  }
  function closeSubscription() {
    setState('subscription', undefined)
  }
  function patchSubscription(next: Partial<SubscriptionOverlayState>) {
    if (!state.subscription) return
    setState('subscription', prev => (prev ? { ...prev, ...next } : prev))
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
  function setConfirm(request: ConfirmRequest, onConfirm: () => void) {
    const spec = typeof request === 'string' ? { title: request } : request
    setState('prompt', { kind: 'confirm', spec, onConfirm })
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

  function openCustomModelSetup(setup: CustomModelSetupState) {
    setState('customModelSetup', setup)
  }

  function closeCustomModelSetup() {
    setState('customModelSetup', undefined)
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

  function setStatus(text: string | undefined): void {
    setState('status', text)
  }

  /** Merge an authoritative voice.toggle/config response without allowing an
   * older gateway that omits record_key to clobber the cached custom binding. */
  function setVoiceMode(patch: { enabled?: boolean; tts?: boolean; recordKey?: string }): void {
    setState(
      'voice',
      produce(voice => {
        if (patch.enabled !== undefined) voice.enabled = patch.enabled
        if (patch.tts !== undefined) voice.tts = patch.tts
        const key = patch.recordKey?.trim()
        if (key) voice.recordKey = key
        if (patch.enabled === false) {
          voice.recording = false
          voice.processing = false
        }
      })
    )
  }

  /** Optimistic record-key feedback; authoritative voice.status events replace it. */
  function setVoiceActivity(recording: boolean, processing = false): void {
    setState('voice', voice => ({ ...voice, recording, processing }))
  }

  /** Merge browser status without deleting an omitted URL/progress value. */
  function setBrowserState(patch: { connected?: boolean; url?: string; lastProgress?: string }): void {
    setState(
      'browser',
      produce(browser => {
        if (patch.connected !== undefined) browser.connected = patch.connected
        if (patch.url !== undefined) {
          const url = patch.url.trim()
          if (url) browser.url = url
          else delete browser.url
        }
        if (patch.lastProgress !== undefined) {
          const progress = patch.lastProgress.trim()
          if (progress) browser.lastProgress = progress.slice(0, 512)
          else delete browser.lastProgress
        }
        if (patch.connected === false) delete browser.url
      })
    )
  }
  // Per-block copy feedback (design pass piece 2): deep view nodes flash
  // "Copied" on this store's hint line via the notify seam — the same surface
  // the entry's flashHint uses. One live store per app; latest wins.
  registerNotifier(setHint)

  // Config hydration and `/busy` can race during startup. User commands bump
  // this revision; the older hydration applies only if no command superseded it.
  let busyInputModeRevision = 0
  let compactRevision = 0
  let detailsRevision = 0

  /** /compact — set the compact-transcript display flag (Epic 3). */
  function setCompact(on: boolean): void {
    compactRevision += 1
    setState('compact', on)
  }

  function hydrateCompact(on: boolean, expectedRevision: number): boolean {
    if (compactRevision !== expectedRevision) return false
    setState('compact', on)
    return true
  }

  function getCompactRevision(): number {
    return compactRevision
  }

  /** /details — set the global tool/reasoning detail mode (Epic 3). */
  function setDetails(mode: DetailsMode, commandOverride = false): void {
    detailsRevision += 1
    setState(
      produce(draft => {
        draft.details = mode
        draft.detailsCommandOverride = commandOverride
        if (commandOverride) {
          for (const section of ['thinking', 'tools', 'subagents', 'activity'] as const) {
            draft.detailsSections[section] = mode
          }
        }
      })
    )
  }

  function setDetailSection(section: DetailsSection, mode: DetailsMode | null): void {
    detailsRevision += 1
    setState(
      produce(draft => {
        if (mode === null) delete draft.detailsSections[section]
        else draft.detailsSections[section] = mode
      })
    )
  }

  function hydrateDetails(mode: DetailsMode, sections: DetailsSections, expectedRevision: number): boolean {
    if (detailsRevision !== expectedRevision) return false
    setState(
      produce(draft => {
        draft.details = mode
        draft.detailsCommandOverride = false
        draft.detailsSections = { ...sections }
      })
    )
    return true
  }

  function getDetailsRevision(): number {
    return detailsRevision
  }

  /** /timestamps — set the show-[HH:MM] display flag (port of upstream 5ff11a689). */
  function setTimestamps(on: boolean): void {
    setState('timestamps', on)
  }

  /** /reasoning full|clamp — set the expand-all-thinking display flag. */
  function setReasoningFull(on: boolean): void {
    setState('reasoningFull', on)
  }

  /** Decode and merge a successful delegation.status response. */
  function applyDelegationStatusResponse(raw: unknown, updatedAtMs = Date.now()): boolean {
    const decoded = decodeDelegationStatusResponse(raw)
    if (Option.isNone(decoded)) return false
    setState('delegation', current => applyDelegationState(current, decoded.value, updatedAtMs))
    setState(
      produce(draft => {
        for (const payload of decoded.value.active) {
          const id = payload.subagent_id
          const existing = draft.subagents.find(agent => agent.id === id)
          if (existing) {
            mergeSubagentPayload(existing, payload)
            if (!isTerminalStatus(existing.status)) existing.status = 'running'
          } else {
            draft.subagents.push(makeSubagent(payload, id, 'running'))
          }
        }
        draft.subagents.sort((left, right) => left.depth - right.depth || (left.index ?? 0) - (right.index ?? 0))
      })
    )
    return true
  }

  /** Decode and merge a successful delegation.pause response. */
  function applyDelegationPauseResponse(raw: unknown, updatedAtMs = Date.now()): boolean {
    const decoded = decodeDelegationPauseResponse(raw)
    if (Option.isNone(decoded)) return false
    setState('delegation', current => applyDelegationState(current, decoded.value, updatedAtMs))
    return true
  }

  /** Merge a session-info patch into the chrome state (status bar — item 14).
   *  Also the SOLE drain trigger for the busy queue: on a server-confirmed
   *  running true→false edge it fires onTurnComplete (once per turn). See the
   *  turnInFlight comment near onTurnComplete for why this — and not
   *  message.complete — is the correct, race-free drain point. */
  function applyInfo(raw: { readonly [k: string]: unknown }): void {
    const patch = readInfoPatch(raw)
    if (Object.keys(patch).length === 0) return
    setState('info', prev => ({ ...prev, ...patch }))
    if (state.status === 'starting agent…') setState('status', undefined)
    // Drain the busy queue ONLY when the SERVER confirms the turn ended: a
    // session.info carrying running:false while a turn was in flight. We gate on
    // turnInFlight (armed by message.start) rather than the optimistic
    // info.running flag, because message.complete already flipped info.running
    // false locally for instant spinner-stop UX — so by the time this server
    // session.info lands, info.running is already false and a wasRunning-edge
    // would miss it. turnInFlight is the un-optimistically-touched signal. The
    // server emits session.info(running:false) in run()'s finally after EVERY
    // turn (server.py ~7227), AFTER it clears its server-side running flag, so
    // the drained prompt's prompt.submit lands cleanly (no 4009 race). Disarm
    // first so it fires exactly once per turn, never on later idle info patches.
    if (turnInFlight && patch.running === false) {
      turnInFlight = false
      onTurnComplete?.()
    }
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
        settlePendingSteers(event.payload?.client_submission_ids)
        interimTextPartId = undefined
        clearStatusRestoreTimer()
        lastStatusNote = ''
        // A fresh turn gets one discovery credit. Archive terminal rows left by
        // the preceding turn, but retain authoritative running/queued rows: an
        // async delegation may intentionally outlive its dispatching turn.
        archiveAndClearSubagents(true, true)
        agentsTurnArchived = false
        setState('agentsNudge', current => startAgentsNudgeTurn(current))
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
        // Arm the busy-queue drain edge. The drain fires on the server-confirmed
        // running true→false transition in applyInfo (see the turnInFlight
        // comment near onTurnComplete) — NOT on message.complete, which races the
        // server's still-set running flag. message.start is the only arm point.
        turnInFlight = true
        setState(
          produce(draft => {
            draft.messages.push({
              role: 'assistant',
              text: '',
              parts: [],
              streaming: true,
              timestamp: Math.floor(Date.now() / 1000)
            })
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
            const live = liveAssistant(draft, true) ?? ensureAssistant(draft)
            appendPart(live, 'text', text)
          })
        )
        break
      }
      case 'message.interim': {
        const text = event.payload.text.trimStart()
        if (!text) break
        setState(
          produce(draft => {
            const live = liveAssistant(draft, true) ?? ensureAssistant(draft)
            reconcileFinalText(live, text)
            live.streaming = false
            const textParts = (live.parts ?? []).filter(part => part.type === 'text')
            interimTextPartId = textParts.at(-1)?.id
          })
        )
        break
      }
      case 'message.complete':
        settlePendingSteers(event.payload?.client_submission_ids)
        if (event.payload?.reasoning) {
          setState(produce(draft => appendFallbackReasoning(draft, event.payload?.reasoning, event.payload?.text)))
        }
        // Archive BEFORE the normal turn clear. A child exit can still arrive
        // before session.info(false); `agentsTurnArchived` prevents a duplicate.
        archiveAndClearSubagents(!agentsTurnArchived, true)
        agentsTurnArchived = true
        setState(
          produce(draft => {
            // complete-only gateways may send `message.complete{text}` with no prior
            // start/delta → create the turn so the final text isn't dropped.
            const finalText = event.payload?.text
            const interim = interimTextPartId
              ? draft.messages.find(message => message.parts?.some(part => part.id === interimTextPartId))
              : undefined
            const interimText = visibleText(interim).trim()
            const previewMatches = Boolean(
              event.payload?.response_previewed &&
                finalText?.trim() &&
                interimText &&
                finalText.trim().startsWith(interimText)
            )
            const streaming = liveAssistant(draft, true)
            if (previewMatches && streaming && streaming !== interim) {
              const streamingIndex = draft.messages.indexOf(streaming)
              if (streamingIndex >= 0) draft.messages.splice(streamingIndex, 1)
            }
            const live = previewMatches
              ? interim
              : (streaming ?? (finalText ? ensureAssistant(draft) : undefined))
            if (!live) return
            reconcileFinalText(live, finalText)
            live.streaming = false
            dropAnswerDuplicateReasoning(live, finalText)
          })
        )
        interimTextPartId = undefined
        clearStatusRestoreTimer()
        setState('status', undefined)
        // LOCAL optimistic running:false flip — stops the busy spinner INSTANTLY
        // (statusLineSpinner.test.tsx) without waiting for the server's
        // session.info round-trip. NOTE: this does NOT drain the busy queue. The
        // drain fires on the SERVER-confirmed running true→false edge in applyInfo
        // (the session.info the gateway emits in run()'s finally AFTER it clears
        // its server-side running flag) — message.complete arrives BEFORE that
        // flag clears, so draining here would race a still-busy session → 4009
        // bounces + duplicate submits. See the turnInFlight comment near
        // onTurnComplete for the full ordering rationale.
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
      case 'thinking.delta': {
        const text = event.payload?.text ?? ''
        if (text) {
          clearStatusRestoreTimer()
          setState('status', text)
        }
        break
      }
      case 'status.update': {
        const text = event.payload?.text?.trim() ?? ''
        const kind = event.payload?.kind
        if (!text) break
        clearStatusRestoreTimer()
        setState('status', text)
        if (!kind || kind === 'status') break
        if (lastStatusNote !== text) {
          lastStatusNote = text
          pushSystem(text)
        }
        if (kind === 'goal') {
          setState(
            'status',
            text.startsWith('✓')
              ? '✓ goal complete'
              : text.startsWith('↻')
                ? '↻ goal continuing'
                : text.startsWith('⏸')
                  ? '⏸ goal paused'
                  : 'ready'
          )
          scheduleStatusRestore(6_000)
        } else {
          scheduleStatusRestore(4_000)
        }
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
      // The self-improvement background review finished and emitted a persistent
      // summary of what it saved to memory/skills. Surface it as a system line so
      // it never gets lost to a transient status flash — the gateway already
      // formats the text ("💾 Self-improvement review: …") and only emits this
      // when display.memory_notifications is on (off → no event). Mirrors the Ink
      // handler (createGatewayEventHandler.ts `case 'review.summary'`).
      case 'review.summary': {
        const text = event.payload?.text?.trim()
        if (text) pushSystem(text)
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
      case 'reasoning.available': {
        setState(produce(draft => appendFallbackReasoning(draft, event.payload?.text)))
        break
      }
      case 'moa.reference': {
        const payload = event.payload
        const text = payload?.text?.trim()
        if (!payload || !text) break
        const label = payload.label?.trim() || 'reference'
        const ordinal =
          payload.index !== undefined && payload.count !== undefined ? ` ${payload.index}/${payload.count}` : ''
        setState(
          produce(draft => {
            const assistant = ensureAssistant(draft)
            const parts = (assistant.parts ??= [])
            const references = parts.filter(part => part.type === 'moa')
            if (references.length >= MOA_REFERENCE_LIMIT) return
            const used = references.reduce((total, part) => total + part.text.length, 0)
            const remaining = Math.max(0, MOA_TURN_TEXT_LIMIT - used)
            const header = `**Reference${ordinal} — ${label}**\n\n`

            // Keep newest references within a store-wide ceiling: evict only
            // old MoA machinery parts (never answer/tool/user rows) before adding.
            let retained = draft.messages.reduce(
              (total, message) =>
                total +
                (message.parts ?? []).reduce((sum, part) => sum + (part.type === 'moa' ? part.text.length : 0), 0),
              0
            )
            for (const message of draft.messages) {
              const oldParts = message.parts
              if (!oldParts || message === assistant) continue
              for (let index = 0; index < oldParts.length && retained + header.length > MOA_STORE_TEXT_LIMIT; ) {
                const part = oldParts[index]
                if (part?.type === 'moa') {
                  retained -= part.text.length
                  oldParts.splice(index, 1)
                } else index++
              }
              if (retained + header.length <= MOA_STORE_TEXT_LIMIT) break
            }

            const storeRemaining = Math.max(0, MOA_STORE_TEXT_LIMIT - retained)
            const partCap = Math.min(MOA_REFERENCE_TEXT_LIMIT, remaining, storeRemaining)
            if (partCap <= header.length) return
            const bodyCap = partCap - header.length
            const boundedText = text.length <= bodyCap ? text : `${text.slice(0, Math.max(0, bodyCap - 1))}…`
            parts.push({ type: 'moa', id: nextId(), text: header + boundedText })
          })
        )
        break
      }
      case 'moa.aggregating': {
        const aggregator = event.payload?.aggregator?.trim()
        setState('status', aggregator ? `aggregating with ${aggregator}…` : 'aggregating references…')
        break
      }
      case 'tool.progress': {
        const name = event.payload.name?.trim()
        const preview = event.payload.preview?.trim()
        if (!name || !preview) break
        setState(
          produce(draft => {
            const tool = findRunningToolByName(draft, name)
            if (tool) tool.progressPreview = preview.slice(0, TOOL_PROGRESS_LIMIT)
          })
        )
        break
      }
      case 'tool.generating': {
        const name = event.payload.name?.trim()
        if (name) {
          setState('status', `drafting ${name}…`)
          scheduleStatusRestore(4_000)
        }
        break
      }
      case 'browser.progress': {
        const message = readStr(event.payload, 'message')?.trim()
        if (message) {
          setBrowserState({ lastProgress: message })
          pushSystem(message)
        }
        break
      }
      case 'voice.status': {
        const voiceState = event.payload?.state
        setVoiceActivity(voiceState === 'listening', voiceState === 'transcribing')
        break
      }
      case 'voice.transcript': {
        if (!event.payload?.no_speech_limit) break
        // Exact-f7 only drops the umbrella mode/activity here; TTS state is
        // retained until an explicit `/voice off` or gateway lifecycle reset.
        setVoiceMode({ enabled: false })
        pushSystem('voice: no speech detected 3 times, continuous mode stopped')
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
            delete part.progressPreview
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
        setState('prompt', {
          kind: 'approval',
          // Explicit choices are authoritative. smart_denied is the additive
          // fallback for gateways that send the marker without choices; older
          // gateways retain the historical allow_permanent-derived catalog.
          allowPermanent: approvalPolicy({
            ...(event.payload.allow_permanent === undefined ? {} : { allowPermanent: event.payload.allow_permanent }),
            ...(event.payload.choices === undefined ? {} : { choices: event.payload.choices }),
            ...(event.payload.smart_denied === undefined ? {} : { smartDenied: event.payload.smart_denied })
          }),
          command: event.payload.command,
          description: event.payload.description
        })
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
      case 'sudo.expire':
        if (state.prompt?.kind === 'sudo' && state.prompt.requestId === event.payload.request_id) clearPrompt()
        break
      case 'secret.expire':
        if (state.prompt?.kind === 'secret' && state.prompt.requestId === event.payload.request_id) clearPrompt()
        break
      // ── subagents (agents dashboard) — track the delegation tree by id ──
      case 'subagent.spawn_requested':
      case 'subagent.start':
      case 'subagent.thinking':
      case 'subagent.tool':
      case 'subagent.progress':
      case 'subagent.complete':
      case 'subagent.text': {
        const id =
          event.payload.subagent_id ??
          (event.payload.task_index !== undefined || event.payload.goal
            ? `sa:${String(event.payload.task_index ?? 0)}:${event.payload.goal || 'subagent'}`
            : undefined)
        if (!id) break
        const mayCreate = event.type === 'subagent.spawn_requested' || event.type === 'subagent.start'
        setState(
          produce(draft => {
            let sa = draft.subagents.find(s => s.id === id)
            if (!sa) {
              if (!mayCreate) return
              sa = makeSubagent(event.payload, id, event.type === 'subagent.spawn_requested' ? 'queued' : 'running')
              draft.subagents.push(sa)
              draft.subagents.sort((left, right) => left.depth - right.depth || (left.index ?? 0) - (right.index ?? 0))
            } else {
              mergeSubagentPayload(sa, event.payload)
            }

            const rawText = event.payload.text ?? ''
            const text = rawText.trim()
            const tool = event.payload.tool_name
            const trace = (sa.trace ??= [])
            if (event.type === 'subagent.spawn_requested') {
              if (!isTerminalStatus(sa.status)) sa.status = 'queued'
            } else if (event.type === 'subagent.start') {
              if (!isTerminalStatus(sa.status)) sa.status = 'running'
              trace.push({ kind: 'start', text: sa.goal || 'started' })
            } else if (event.type === 'subagent.thinking') {
              sa.status = keepTerminalElseRunning(sa.status)
              if (text) {
                sa.thought = text
                pushUniqueBounded((sa.thinking ??= []), text, SUBAGENT_THINKING_LIMIT)
              }
            } else if (event.type === 'subagent.tool') {
              sa.status = keepTerminalElseRunning(sa.status)
              if (tool) {
                const line = formatSubagentTool(tool, event.payload.tool_preview ?? text)
                pushUniqueBounded((sa.tools ??= []), line, SUBAGENT_TOOLS_LIMIT)
                trace.push({ kind: 'tool', text: line })
              }
            } else if (event.type === 'subagent.progress') {
              sa.status = keepTerminalElseRunning(sa.status)
              if (text) {
                pushUniqueBounded((sa.notes ??= []), text, SUBAGENT_NOTES_LIMIT)
                trace.push({ kind: 'progress', text })
              }
            } else if (event.type === 'subagent.complete') {
              sa.status = normalizeTerminalStatus(event.payload.status)
              const summary = event.payload.summary || text || sa.summary
              if (summary) sa.summary = summary
              trace.push({ kind: 'summary', text: summary || 'done' })
            }
            // Per-token reply text (subagent.text): COALESCE into one growing
            // line. It is update-only like every other post-start variant.
            else if (rawText) {
              sa.status = keepTerminalElseRunning(sa.status)
              const last = trace[trace.length - 1]
              if (last && last.kind === 'reply') last.text += rawText
              else trace.push({ kind: 'reply', text: rawText })
            }
            if (trace.length > SUBAGENT_TRACE_LIMIT) trace.splice(0, trace.length - SUBAGENT_TRACE_LIMIT)
          })
        )
        if (mayCreate) maybeQueueAgentsNudge()
        break
      }
      // ── gateway lifecycle / transport errors (auto-heal foundations) ──
      // The child exited mid-turn. THE key bug fix: clear the frozen `running`
      // spinner (no message.complete will ever arrive for the lost reply), tell
      // the user their in-flight reply was lost, and show a recovering status.
      case 'gateway.exited': {
        clearStatusRestoreTimer()
        lastStatusNote = ''
        // Only an actually-open turn owns an exit archive. A post-complete
        // transport exit happens while turnInFlight is still latched, but the
        // archived bit keeps it from duplicating the normal snapshot.
        archiveAndClearSubagents(turnInFlight && !agentsTurnArchived)
        agentsTurnArchived = true
        setState(
          'info',
          produce(info => {
            info.running = false
            // The count belongs to the dead Python process's in-memory async
            // registry. Its workers cannot survive this exit; retaining it
            // would falsely promise an automatic background resume forever.
            delete info.activeSubagents
          })
        )
        setState('delegation', current => ({ ...current, paused: false, updatedAtMs: null }))
        setState('liveSessionCount', 0)
        setState('liveSessions', [])
        // Runtime-owned resources cannot survive the child process exit.
        setState('voice', {
          enabled: false,
          tts: false,
          recording: false,
          processing: false,
          recordKey: state.voice.recordKey
        })
        setBrowserState({ connected: false, url: '', lastProgress: '' })
        setState(produce(settleFailedAssistant))
        // The authoritative settle event can no longer arrive from a dead
        // child. Disarm the latch WITHOUT draining onto the dead transport;
        // same-session recovery snapshots/restores the client queue explicitly.
        turnInFlight = false
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
      // Collect stderr into a bounded ring (NOT the transcript).
      case 'gateway.stderr': {
        pushStderr(event.payload.line)
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
        settlePendingSteers(event.payload?.client_submission_ids)
        const actualTurnBoundary = (turnInFlight || state.info.running === true) && !agentsTurnArchived
        archiveAndClearSubagents(actualTurnBoundary, true)
        agentsTurnArchived = true
        // `message.start` may be followed by a terminal error with no
        // message.complete. Settle the newest streaming assistant before the
        // system error row is appended: remove a wholly empty caret row, or
        // retain partial/tool content as a non-streaming failed turn. This also
        // prevents neverWindow from pinning one native row per failed turn.
        setState(produce(settleFailedAssistant))
        const message = event.payload?.message
        pushSystem(message ? `error: ${message}` : 'error')
        // A deferred agent build can fail before `message.start`; the gateway
        // clears its running flag but emits no trailing session.info in that
        // path. Settle the optimistic client flag and drain exactly once. For a
        // turn that DID start, keep turnInFlight armed so the authoritative
        // session.info(false) still owns the queue drain.
        const preStartFailure = state.info.running === true && !turnInFlight
        setState('info', prev => ({ ...prev, running: false }))
        setState('status', undefined)
        if (preStartFailure) onTurnComplete?.()
        // A turn can end via error without message.complete — flush any held
        // notice here too, matching Ink recordError.
        flushPendingNotice()
        break
      }
      // Other event types (chrome) are reduced in later phases; unhandled members
      // are intentionally ignored here.
    }
    onCommittedEvent?.(event)
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

  /** Replace the mounted composer with server-provided editable text. */
  function replaceComposerDraft(text: string): void {
    // A delayed extension response must never overwrite an active queued-row
    // editor and then submit its prefill as a replacement for that queue row.
    setState('queueEditIndex', undefined)
    setState('composerDraft', text)
    setState('composerReplaceVersion', version => version + 1)
  }

  /** Clear both persisted state and the mounted native textarea via its
   * monotonic signal (Composer observes composerClearVersion). */
  function clearComposerDraft(): void {
    setState('composerDraft', '')
    setState('composerClearVersion', version => version + 1)
  }

  function setBusyInputMode(mode: BusyInputMode): void {
    busyInputModeRevision += 1
    setState('busyInputMode', mode)
  }

  function hydrateBusyInputMode(mode: BusyInputMode, expectedRevision: number): boolean {
    if (busyInputModeRevision !== expectedRevision) return false
    setState('busyInputMode', mode)
    return true
  }

  function getBusyInputModeRevision(): number {
    return busyInputModeRevision
  }

  /** Most recent user body, including collapsed skill invocations. */
  function lastUserMessage(): string | undefined {
    for (let index = state.messages.length - 1; index >= 0; index--) {
      const message = state.messages[index]
      if (message?.role === 'user' && !message.localOnly) return message.text
    }
    return undefined
  }

  /** Remove the most recent visible user exchange while preserving local
   * system/notification chrome that arrived after it. This is stronger than
   * Ink's literal-tail trim: gateway history has already rewound, so a trailing
   * `/fortune` row must not leave the old user/assistant exchange visible. */
  function trimLastExchange(): number {
    let userIndex = -1
    for (let index = state.messages.length - 1; index >= 0; index--) {
      if (state.messages[index]?.role === 'user' && !state.messages[index]?.localOnly) {
        userIndex = index
        break
      }
    }
    if (userIndex < 0) return 0
    let removed = 0
    const next = state.messages.filter((message, index) => {
      const drop = index === userIndex || (index > userIndex && message.role === 'assistant')
      if (drop) removed += 1
      return !drop
    })
    if (removed > 0) setState('messages', next)
    return removed
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
    archiveAndClearSubagents(false)
    agentsTurnArchived = true
    // Resume replaces session context — a prior session's notice/timer must not
    // bleed in; mirrors Ink reset(). Deliberate tradeoff: a same-session
    // auto-heal reconnect momentarily drops a standing sticky banner, which the
    // gateway re-emits on the next header parse — acceptable vs. cross-session
    // bleed + a leaked timer.
    clearNoticeState()
    // …same reasoning for the client busy queue: a resumed/different session must
    // not drain a prior session's queued prompts into its first turn-completion.
    clearQueue()
    // …and disarm the drain edge so a resume mid-turn doesn't leave it armed.
    turnInFlight = false
    // …same reasoning for the pinned todo panel: a resumed/different session must
    // not inherit the prior session's plan. The resumed session re-emits its own
    // `todo` snapshot if it has one (mirrors clearTranscript's reset).
    setState('latestTodos', undefined)
    // `usage.active_subagents` belongs to the prior adopted session. The
    // resumed session's next info/complete payload re-establishes it.
    setState(
      'info',
      produce(info => {
        delete info.activeSubagents
      })
    )
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
  function setCatalog(raw: unknown): Catalog | undefined {
    const decoded = decodeCatalog(raw)
    if (Option.isNone(decoded)) return undefined
    const catalog = catalogFrom(decoded.value)
    setState('catalog', catalog)
    return catalog
  }

  function setCommandCatalog(catalog: CommandsCatalogResponse | undefined): void {
    setState('commandCatalog', catalog)
  }

  function addPendingImage(info: {
    readonly path?: string
    readonly name?: string
    readonly width?: number
    readonly height?: number
    readonly token_estimate?: number
  }): PendingImageAttachment | undefined {
    const path = info.path?.trim()
    if (!path) return undefined
    const existing = state.pendingImages.find(image => image.path === path)
    if (existing) return existing
    const id = state.pendingImages.reduce((max, image) => Math.max(max, image.id), 0) + 1
    const image: PendingImageAttachment = {
      id,
      token: `[Image #${String(id)}]`,
      path,
      ...(info.name ? { name: info.name } : {}),
      ...(info.width ? { width: info.width } : {}),
      ...(info.height ? { height: info.height } : {}),
      ...(info.token_estimate ? { tokenEstimate: info.token_estimate } : {})
    }
    setState('pendingImages', current => [...current, image])
    return image
  }

  function removePendingImage(path: string): PendingImageAttachment | undefined {
    const image = state.pendingImages.find(candidate => candidate.path === path)
    if (!image) return undefined
    setState('pendingImages', current => current.filter(candidate => candidate.path !== path))
    return image
  }

  function restorePendingImage(image: PendingImageAttachment): void {
    if (state.pendingImages.some(candidate => candidate.path === image.path)) return
    setState('pendingImages', current => [...current, image].sort((a, b) => a.id - b.id))
  }

  function clearPendingImages(): void {
    setState('pendingImages', [])
  }

  /** Replace only the active conversation after a fully-decoded same-SID mutation. */
  function replaceConversationSnapshot(
    snapshot: Message[] | undefined,
    rawInfo: object | undefined,
    rawUsage: object | undefined
  ): void {
    const capped =
      snapshot === undefined ? undefined : snapshot.length > MESSAGE_CAP ? snapshot.slice(-MESSAGE_CAP) : snapshot
    const infoPatch = readInfoPatch(rawUsage === undefined ? (rawInfo ?? {}) : { ...(rawInfo ?? {}), usage: rawUsage })
    setState(
      produce(draft => {
        if (capped !== undefined && snapshot !== undefined) {
          draft.messages = capped
          draft.dropped = snapshot.length - capped.length
        }
        draft.info = { ...draft.info, ...infoPatch }
        draft.status = undefined
      })
    )
  }

  function setSessionId(sid: string | undefined): void {
    setState('sessionId', sid)
  }

  function setResumeId(id: string | undefined): void {
    setState('resumeId', id)
  }

  /** Apply active-list chrome only when it changed, avoiding a process-wide
   * Solid invalidation every 1.5s while the terminal is idle. */
  function setLiveSessionChrome(count: number, title: string): void {
    const nextCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
    const nextTitle = title.trim()
    if (state.liveSessionCount !== nextCount) setState('liveSessionCount', nextCount)
    if ((state.info.title ?? '') === nextTitle) return
    setState(
      'info',
      produce(info => {
        if (nextTitle) info.title = nextTitle
        else delete info.title
      })
    )
  }

  function applyActiveSessionsResponse(raw: unknown, currentSessionId: string | undefined): boolean {
    const decoded = decodeSessionActiveListResponse(raw)
    if (!decoded) return false
    const wireRows = decoded.sessions ?? []
    // A response can race a switch; prefer the authoritative SID supplied at apply time.
    const exactCurrent = currentSessionId ? wireRows.some(row => row.id === currentSessionId) : false
    const rows = exactCurrent ? wireRows.map(row => ({ ...row, current: row.id === currentSessionId })) : wireRows
    const same =
      rows.length === state.liveSessions.length &&
      rows.every((row, index) => {
        const previous = state.liveSessions[index]
        return (
          previous?.id === row.id &&
          previous.current === row.current &&
          previous.status === row.status &&
          previous.title === row.title &&
          previous.preview === row.preview &&
          previous.model === row.model &&
          previous.message_count === row.message_count &&
          previous.last_active === row.last_active &&
          previous.session_key === row.session_key &&
          previous.started_at === row.started_at
        )
      })
    if (!same) setState('liveSessions', rows)
    const current =
      (currentSessionId ? rows.find(row => row.id === currentSessionId) : undefined) ?? rows.find(row => row.current)
    setLiveSessionChrome(rows.length, current?.title ?? '')
    return true
  }

  return {
    /** Effective retained-message cap after the production windowing ceiling. */
    messageCap: MESSAGE_CAP,
    state,
    apply,
    pushUser,
    pushLocalUser,
    pushSkill,
    removeClientMessage,
    pushPendingSteer,
    pushSystem,
    pushNotification,
    showNotice,
    clearNotice,
    enqueuePrompt,
    dequeuePrompt,
    removeQueuedPrompt,
    replaceQueuedPrompt,
    setQueueEditIndex,
    clearQueue,
    queuedCount,
    registerTurnCompleteHandler,
    registerCommittedEventHandler,
    nextSpawnTreeSaveIntent,
    settleSpawnTreeSaveIntent,
    loadSpawnTreeSnapshot,
    configureAgentsNudge,
    consumeAgentsNudge,
    activeSubagentCount,
    applyDelegationStatusResponse,
    applyDelegationPauseResponse,
    setCatalog,
    setCommandCatalog,
    addPendingImage,
    removePendingImage,
    restorePendingImage,
    clearPendingImages,
    replaceConversationSnapshot,
    setSessionId,
    setResumeId,
    setLiveSessionChrome,
    applyActiveSessionsResponse,
    detachSession,
    adoptFreshSession,
    commitSessionSnapshot,
    abortBuffer,
    isBuffering,
    isTurnInFlight,
    clearTranscript,
    setConfirm,
    openPager,
    closePager,
    openSessionPicker,
    closeSessionPicker,
    openPicker,
    closePicker,
    openCustomModelSetup,
    closeCustomModelSetup,
    openPromptHistory,
    closePromptHistory,
    setModelItems,
    setCompletions,
    clearCompletions,
    applyInfo,
    setHint,
    setStatus,
    setVoiceMode,
    setVoiceActivity,
    setBrowserState,
    setCompact,
    hydrateCompact,
    getCompactRevision,
    openJourney,
    openPluginsHub,
    closePluginsHub,
    openPetPicker,
    closePetPicker,
    closeJourney,
    setDetails,
    setDetailSection,
    hydrateDetails,
    getDetailsRevision,
    setTimestamps,
    setReasoningFull,
    setBusyInputMode,
    hydrateBusyInputMode,
    getBusyInputModeRevision,
    openDashboard,
    closeDashboard,
    openBackgroundPanel,
    closeBackgroundPanel,
    openBilling,
    closeBilling,
    patchBilling,
    openSubscription,
    closeSubscription,
    patchSubscription,
    setBackgroundProcesses,
    addBgTask,
    hydrate,
    beginBuffer,
    commitSnapshot,
    duplicate,
    clearPrompt,
    setComposerDraft,
    replaceComposerDraft,
    lastUserMessage,
    trimLastExchange,
    clearComposerDraft
  } as const
}

export type SessionStore = ReturnType<typeof createSessionStore>
