/**
 * Pure spawn-tree history domain for the Agents dashboard.
 *
 * Live rows are copied synchronously into immutable snapshots before the
 * session reducer clears them. History and replay selection stay separate
 * from live state: selecting or diffing an archive never feeds old agents
 * back through the event reducer (the stale-resurrection bug class).
 *
 * Gateway snapshots are JSON records. We retain every field, including
 * unknown future fields, while reading both the gateway's snake_case names
 * and the older Ink/OpenTUI camelCase aliases for identity and metadata.
 */

export const SPAWN_HISTORY_LIMIT = 10

export type SpawnAgentRecord = Readonly<Record<string, unknown>>

export type SpawnSnapshotSource = 'disk' | 'live'

export interface SpawnSnapshot {
  readonly finishedAtMs: number
  readonly id: string
  readonly label: string
  /** All top-level gateway fields other than `subagents`. */
  readonly metadata: Readonly<Record<string, unknown>>
  readonly path?: string
  readonly sessionId: null | string
  readonly source: SpawnSnapshotSource
  readonly startedAtMs: number
  readonly subagents: readonly SpawnAgentRecord[]
}

export interface SpawnHistoryState {
  /** Newest first. */
  readonly snapshots: readonly SpawnSnapshot[]
}

export interface SpawnCaptureMeta {
  readonly finishedAtMs?: number
  readonly id?: string
  readonly label?: string
  readonly metadata?: unknown
  readonly sessionId?: null | string
  readonly startedAtMs?: null | number
}

export interface SpawnCaptureResult {
  readonly snapshot: null | SpawnSnapshot
  readonly state: SpawnHistoryState
}

export interface SpawnLoadOptions {
  readonly nowMs?: number
  readonly path?: string
}

export interface SpawnHistoryEntry {
  readonly count: number
  readonly finishedAtMs: number
  readonly id: string
  /** One-based, newest-first replay index. */
  readonly index: number
  readonly label: string
  readonly path?: string
  readonly sessionId: null | string
  readonly source: SpawnSnapshotSource
  readonly startedAtMs: number
}

export type SpawnSnapshotSelector = { readonly id: string } | { readonly index: number } | { readonly path: string }

export interface SpawnDiffInput {
  readonly baseline: SpawnSnapshotSelector
  readonly candidate: SpawnSnapshotSelector
}

export interface SpawnDiffAgent {
  readonly agent: SpawnAgentRecord
  readonly id: string
}

export interface ChangedSpawnAgent {
  readonly after: SpawnAgentRecord
  readonly before: SpawnAgentRecord
  /** Canonical snake_case field names whose values differ. */
  readonly changedFields: readonly string[]
  readonly id: string
}

export interface SpawnDiffResult {
  readonly added: readonly SpawnDiffAgent[]
  readonly baselineId: string
  readonly candidateId: string
  readonly changed: readonly ChangedSpawnAgent[]
  readonly removed: readonly SpawnDiffAgent[]
  readonly unchangedIds: readonly string[]
}

const FIELD_ALIASES = new Map<string, string>([
  ['apiCalls', 'api_calls'],
  ['childSessionId', 'child_session_id'],
  ['costUsd', 'cost_usd'],
  ['durationSeconds', 'duration_seconds'],
  ['filesRead', 'files_read'],
  ['filesWritten', 'files_written'],
  ['id', 'subagent_id'],
  ['index', 'task_index'],
  ['inputTokens', 'input_tokens'],
  ['iterationCount', 'iteration_count'],
  ['lastTool', 'last_tool'],
  ['outputTail', 'output_tail'],
  ['outputTokens', 'output_tokens'],
  ['parentId', 'parent_id'],
  ['reasoningTokens', 'reasoning_tokens'],
  ['startedAt', 'started_at'],
  ['taskCount', 'task_count'],
  ['toolCount', 'tool_count']
])

const OUTPUT_ENTRY_FIELD_ALIASES = new Map<string, string>([['isError', 'is_error']])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneGatewayValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneGatewayValue))
  }
  if (!isRecord(value)) return value

  const cloned: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) cloned[key] = cloneGatewayValue(item)
  return Object.freeze(cloned)
}

function immutableRecord(value: Record<string, unknown>): SpawnAgentRecord {
  // Manual JSON-wire traversal is deliberate: live rows can be Solid store
  // proxies, which `structuredClone` rejects with DataCloneError.
  const cloned: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) cloned[key] = cloneGatewayValue(item)
  return Object.freeze(cloned)
}

function immutableMetadata(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? immutableRecord(value) : Object.freeze({})
}

function immutableAgents(values: readonly unknown[]): readonly SpawnAgentRecord[] {
  const records: SpawnAgentRecord[] = []
  for (const value of values) {
    if (isRecord(value)) records.push(immutableRecord(value))
  }
  return Object.freeze(records)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readNumber(record: Readonly<Record<string, unknown>>, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function readString(record: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

/** Accept epoch seconds from gateway snapshots and epoch milliseconds from live rows. */
function epochMs(value: number): number {
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value
}

function agentStartedAtMs(agent: SpawnAgentRecord): number | undefined {
  const value = readNumber(agent, 'started_at', 'startedAt')
  return value === undefined ? undefined : epochMs(value)
}

function parentId(agent: SpawnAgentRecord): string | undefined {
  return readString(agent, 'parent_id', 'parentId')
}

function goal(agent: SpawnAgentRecord): string {
  return readString(agent, 'goal') ?? 'subagent'
}

/**
 * Stable identity shared by live camelCase rows and archived snake_case rows.
 * Old snapshots without an issued id receive a deterministic composite; no
 * random id is generated, so the same legacy row remains matchable in diffs.
 */
export function stableSpawnAgentId(agent: SpawnAgentRecord, position = 0): string {
  const issued = readString(agent, 'subagent_id', 'id', 'agent_id')
  if (issued !== undefined) return issued

  const parent = parentId(agent) ?? 'root'
  const taskIndex = readNumber(agent, 'task_index', 'index') ?? position
  return `legacy:${encodeURIComponent(parent)}:${String(taskIndex)}:${encodeURIComponent(goal(agent))}`
}

function indexedAgents(agents: readonly SpawnAgentRecord[]): readonly SpawnDiffAgent[] {
  const seen = new Map<string, number>()
  return Object.freeze(
    agents.map((agent, position) => {
      const base = stableSpawnAgentId(agent, position)
      const occurrence = (seen.get(base) ?? 0) + 1
      seen.set(base, occurrence)
      const id = occurrence === 1 ? base : `${base}#${String(occurrence)}`
      return Object.freeze({ agent, id })
    })
  )
}

function summarizeLabel(agents: readonly SpawnAgentRecord[]): string {
  const known = new Set(indexedAgents(agents).map(item => item.id))
  const top = agents
    .filter(agent => {
      const parent = parentId(agent)
      return parent === undefined || !known.has(parent)
    })
    .slice(0, 2)
    .map(goal)
    .join(' · ')
  return top || `${String(agents.length)} agent${agents.length === 1 ? '' : 's'}`
}

function fingerprint(agents: readonly SpawnAgentRecord[]): string {
  const input = indexedAgents(agents)
    .map(item => item.id)
    .sort()
    .join('|')
  let hash = 2_166_136_261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(36)
}

function snapshotId(
  source: SpawnSnapshotSource,
  sessionId: null | string,
  startedAtMs: number,
  finishedAtMs: number,
  agents: readonly SpawnAgentRecord[],
  path: string | undefined
): string {
  if (source === 'disk' && path !== undefined) return `disk:${path}`
  return `${source}:${sessionId ?? 'default'}:${String(Math.trunc(startedAtMs))}:${String(Math.trunc(finishedAtMs))}:${fingerprint(agents)}`
}

function makeSnapshot(input: {
  finishedAtMs: number
  id?: string
  label: string
  metadata: Readonly<Record<string, unknown>>
  path?: string
  sessionId: null | string
  source: SpawnSnapshotSource
  startedAtMs: number
  subagents: readonly SpawnAgentRecord[]
}): SpawnSnapshot {
  const id =
    nonEmptyString(input.id) ??
    snapshotId(input.source, input.sessionId, input.startedAtMs, input.finishedAtMs, input.subagents, input.path)
  const base = {
    finishedAtMs: input.finishedAtMs,
    id,
    label: input.label,
    metadata: input.metadata,
    sessionId: input.sessionId,
    source: input.source,
    startedAtMs: input.startedAtMs,
    subagents: input.subagents
  }
  return Object.freeze(input.path === undefined ? base : { ...base, path: input.path })
}

export function emptySpawnHistory(): SpawnHistoryState {
  return Object.freeze({ snapshots: Object.freeze([]) })
}

/** Prepend one immutable snapshot, de-duplicate it, and enforce the hard last-10 bound. */
export function addSpawnSnapshot(state: SpawnHistoryState, snapshot: SpawnSnapshot): SpawnHistoryState {
  const next = [
    snapshot,
    ...state.snapshots.filter(
      item => item.id !== snapshot.id && (snapshot.path === undefined || item.path !== snapshot.path)
    )
  ].slice(0, SPAWN_HISTORY_LIMIT)
  return Object.freeze({ snapshots: Object.freeze(next) })
}

/**
 * Copy the current live rows synchronously. Call this immediately before the
 * turn-complete reducer clears `subagents`; later mutations cannot affect the
 * captured tree.
 */
export function captureLiveSpawnTree(
  state: SpawnHistoryState,
  liveRows: readonly unknown[],
  meta: SpawnCaptureMeta = {}
): SpawnCaptureResult {
  const subagents = immutableAgents(liveRows)
  if (subagents.length === 0) return Object.freeze({ snapshot: null, state })

  const finishedAtMs = finiteNumber(meta.finishedAtMs) ?? Date.now()
  const inferredStarted = subagents
    .map(agentStartedAtMs)
    .filter(value => value !== undefined)
    .reduce((minimum, value) => Math.min(minimum, value), finishedAtMs)
  const startedAtMs = finiteNumber(meta.startedAtMs) ?? inferredStarted
  const sessionId = meta.sessionId ?? null
  const label = nonEmptyString(meta.label) ?? summarizeLabel(subagents)
  const snapshot = makeSnapshot({
    finishedAtMs,
    ...(meta.id === undefined ? {} : { id: meta.id }),
    label,
    metadata: immutableMetadata(meta.metadata),
    sessionId,
    source: 'live',
    startedAtMs,
    subagents
  })
  return Object.freeze({ snapshot, state: addSpawnSnapshot(state, snapshot) })
}

function metadataWithoutAgents(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key !== 'subagents') metadata[key] = value
  }
  return immutableRecord(metadata)
}

/** Parse and prepend a `spawn_tree.load` payload. Invalid/empty trees are a no-op. */
export function loadSpawnTree(
  state: SpawnHistoryState,
  payload: unknown,
  options: SpawnLoadOptions = {}
): SpawnCaptureResult {
  if (!isRecord(payload) || !Array.isArray(payload['subagents'])) {
    return Object.freeze({ snapshot: null, state })
  }

  const subagents = immutableAgents(payload['subagents'])
  if (subagents.length === 0) return Object.freeze({ snapshot: null, state })

  const nowMs = finiteNumber(options.nowMs) ?? Date.now()
  const finished = readNumber(payload, 'finished_at', 'finishedAt')
  const finishedAtMs = finished === undefined ? nowMs : epochMs(finished)
  const started = readNumber(payload, 'started_at', 'startedAt')
  const inferredStarted = subagents
    .map(agentStartedAtMs)
    .filter(value => value !== undefined)
    .reduce((minimum, value) => Math.min(minimum, value), finishedAtMs)
  const startedAtMs = started === undefined ? inferredStarted : epochMs(started)
  const sessionId = readString(payload, 'session_id', 'sessionId') ?? null
  const path = nonEmptyString(options.path) ?? readString(payload, 'path')
  const label = readString(payload, 'label') ?? summarizeLabel(subagents)
  const snapshot = makeSnapshot({
    finishedAtMs,
    label,
    metadata: metadataWithoutAgents(payload),
    ...(path === undefined ? {} : { path }),
    sessionId,
    source: 'disk',
    startedAtMs,
    subagents
  })
  return Object.freeze({ snapshot, state: addSpawnSnapshot(state, snapshot) })
}

/** Lightweight newest-first rows for `/replay` and dashboard history chrome. */
export function listSpawnHistory(state: SpawnHistoryState): readonly SpawnHistoryEntry[] {
  return Object.freeze(
    state.snapshots.map((snapshot, offset) => {
      const base = {
        count: snapshot.subagents.length,
        finishedAtMs: snapshot.finishedAtMs,
        id: snapshot.id,
        index: offset + 1,
        label: snapshot.label,
        sessionId: snapshot.sessionId,
        source: snapshot.source,
        startedAtMs: snapshot.startedAtMs
      }
      return Object.freeze(snapshot.path === undefined ? base : { ...base, path: snapshot.path })
    })
  )
}

/**
 * Resolve a replay target without changing history or live agent state.
 * Numeric indexes are one-based and newest-first, matching `/replay N`.
 */
export function selectSpawnSnapshot(
  state: SpawnHistoryState,
  selector: SpawnSnapshotSelector
): SpawnSnapshot | undefined {
  if ('index' in selector) {
    if (!Number.isInteger(selector.index) || selector.index < 1) return undefined
    return state.snapshots[selector.index - 1]
  }
  if ('id' in selector) return state.snapshots.find(snapshot => snapshot.id === selector.id)
  return state.snapshots.find(snapshot => snapshot.path === selector.path)
}

function canonicalRecord(agent: SpawnAgentRecord): Readonly<Record<string, unknown>> {
  const canonical: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(agent)) {
    const mapped = FIELD_ALIASES.get(key) ?? key
    // An explicit snake_case field is authoritative when both forms exist.
    if (mapped !== key && Object.hasOwn(agent, mapped)) continue
    if (mapped === 'started_at' && typeof value === 'number' && Number.isFinite(value)) {
      canonical[mapped] = epochMs(value)
      continue
    }
    if (mapped === 'output_tail' && Array.isArray(value)) {
      canonical[mapped] = value.map((entry: unknown) => {
        if (!isRecord(entry)) return entry
        const normalized: Record<string, unknown> = {}
        for (const [entryKey, entryValue] of Object.entries(entry)) {
          const entryMapped = OUTPUT_ENTRY_FIELD_ALIASES.get(entryKey) ?? entryKey
          if (entryMapped !== entryKey && Object.hasOwn(entry, entryMapped)) continue
          normalized[entryMapped] = entryValue
        }
        return normalized
      })
      continue
    }
    canonical[mapped] = value
  }
  return canonical
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => valuesEqual(item, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]))
  )
}

function changedFields(before: SpawnAgentRecord, after: SpawnAgentRecord): readonly string[] {
  const left = canonicalRecord(before)
  const right = canonicalRecord(after)
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  return Object.freeze(keys.filter(key => !valuesEqual(left[key], right[key])))
}

/** Diff two immutable snapshots by stable agent identity. */
export function diffSpawnSnapshots(baseline: SpawnSnapshot, candidate: SpawnSnapshot): SpawnDiffResult {
  const before = indexedAgents(baseline.subagents)
  const after = indexedAgents(candidate.subagents)
  const beforeById = new Map(before.map(item => [item.id, item]))
  const afterById = new Map(after.map(item => [item.id, item]))
  const added = after.filter(item => !beforeById.has(item.id))
  const removed = before.filter(item => !afterById.has(item.id))
  const changed: ChangedSpawnAgent[] = []
  const unchangedIds: string[] = []

  for (const candidateItem of after) {
    const baselineItem = beforeById.get(candidateItem.id)
    if (baselineItem === undefined) continue
    const fields = changedFields(baselineItem.agent, candidateItem.agent)
    if (fields.length === 0) {
      unchangedIds.push(candidateItem.id)
    } else {
      changed.push(
        Object.freeze({
          after: candidateItem.agent,
          before: baselineItem.agent,
          changedFields: fields,
          id: candidateItem.id
        })
      )
    }
  }

  return Object.freeze({
    added: Object.freeze([...added]),
    baselineId: baseline.id,
    candidateId: candidate.id,
    changed: Object.freeze(changed),
    removed: Object.freeze([...removed]),
    unchangedIds: Object.freeze(unchangedIds)
  })
}

/** Resolve `/replay-diff` selectors, returning undefined when either side is stale/invalid. */
export function diffSpawnHistory(state: SpawnHistoryState, input: SpawnDiffInput): SpawnDiffResult | undefined {
  const baseline = selectSpawnSnapshot(state, input.baseline)
  const candidate = selectSpawnSnapshot(state, input.candidate)
  return baseline === undefined || candidate === undefined ? undefined : diffSpawnSnapshots(baseline, candidate)
}
