/** Canonical statuses persisted by the f7 gateway and Ink spawn history. */
export type SubagentStatus = 'completed' | 'error' | 'failed' | 'interrupted' | 'queued' | 'running' | 'timeout'

export type TerminalSubagentStatus = 'completed' | 'error' | 'failed' | 'interrupted' | 'timeout'

/**
 * Smallest shape needed by the pure tree domain.
 *
 * The required fields are structurally compatible with OpenTUI's current
 * `SubagentInfo`; the optional metrics are the richer f7 snapshot/event fields.
 * Generic tree functions preserve every extra field supplied by either shape.
 */
export interface SubagentTreeItem {
  readonly costUsd?: number
  readonly depth: number
  readonly durationSeconds?: number
  readonly filesRead?: readonly string[]
  readonly filesWritten?: readonly string[]
  readonly id: string
  readonly index?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly parentId?: null | string
  readonly status: string
  readonly toolCount?: number
}

export interface SubagentAggregate {
  activeCount: number
  costUsd: number
  descendantCount: number
  filesTouched: number
  hotness: number
  inputTokens: number
  maxDepthFromHere: number
  outputTokens: number
  totalDuration: number
  totalTools: number
}

export interface SubagentNode<T extends SubagentTreeItem = SubagentTreeItem> {
  aggregate: SubagentAggregate
  children: SubagentNode<T>[]
  item: T
}

const ROOT = Symbol('subagent-tree-root')
type ParentKey = string | typeof ROOT

interface OrderedItem<T extends SubagentTreeItem> {
  item: T
  order: number
}

function finiteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0
}

function finiteDepth(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function finiteIndex(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

/** Rich snapshots sort by `(depth, index)`; thin live rows retain event order. */
function compareOrdered<T extends SubagentTreeItem>(a: OrderedItem<T>, b: OrderedItem<T>): number {
  const depthDelta = finiteDepth(a.item.depth) - finiteDepth(b.item.depth)
  if (depthDelta !== 0) return depthDelta

  const aIndex = finiteIndex(a.item.index)
  const bIndex = finiteIndex(b.item.index)
  if (aIndex !== undefined && bIndex !== undefined && aIndex !== bIndex) return aIndex - bIndex
  if (aIndex !== undefined && bIndex === undefined) return -1
  if (aIndex === undefined && bIndex !== undefined) return 1

  return a.order - b.order
}

/**
 * Reconstruct the subagent spawn tree from either the current thin store rows
 * or the richer f7 progress shape. Missing/unknown parents are promoted to the
 * root. The input is never mutated.
 */
export function buildSubagentTree<T extends SubagentTreeItem>(items: readonly T[]): SubagentNode<T>[] {
  if (items.length === 0) return []

  // Event reducers normally guarantee one row per stable id. Disk replay is a
  // cross-version/untrusted boundary, though: keep the latest value for a
  // duplicate while preserving its first-seen order so malformed snapshots
  // cannot duplicate action targets or recursively expand the same branch.
  const unique = new Map<string, OrderedItem<T>>()
  items.forEach((item, order) => {
    const current = unique.get(item.id)
    if (current) current.item = item
    else unique.set(item.id, { item, order })
  })
  const entries = [...unique.values()]
  const known = new Set(unique.keys())
  const byParent = new Map<ParentKey, OrderedItem<T>[]>()

  const safeParent = (item: T): ParentKey => {
    const parent = item.parentId
    if (!parent || !known.has(parent) || parent === item.id) return ROOT

    // A corrupt A→B→A chain otherwise leaves both nodes unreachable (or makes
    // recursive builders overflow). Promote every member that observes its own
    // id in the raw parent chain to the root; valid descendants still attach.
    const seen = new Set<string>()
    let cursor: string | null | undefined = parent
    while (cursor && known.has(cursor)) {
      if (cursor === item.id) return ROOT
      // The chain entered an ancestor-only cycle. The current item is not a
      // member, so its direct parent remains a safe edge once those cycle
      // members are independently promoted to roots.
      if (seen.has(cursor)) return parent
      seen.add(cursor)
      cursor = unique.get(cursor)?.item.parentId
    }
    return parent
  }

  entries.forEach(entry => {
    const parentKey = safeParent(entry.item)
    const bucket = byParent.get(parentKey) ?? []
    bucket.push(entry)
    byParent.set(parentKey, bucket)
  })

  for (const bucket of byParent.values()) bucket.sort(compareOrdered)

  const build = (entry: OrderedItem<T>): SubagentNode<T> => {
    const children = (byParent.get(entry.item.id) ?? []).map(build)
    return { aggregate: aggregate(entry.item, children), children, item: entry.item }
  }

  return (byParent.get(ROOT) ?? []).map(build)
}

/** Roll up a node and all of its descendants. */
export function aggregate<T extends SubagentTreeItem>(
  item: T,
  children: readonly SubagentNode<T>[]
): SubagentAggregate {
  let totalTools = finiteOrZero(item.toolCount)
  let totalDuration = finiteOrZero(item.durationSeconds)
  let descendantCount = 0
  let activeCount = isRunning(item) ? 1 : 0
  let maxDepthFromHere = 0
  let inputTokens = finiteOrZero(item.inputTokens)
  let outputTokens = finiteOrZero(item.outputTokens)
  let costUsd = finiteOrZero(item.costUsd)
  let filesTouched = (item.filesRead?.length ?? 0) + (item.filesWritten?.length ?? 0)

  for (const child of children) {
    totalTools += child.aggregate.totalTools
    totalDuration += child.aggregate.totalDuration
    descendantCount += child.aggregate.descendantCount + 1
    activeCount += child.aggregate.activeCount
    maxDepthFromHere = Math.max(maxDepthFromHere, child.aggregate.maxDepthFromHere + 1)
    inputTokens += child.aggregate.inputTokens
    outputTokens += child.aggregate.outputTokens
    costUsd += child.aggregate.costUsd
    filesTouched += child.aggregate.filesTouched
  }

  return {
    activeCount,
    costUsd,
    descendantCount,
    filesTouched,
    hotness: totalDuration > 0 ? totalTools / totalDuration : 0,
    inputTokens,
    maxDepthFromHere,
    outputTokens,
    totalDuration,
    totalTools
  }
}

/** Count nodes at each rendered depth (index zero is the root level). */
export function widthByDepth<T extends SubagentTreeItem>(tree: readonly SubagentNode<T>[]): number[] {
  const widths: number[] = []

  const walk = (nodes: readonly SubagentNode<T>[], depth: number): void => {
    if (nodes.length === 0) return
    widths[depth] = (widths[depth] ?? 0) + nodes.length
    for (const node of nodes) walk(node.children, depth + 1)
  }

  walk(tree, 0)
  return widths
}

/** Fold every root into one full-tree aggregate. */
export function treeTotals<T extends SubagentTreeItem>(tree: readonly SubagentNode<T>[]): SubagentAggregate {
  let totalTools = 0
  let totalDuration = 0
  let descendantCount = 0
  let activeCount = 0
  let maxDepthFromHere = 0
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let filesTouched = 0

  for (const node of tree) {
    totalTools += node.aggregate.totalTools
    totalDuration += node.aggregate.totalDuration
    descendantCount += node.aggregate.descendantCount + 1
    activeCount += node.aggregate.activeCount
    maxDepthFromHere = Math.max(maxDepthFromHere, node.aggregate.maxDepthFromHere + 1)
    inputTokens += node.aggregate.inputTokens
    outputTokens += node.aggregate.outputTokens
    costUsd += node.aggregate.costUsd
    filesTouched += node.aggregate.filesTouched
  }

  return {
    activeCount,
    costUsd,
    descendantCount,
    filesTouched,
    hotness: totalDuration > 0 ? totalTools / totalDuration : 0,
    inputTokens,
    maxDepthFromHere,
    outputTokens,
    totalDuration,
    totalTools
  }
}

/** Depth-first, pre-order traversal used by selection and subtree actions. */
export function flattenTree<T extends SubagentTreeItem>(tree: readonly SubagentNode<T>[]): SubagentNode<T>[] {
  const out: SubagentNode<T>[] = []

  const walk = (nodes: readonly SubagentNode<T>[]): void => {
    for (const node of nodes) {
      out.push(node)
      walk(node.children)
    }
  }

  walk(tree)
  return out
}

/** Collect every descendant id, excluding the supplied node itself. */
export function descendantIds<T extends SubagentTreeItem>(node: SubagentNode<T>): string[] {
  const ids: string[] = []

  const walk = (children: readonly SubagentNode<T>[]): void => {
    for (const child of children) {
      ids.push(child.item.id)
      walk(child.children)
    }
  }

  walk(node.children)
  return ids
}

function knownSubagentStatus(status: unknown): SubagentStatus | undefined {
  if (typeof status !== 'string') return undefined

  const normalized = status.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  switch (normalized) {
    case 'complete':
    case 'completed':
    case 'done':
    case 'ok':
    case 'succeeded':
    case 'success':
      return 'completed'
    case 'error':
      return 'error'
    case 'failed':
    case 'failure':
      return 'failed'
    case 'canceled':
    case 'cancelled':
    case 'interrupted':
    case 'stopped':
      return 'interrupted'
    case 'timed_out':
    case 'timeout':
      return 'timeout'
    case 'pending':
    case 'queued':
    case 'spawn_requested':
      return 'queued'
    case 'replying':
    case 'running':
    case 'started':
    case 'thinking':
    case 'tool':
    case 'working':
      return 'running'
    default:
      return undefined
  }
}

function terminalStatus(status: SubagentStatus | undefined): TerminalSubagentStatus | undefined {
  switch (status) {
    case 'completed':
    case 'error':
    case 'failed':
    case 'interrupted':
    case 'timeout':
      return status
    case 'queued':
    case 'running':
    case undefined:
      return undefined
  }
}

/** Normalize thin live aliases and rich persisted values into the f7 status union. */
export function normalizeSubagentStatus(status: unknown, fallback: SubagentStatus = 'running'): SubagentStatus {
  return knownSubagentStatus(status) ?? fallback
}

/**
 * Normalize a completion payload to a terminal status. Unknown/non-terminal
 * values use `completed`, matching the f7 complete-event fallback.
 */
export function normalizeTerminalStatus(
  status: unknown,
  fallback: TerminalSubagentStatus = 'completed'
): TerminalSubagentStatus {
  return terminalStatus(knownSubagentStatus(status)) ?? fallback
}

/** True for canonical terminal values and current OpenTUI's `complete` alias. */
export function isTerminalStatus(status: unknown): boolean {
  return terminalStatus(knownSubagentStatus(status)) !== undefined
}

/** Preserve a final state when stale progress arrives; otherwise mark it live. */
export function keepTerminalElseRunning(status: unknown): SubagentStatus {
  return terminalStatus(knownSubagentStatus(status)) ?? 'running'
}

/** Running includes queued plus OpenTUI's transient thinking/tool/reply aliases. */
export function isRunning(item: Pick<SubagentTreeItem, 'status'>): boolean {
  const status = knownSubagentStatus(item.status)
  return status === 'queued' || status === 'running'
}

const SPARK_RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

/** Scale positive values against their peak; zero/invalid slots remain blank. */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return ''

  let max = 0
  for (const value of values) max = Math.max(max, finiteOrZero(value))
  if (max <= 0) return ' '.repeat(values.length)

  return values
    .map(value => {
      const normalized = finiteOrZero(value)
      if (normalized <= 0) return ' '
      const index = Math.min(
        SPARK_RAMP.length - 1,
        Math.max(0, Math.ceil((normalized / max) * (SPARK_RAMP.length - 1)))
      )
      return SPARK_RAMP[index]
    })
    .join('')
}

/** Normalize a branch's tools/second into a zero-based palette bucket. */
export function hotnessBucket(hotness: number, peak: number, buckets: number): number {
  const bucketCount = Number.isFinite(buckets) ? Math.max(0, Math.floor(buckets)) : 0
  if (!Number.isFinite(hotness) || hotness <= 0 || !Number.isFinite(peak) || peak <= 0 || bucketCount <= 1) return 0

  const ratio = Math.min(1, hotness / peak)
  return Math.min(bucketCount - 1, Math.max(0, Math.round(ratio * (bucketCount - 1))))
}

export function peakHotness<T extends SubagentTreeItem>(tree: readonly SubagentNode<T>[]): number {
  let peak = 0

  const walk = (nodes: readonly SubagentNode<T>[]): void => {
    for (const node of nodes) {
      peak = Math.max(peak, node.aggregate.hotness)
      walk(node.children)
    }
  }

  walk(tree)
  return peak
}

/** Top-level rows include orphans whose parent is absent from this snapshot. */
export function topLevelSubagents<T extends SubagentTreeItem>(items: readonly T[]): T[] {
  const ids = new Set(items.map(item => item.id))
  return items.filter(item => !item.parentId || !ids.has(item.parentId))
}

/** Compact seconds formatter shared by list, timeline, and summary surfaces. */
export function fmtDuration(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  if (safeSeconds < 60) return `${Math.round(safeSeconds)}s`

  const minutes = Math.floor(safeSeconds / 60)
  const remainder = Math.round(safeSeconds - minutes * 60)
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}

/** Compact token count: `542`, `1.2k`, `46k`. */
export function fmtTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${Math.round(tokens / 1000)}k`
}

/** Compact dollar amount used by the richer agents detail view. */
export function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return ''
  if (usd < 0.01) return '<$0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(1)}`
}

/** Compact one-line rollup, deliberately omitting cost from the headline. */
export function formatSummary(totals: SubagentAggregate): string {
  const pieces = [`d${Math.max(0, totals.maxDepthFromHere)}`]
  pieces.push(`${totals.descendantCount} agent${totals.descendantCount === 1 ? '' : 's'}`)
  if (totals.totalTools > 0) pieces.push(`${totals.totalTools} tool${totals.totalTools === 1 ? '' : 's'}`)
  if (totals.totalDuration > 0) pieces.push(fmtDuration(totals.totalDuration))

  const tokens = totals.inputTokens + totals.outputTokens
  if (tokens > 0) pieces.push(`${fmtTokens(tokens)} tok`)
  if (totals.activeCount > 0) pieces.push(`⚡${totals.activeCount}`)

  return pieces.join(' · ')
}
