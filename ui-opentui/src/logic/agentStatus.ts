/**
 * Pure state and formatting rules shared by the Agents dashboard, slash
 * commands, and status chrome.
 *
 * Gateway payloads are decoded at the Effect boundary. This module owns only
 * deterministic domain transitions: no transport, timers, Solid store, or
 * renderable dependencies.
 */

const ACTIVE_SUBAGENT_STATUSES = new Set([
  'pending',
  'queued',
  'replying',
  'running',
  'spawn_requested',
  'started',
  'thinking',
  'tool',
  'working'
])

export interface LocalSubagentStatus {
  readonly status: string
}

export type ActiveSubagentCountSource = 'local' | 'usage'

export interface ActiveSubagentCount {
  readonly count: number
  readonly source: ActiveSubagentCountSource
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function positiveSafeInteger(value: unknown): number | undefined {
  const valueInt = nonNegativeSafeInteger(value)
  return valueInt !== undefined && valueInt > 0 ? valueInt : undefined
}

/** Match the canonical live aliases accepted by the spawn-tree domain. */
export function isActiveSubagentStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  return ACTIVE_SUBAGENT_STATUSES.has(normalized)
}

/**
 * Resolve the running count shown in chrome.
 *
 * `usage.active_subagents` is registry-backed and therefore authoritative,
 * including an explicit zero. Local rows are only a compatibility fallback
 * when that field is absent or malformed; they must never override it.
 */
export function resolveActiveSubagentCount(
  usageActiveSubagents: unknown,
  localRows: readonly LocalSubagentStatus[]
): ActiveSubagentCount {
  const authoritative = nonNegativeSafeInteger(usageActiveSubagents)
  if (authoritative !== undefined) return { count: authoritative, source: 'usage' }

  return {
    count: localRows.filter(row => isActiveSubagentStatus(row.status)).length,
    source: 'local'
  }
}

// ── Delegation caps / pause state ──────────────────────────────────────

export interface DelegationState {
  readonly maxConcurrentChildren: null | number
  readonly maxSpawnDepth: null | number
  readonly paused: boolean
  readonly updatedAtMs: null | number
}

/** Structurally accepts both decoded full status and decoded pause responses. */
export interface DelegationStatusPatch {
  readonly max_concurrent_children?: unknown
  readonly max_spawn_depth?: unknown
  readonly paused?: unknown
}

export function createDelegationState(): DelegationState {
  return {
    maxConcurrentChildren: null,
    maxSpawnDepth: null,
    paused: false,
    updatedAtMs: null
  }
}

/**
 * Merge only valid fields from a successful delegation RPC response.
 * Malformed/empty patches are inert and cannot erase the last good caps.
 */
export function applyDelegationState(
  state: DelegationState,
  patch: DelegationStatusPatch,
  updatedAtMs: number
): DelegationState {
  const maxConcurrentChildren = positiveSafeInteger(patch.max_concurrent_children)
  const maxSpawnDepth = positiveSafeInteger(patch.max_spawn_depth)
  const paused = typeof patch.paused === 'boolean' ? patch.paused : undefined

  if (maxConcurrentChildren === undefined && maxSpawnDepth === undefined && paused === undefined) return state

  return {
    maxConcurrentChildren: maxConcurrentChildren ?? state.maxConcurrentChildren,
    maxSpawnDepth: maxSpawnDepth ?? state.maxSpawnDepth,
    paused: paused ?? state.paused,
    updatedAtMs: Number.isFinite(updatedAtMs) && updatedAtMs >= 0 ? updatedAtMs : state.updatedAtMs
  }
}

export const DELEGATION_WARN_RATIO = 0.66
export const DELEGATION_CAP_RATIO = 1

export interface DelegationLoad {
  /** Total currently-active rows, used for display context rather than a cap. */
  readonly activeCount: number
  /** Deepest observed spawn depth. */
  readonly depth: number
  /** Widest tree level: the closest UI proxy for the per-parent child cap. */
  readonly widestLevel: number
}

export type DelegationPressureLevel = 'normal' | 'warn' | 'error'

export interface DelegationPressure {
  readonly activeCount: number
  readonly atCap: boolean
  readonly concurrencyRatio: number
  readonly depthRatio: number
  readonly level: DelegationPressureLevel
  readonly ratio: number
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * Match Ink's cap warning semantics. Concurrency is the widest tree level,
 * not the global active count, because `max_concurrent_children` is per parent.
 */
export function delegationPressure(state: DelegationState, load: DelegationLoad): DelegationPressure {
  const activeCount = nonNegativeFinite(load.activeCount)
  const depth = nonNegativeFinite(load.depth)
  const widestLevel = nonNegativeFinite(load.widestLevel)
  const depthRatio = state.maxSpawnDepth === null ? 0 : depth / state.maxSpawnDepth
  const concurrencyRatio = state.maxConcurrentChildren === null ? 0 : widestLevel / state.maxConcurrentChildren
  const ratio = Math.max(depthRatio, concurrencyRatio)
  const atCap = ratio >= DELEGATION_CAP_RATIO
  const level: DelegationPressureLevel =
    state.paused || atCap ? 'error' : ratio >= DELEGATION_WARN_RATIO ? 'warn' : 'normal'

  return { activeCount, atCap, concurrencyRatio, depthRatio, level, ratio }
}

/** Script-friendly `/agents status` wording shared by both terminal engines. */
export function delegationStatusText(state: DelegationState): string {
  const depth = state.maxSpawnDepth ?? '?'
  const concurrency = state.maxConcurrentChildren ?? '?'
  return `delegation · ${state.paused ? 'paused' : 'active'} · caps d${String(depth)}/${String(concurrency)}`
}

// ── Once-per-turn /agents discovery nudge ─────────────────────────────

export interface AgentsNudgeState {
  /** Only literal config `false` disables the default-on nudge. */
  readonly enabled: boolean
  /** Monotonic generation; clear/start both invalidate older event tokens. */
  readonly generation: number
  readonly activeTurnId: null | number
  readonly nudgedTurnId: null | number
}

export interface AgentsNudgeAttempt {
  readonly overlayOpen: boolean
  /** Token captured from `activeTurnId` for the event's owning turn. */
  readonly turnId: number
}

export interface AgentsNudgeDecision {
  readonly shouldNudge: boolean
  readonly state: AgentsNudgeState
}

function nextGeneration(generation: number): number {
  return Number.isSafeInteger(generation) && generation >= 0 && generation < Number.MAX_SAFE_INTEGER
    ? generation + 1
    : 1
}

export function createAgentsNudgeState(configValue?: unknown): AgentsNudgeState {
  return {
    enabled: configValue !== false,
    generation: 0,
    activeTurnId: null,
    nudgedTurnId: null
  }
}

/** Only an explicit false disables; absent or unrecognised config keeps default-on. */
export function configureAgentsNudge(state: AgentsNudgeState, configValue: unknown): AgentsNudgeState {
  const enabled = configValue !== false
  return enabled === state.enabled ? state : { ...state, enabled }
}

/** `message.start`: open a fresh turn and restore its one nudge credit. */
export function startAgentsNudgeTurn(state: AgentsNudgeState): AgentsNudgeState {
  const generation = nextGeneration(state.generation)
  return { ...state, generation, activeTurnId: generation, nudgedTurnId: null }
}

/**
 * Turn/session clear: close the credit window and invalidate the old token so a
 * late `subagent.start` cannot advertise or resurrect the cleared turn.
 */
export function clearAgentsNudgeTurn(state: AgentsNudgeState): AgentsNudgeState {
  return {
    ...state,
    generation: nextGeneration(state.generation),
    activeTurnId: null,
    nudgedTurnId: null
  }
}

/**
 * Try to spend the turn's discovery credit. An open dashboard suppresses the
 * hint without spending the credit; closing it later permits one subsequent
 * delegation event to show the nudge.
 */
export function considerAgentsNudge(state: AgentsNudgeState, attempt: AgentsNudgeAttempt): AgentsNudgeDecision {
  const active = state.activeTurnId
  if (
    !state.enabled ||
    attempt.overlayOpen ||
    active === null ||
    attempt.turnId !== active ||
    state.nudgedTurnId === active
  ) {
    return { shouldNudge: false, state }
  }

  return {
    shouldNudge: true,
    state: { ...state, nudgedTurnId: active }
  }
}

// ── Idle parked-subagent status text ──────────────────────────────────

export type IdleSubagentResumeVariant = 'compact' | 'full' | 'hidden' | 'tiny'

export interface IdleSubagentResumeStatus {
  readonly text: string
  readonly variant: IdleSubagentResumeVariant
}

export interface IdleSubagentResumeInput {
  /** Actual cells remaining after every higher-priority status segment. */
  readonly availableCells: number
  readonly count: number
  readonly running: boolean
}

interface ResumeCandidate {
  readonly text: string
  readonly variant: Exclude<IdleSubagentResumeVariant, 'hidden'>
}

const HIDDEN_RESUME_STATUS: IdleSubagentResumeStatus = { text: '', variant: 'hidden' }

/**
 * Select the longest whole status phrase that fits the caller's real remaining
 * cell budget. Nothing is truncated, so this variable-width segment cannot
 * wrap the status bar at a fixed breakpoint.
 */
export function idleSubagentResumeStatus(input: IdleSubagentResumeInput): IdleSubagentResumeStatus {
  const count = nonNegativeSafeInteger(input.count)
  if (input.running || count === undefined || count === 0) return HIDDEN_RESUME_STATUS

  const availableCells = Number.isFinite(input.availableCells) ? Math.max(0, Math.floor(input.availableCells)) : 0
  const full = count === 1 ? '↩ resumes when subagent finishes' : `↩ resumes when ${String(count)} subagents finish`
  const candidates: readonly ResumeCandidate[] = [
    { text: full, variant: 'full' },
    { text: `↩ resumes · ${String(count)}`, variant: 'compact' },
    { text: `↩ ${String(count)}`, variant: 'tiny' }
  ]

  for (const candidate of candidates) {
    // All candidate glyphs are single-cell BMP characters; `.length` is the
    // exact terminal-cell width for this deliberately ASCII-heavy copy.
    if (candidate.text.length <= availableCells) return candidate
  }

  return HIDDEN_RESUME_STATUS
}
