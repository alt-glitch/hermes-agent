import type { TraceEntry } from '../../../logic/store.ts'
import { stableSpawnAgentId, type SpawnSnapshot } from '../../../logic/spawnHistory.ts'
import {
  buildSubagentTree,
  flattenTree,
  normalizeSubagentStatus,
  type SubagentNode,
  type SubagentTreeItem
} from '../../../logic/subagentTree.ts'

export type AgentsSortMode = 'depth-first' | 'duration-desc' | 'status' | 'tools-desc'
export type AgentsFilterMode = 'all' | 'failed' | 'leaf' | 'running'

export const AGENTS_SORT_ORDER: readonly AgentsSortMode[] = ['depth-first', 'tools-desc', 'duration-desc', 'status']
export const AGENTS_FILTER_ORDER: readonly AgentsFilterMode[] = ['all', 'running', 'failed', 'leaf']

export const AGENTS_SORT_LABEL: Readonly<Record<AgentsSortMode, string>> = {
  'depth-first': 'spawn order',
  'duration-desc': 'slowest',
  status: 'status',
  'tools-desc': 'busiest'
}

export const AGENTS_FILTER_LABEL: Readonly<Record<AgentsFilterMode, string>> = {
  all: 'all',
  failed: 'failed',
  leaf: 'leaves',
  running: 'running'
}

export interface DashboardOutputEntry {
  readonly isError: boolean
  readonly preview: string
  readonly tool: string
}

/**
 * Richest shape the dashboard can display. Current thin live rows and f7
 * archived spawn-tree records are both structurally compatible after the
 * view-boundary normalizer below.
 */
export interface DashboardAgent extends SubagentTreeItem {
  readonly apiCalls?: number
  readonly goal: string
  readonly iteration?: number
  readonly lastTool?: string
  readonly model?: string
  readonly notes?: readonly string[]
  readonly outputTail?: readonly DashboardOutputEntry[]
  readonly reasoningTokens?: number
  readonly startedAt?: number
  readonly summary?: string
  readonly thinking?: readonly string[]
  readonly thought?: string
  readonly toolsets?: readonly string[]
  readonly tools?: readonly string[]
  readonly trace?: readonly TraceEntry[]
}

const STATUS_RANK: Readonly<Record<string, number>> = {
  error: 0,
  failed: 0,
  interrupted: 1,
  timeout: 1,
  running: 2,
  queued: 3,
  completed: 4
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function readNumber(value: Readonly<Record<string, unknown>>, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const found = finiteNumber(value[key])
    if (found !== undefined) return found
  }
  return undefined
}

function readString(value: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const found = nonEmptyString(value[key])
    if (found !== undefined) return found
  }
  return undefined
}

function readStrings(
  value: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): readonly string[] | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (!Array.isArray(candidate)) continue
    return candidate.filter((item): item is string => typeof item === 'string')
  }
  return undefined
}

function readTrace(value: Readonly<Record<string, unknown>>): readonly TraceEntry[] | undefined {
  const candidate = value['trace']
  if (!Array.isArray(candidate)) return undefined
  const entries: TraceEntry[] = []
  for (const item of candidate) {
    const row = record(item)
    const kind = row === undefined ? undefined : readString(row, 'kind')
    const text = row === undefined ? undefined : readString(row, 'text')
    if (
      text !== undefined &&
      (kind === 'start' || kind === 'tool' || kind === 'progress' || kind === 'summary' || kind === 'reply')
    ) {
      entries.push({ kind, text })
    }
  }
  return entries
}

function readOutputTail(value: Readonly<Record<string, unknown>>): readonly DashboardOutputEntry[] | undefined {
  const candidate = value['output_tail'] ?? value['outputTail']
  if (!Array.isArray(candidate)) return undefined
  const entries: DashboardOutputEntry[] = []
  for (const item of candidate) {
    const row = record(item)
    if (row === undefined) continue
    const tool = readString(row, 'tool')
    const preview = readString(row, 'preview')
    if (tool === undefined || preview === undefined) continue
    entries.push({
      isError: row['is_error'] === true || row['isError'] === true,
      preview,
      tool
    })
  }
  return entries
}

function epochMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value
}

/** Convert a persisted snake/camel record into the live dashboard shape. */
export function dashboardAgentFromRecord(value: unknown, position = 0): DashboardAgent | undefined {
  const row = record(value)
  if (row === undefined) return undefined

  const id = stableSpawnAgentId(row, position)
  const parentId = readString(row, 'parent_id', 'parentId')
  const model = readString(row, 'model')
  const summary = readString(row, 'summary')
  const thought = readString(row, 'thought')
  const index = readNumber(row, 'task_index', 'index')
  const costUsd = readNumber(row, 'cost_usd', 'costUsd')
  const durationSeconds = readNumber(row, 'duration_seconds', 'durationSeconds')
  const inputTokens = readNumber(row, 'input_tokens', 'inputTokens')
  const outputTokens = readNumber(row, 'output_tokens', 'outputTokens')
  const reasoningTokens = readNumber(row, 'reasoning_tokens', 'reasoningTokens')
  const toolCount = readNumber(row, 'tool_count', 'toolCount')
  const apiCalls = readNumber(row, 'api_calls', 'apiCalls')
  const iteration = readNumber(row, 'iteration_count', 'iteration')
  const lastTool = readString(row, 'last_tool', 'lastTool', 'tool_name')
  const startedAt = epochMs(readNumber(row, 'started_at', 'startedAt'))
  const filesRead = readStrings(row, 'files_read', 'filesRead')
  const filesWritten = readStrings(row, 'files_written', 'filesWritten')
  const notes = readStrings(row, 'notes')
  const thinking = readStrings(row, 'thinking')
  const tools = readStrings(row, 'tools')
  const toolsets = readStrings(row, 'toolsets')
  const outputTail = readOutputTail(row)
  const trace = readTrace(row)

  return {
    depth: Math.max(0, readNumber(row, 'depth') ?? 0),
    goal: readString(row, 'goal') ?? 'subagent',
    id,
    // Persisted trees predate the live status field. Ink treats absent/unknown
    // archived values as finished rather than resurrecting them as active.
    status: normalizeSubagentStatus(row['status'], 'completed'),
    ...(apiCalls === undefined ? {} : { apiCalls }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(filesRead === undefined ? {} : { filesRead }),
    ...(filesWritten === undefined ? {} : { filesWritten }),
    ...(index === undefined ? {} : { index }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(iteration === undefined ? {} : { iteration }),
    ...(lastTool === undefined ? {} : { lastTool }),
    ...(model === undefined ? {} : { model }),
    ...(notes === undefined ? {} : { notes }),
    ...(outputTail === undefined ? {} : { outputTail }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(summary === undefined ? {} : { summary }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(thought === undefined ? {} : { thought }),
    ...(toolCount === undefined ? {} : { toolCount }),
    ...(tools === undefined ? {} : { tools }),
    ...(toolsets === undefined ? {} : { toolsets }),
    ...(trace === undefined ? {} : { trace })
  }
}

export function snapshotDashboardAgents(snapshot: SpawnSnapshot): readonly DashboardAgent[] {
  const rows: DashboardAgent[] = []
  snapshot.subagents.forEach((item, position) => {
    const normalized = dashboardAgentFromRecord(item, position)
    if (normalized !== undefined) rows.push(normalized)
  })
  return rows
}

function statusRank(status: string): number {
  return STATUS_RANK[normalizeSubagentStatus(status)] ?? STATUS_RANK['error'] ?? 0
}

const SORT_COMPARATORS: Readonly<
  Record<AgentsSortMode, (left: SubagentNode<DashboardAgent>, right: SubagentNode<DashboardAgent>) => number>
> = {
  'depth-first': (left, right) =>
    left.item.depth - right.item.depth || (left.item.index ?? 0) - (right.item.index ?? 0),
  'duration-desc': (left, right) => right.aggregate.totalDuration - left.aggregate.totalDuration,
  status: (left, right) => statusRank(left.item.status) - statusRank(right.item.status),
  'tools-desc': (left, right) => right.aggregate.totalTools - left.aggregate.totalTools
}

function matchesFilter(node: SubagentNode<DashboardAgent>, filter: AgentsFilterMode): boolean {
  const status = normalizeSubagentStatus(node.item.status)
  switch (filter) {
    case 'all':
      return true
    case 'leaf':
      return node.children.length === 0
    case 'running':
      return status === 'running' || status === 'queued'
    case 'failed':
      return status === 'error' || status === 'failed' || status === 'interrupted' || status === 'timeout'
  }
}

/** Ink-compatible root sorting followed by a depth-first, filterable traversal. */
export function prepareDashboardRows(
  agents: readonly DashboardAgent[],
  sort: AgentsSortMode,
  filter: AgentsFilterMode
): readonly SubagentNode<DashboardAgent>[] {
  const roots = [...buildSubagentTree(agents)].sort(SORT_COMPARATORS[sort])
  return flattenTree(roots).filter(node => matchesFilter(node, filter))
}

export function cycleDashboardValue<T>(order: readonly T[], current: T): T {
  if (order.length === 0) return current
  const index = order.indexOf(current)
  return order[(index < 0 ? 0 : index + 1) % order.length] ?? current
}

/** Keep keyboard selection stable by id while sorting/filtering/live updates. */
export function selectedDashboardIndex(
  rows: readonly SubagentNode<DashboardAgent>[],
  selectedId: string | undefined
): number {
  if (rows.length === 0) return -1
  if (selectedId === undefined) return 0
  const index = rows.findIndex(node => node.item.id === selectedId)
  return index < 0 ? 0 : index
}

export interface DashboardWindow<T> {
  readonly rows: readonly T[]
  readonly start: number
}

/** Mount only the terminal-visible list window, centered around selection. */
export function dashboardWindow<T>(rows: readonly T[], selectedIndex: number, capacity: number): DashboardWindow<T> {
  const boundedCapacity = Math.max(1, Math.floor(Number.isFinite(capacity) ? capacity : 1))
  const safeIndex = Math.max(0, Math.min(Math.max(0, rows.length - 1), selectedIndex))
  const start = Math.max(
    0,
    Math.min(Math.max(0, rows.length - boundedCapacity), safeIndex - Math.floor(boundedCapacity / 2))
  )
  return { rows: rows.slice(start, start + boundedCapacity), start }
}
