import { describe, expect, test } from 'vitest'

import {
  buildSubagentTree,
  descendantIds,
  flattenTree,
  fmtCost,
  fmtDuration,
  fmtTokens,
  formatSummary,
  hotnessBucket,
  isRunning,
  isTerminalStatus,
  keepTerminalElseRunning,
  normalizeSubagentStatus,
  normalizeTerminalStatus,
  peakHotness,
  sparkline,
  topLevelSubagents,
  treeTotals,
  type SubagentAggregate,
  type SubagentTreeItem,
  widthByDepth
} from '../logic/subagentTree.ts'
import type { SubagentInfo } from '../logic/store.ts'

interface RichItem extends SubagentTreeItem {
  goal: string
}

const makeItem = (overrides: Partial<RichItem> & Pick<RichItem, 'id'>): RichItem => ({
  depth: 0,
  goal: overrides.id,
  status: 'running',
  ...overrides
})

const emptyTotals: SubagentAggregate = {
  activeCount: 0,
  costUsd: 0,
  descendantCount: 0,
  filesTouched: 0,
  hotness: 0,
  inputTokens: 0,
  maxDepthFromHere: 0,
  outputTokens: 0,
  totalDuration: 0,
  totalTools: 0
}

describe('subagent tree construction', () => {
  test('accepts the current thin SubagentInfo shape and preserves source order without indices', () => {
    const currentRows = [
      { depth: 0, goal: 'first', id: 'first', status: 'working' },
      { depth: 0, goal: 'second', id: 'second', status: 'thinking' }
    ] satisfies SubagentInfo[]

    expect(buildSubagentTree(currentRows).map(node => node.item.id)).toEqual(['first', 'second'])
  })

  test('nests rich rows, promotes missing parents, and sorts siblings by depth/index', () => {
    const items = [
      makeItem({ id: 'root', index: 0 }),
      makeItem({ depth: 1, id: 'child-3', index: 2, parentId: 'root' }),
      makeItem({ depth: 1, id: 'child-1', index: 0, parentId: 'root' }),
      makeItem({ depth: 2, id: 'grandchild', index: 0, parentId: 'child-1' }),
      makeItem({ depth: 1, id: 'child-2', index: 1, parentId: 'root' }),
      makeItem({ depth: 4, id: 'orphan', index: 1, parentId: 'missing' })
    ]

    const tree = buildSubagentTree(items)
    expect(tree.map(node => node.item.id)).toEqual(['root', 'orphan'])
    expect(tree[0]!.children.map(node => node.item.id)).toEqual(['child-1', 'child-2', 'child-3'])
    expect(tree[0]!.children[0]!.children[0]!.item.id).toBe('grandchild')
    expect(tree[0]!.aggregate).toMatchObject({ descendantCount: 4, maxDepthFromHere: 2 })
  })

  test('does not mutate the caller-owned input array', () => {
    const items = [
      makeItem({ id: 'root', index: 0 }),
      makeItem({ depth: 1, id: 'later', index: 2, parentId: 'root' }),
      makeItem({ depth: 1, id: 'earlier', index: 1, parentId: 'root' })
    ]
    const before = items.map(item => item.id)

    buildSubagentTree(items)
    expect(items.map(item => item.id)).toEqual(before)
  })

  test('fails safe on cyclic parents and duplicate stable ids', () => {
    const items = [
      makeItem({ id: 'cycle-a', parentId: 'cycle-b', status: 'running' }),
      makeItem({ id: 'cycle-b', parentId: 'cycle-a' }),
      makeItem({ id: 'self', parentId: 'self' }),
      makeItem({ depth: 1, id: 'valid-child', parentId: 'cycle-a' }),
      makeItem({ id: 'duplicate', status: 'running' }),
      makeItem({ id: 'duplicate', status: 'completed' })
    ]

    const tree = buildSubagentTree(items)
    expect(tree.map(node => node.item.id)).toEqual(['cycle-a', 'cycle-b', 'self', 'duplicate'])
    expect(tree[0]!.children.map(node => node.item.id)).toEqual(['valid-child'])
    expect(flattenTree(tree).map(node => node.item.id)).toEqual([
      'cycle-a',
      'valid-child',
      'cycle-b',
      'self',
      'duplicate'
    ])
    expect(tree.at(-1)!.item.status).toBe('completed')
  })

  test('empty input remains empty', () => {
    expect(buildSubagentTree([])).toEqual([])
  })
})

describe('subagent tree traversal and aggregates', () => {
  const items = [
    makeItem({
      costUsd: 0.01,
      durationSeconds: 10,
      filesRead: ['a.ts', 'b.ts'],
      id: 'parent',
      index: 0,
      inputTokens: 1000,
      outputTokens: 500,
      status: 'working',
      toolCount: 5
    }),
    makeItem({
      costUsd: 0.005,
      depth: 1,
      durationSeconds: 4,
      filesWritten: ['c.ts'],
      id: 'child-1',
      index: 0,
      inputTokens: 500,
      outputTokens: 100,
      parentId: 'parent',
      status: 'queued',
      toolCount: 3
    }),
    makeItem({
      costUsd: 0.008,
      depth: 2,
      durationSeconds: 2,
      id: 'grandchild',
      index: 0,
      inputTokens: 300,
      outputTokens: 200,
      parentId: 'child-1',
      status: 'complete',
      toolCount: 1
    }),
    makeItem({
      depth: 1,
      durationSeconds: 1,
      id: 'child-2',
      index: 1,
      parentId: 'parent',
      status: 'failed',
      toolCount: 4
    })
  ]

  test('rolls up tools, durations, tokens, cost, files, depth, active count, and hotness', () => {
    const aggregate = buildSubagentTree(items)[0]!.aggregate
    expect(aggregate).toMatchObject({
      activeCount: 2,
      costUsd: 0.023,
      descendantCount: 3,
      filesTouched: 3,
      inputTokens: 1800,
      maxDepthFromHere: 2,
      outputTokens: 800,
      totalDuration: 17,
      totalTools: 13
    })
    expect(aggregate.hotness).toBeCloseTo(13 / 17)
  })

  test('flattens pre-order and collects descendants without the selected node', () => {
    const tree = buildSubagentTree(items)
    expect(flattenTree(tree).map(node => node.item.id)).toEqual(['parent', 'child-1', 'grandchild', 'child-2'])
    expect(descendantIds(tree[0]!)).toEqual(['child-1', 'grandchild', 'child-2'])
  })

  test('computes widths and full-tree totals', () => {
    const tree = buildSubagentTree([...items, makeItem({ id: 'other-root', index: 1, toolCount: 2 })])
    expect(widthByDepth(tree)).toEqual([2, 2, 1])
    expect(treeTotals(tree)).toMatchObject({ descendantCount: 5, maxDepthFromHere: 3, totalTools: 15 })
    expect(treeTotals([])).toEqual(emptyTotals)
  })

  test('top-level selection uses the same orphan rule as construction', () => {
    const rows = [...items, makeItem({ id: 'orphan', index: 2, parentId: 'gone' })]
    expect(topLevelSubagents(rows).map(item => item.id)).toEqual(['parent', 'orphan'])
  })

  test('invalid or negative metric values cannot poison a subtree aggregate', () => {
    const tree = buildSubagentTree([
      makeItem({
        costUsd: Number.NaN,
        durationSeconds: -2,
        id: 'invalid',
        inputTokens: Number.POSITIVE_INFINITY,
        outputTokens: -4,
        toolCount: Number.NaN
      })
    ])
    expect(tree[0]!.aggregate).toMatchObject({
      costUsd: 0,
      hotness: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalDuration: 0,
      totalTools: 0
    })
  })
})

describe('subagent status normalization', () => {
  test.each([
    ['completed', 'completed'],
    ['complete', 'completed'],
    ['SUCCESS', 'completed'],
    ['error', 'error'],
    ['failure', 'failed'],
    ['cancelled', 'interrupted'],
    ['timed-out', 'timeout'],
    ['pending', 'queued'],
    ['spawn requested', 'queued'],
    ['thinking', 'running'],
    ['tool', 'running'],
    ['replying', 'running']
  ] as const)('normalizes %s to %s', (input, expected) => {
    expect(normalizeSubagentStatus(input)).toBe(expected)
  })

  test('unknown values honor explicit general and terminal fallbacks', () => {
    expect(normalizeSubagentStatus('mystery', 'failed')).toBe('failed')
    expect(normalizeSubagentStatus(undefined, 'queued')).toBe('queued')
    expect(normalizeTerminalStatus('working')).toBe('completed')
    expect(normalizeTerminalStatus('mystery', 'timeout')).toBe('timeout')
  })

  test('recognizes terminal aliases without treating live aliases as terminal', () => {
    for (const status of ['completed', 'complete', 'failed', 'error', 'interrupted', 'timeout', 'cancelled']) {
      expect(isTerminalStatus(status)).toBe(true)
    }
    for (const status of ['queued', 'running', 'working', 'thinking', 'tool', 'replying', 'mystery']) {
      expect(isTerminalStatus(status)).toBe(false)
    }
  })

  test('preserves terminal states across stale progress and counts all thin live aliases as active', () => {
    expect(keepTerminalElseRunning('complete')).toBe('completed')
    expect(keepTerminalElseRunning('timeout')).toBe('timeout')
    expect(keepTerminalElseRunning('thinking')).toBe('running')
    expect(isRunning({ status: 'queued' })).toBe(true)
    expect(isRunning({ status: 'working' })).toBe(true)
    expect(isRunning({ status: 'replying' })).toBe(true)
    expect(isRunning({ status: 'complete' })).toBe(false)
    expect(isRunning({ status: 'mystery' })).toBe(false)
  })
})

describe('tree visualization helpers', () => {
  test('sparkline keeps zeroes blank and scales the peak to the full block', () => {
    expect(sparkline([])).toBe('')
    expect(sparkline([0, Number.NaN])).toBe('  ')
    const line = sparkline([0, 1, 8, 4])
    expect(line[0]).toBe(' ')
    expect(line[2]).toBe('█')
    expect([...line].every(character => /[\s▁-█]/.test(character))).toBe(true)
  })

  test('peak hotness walks descendants and palette buckets clamp safely', () => {
    const tree = buildSubagentTree([
      makeItem({ durationSeconds: 100, id: 'root', index: 0, toolCount: 1 }),
      makeItem({ depth: 1, durationSeconds: 1, id: 'hot', index: 0, parentId: 'root', toolCount: 5 })
    ])
    expect(peakHotness(tree)).toBe(5)
    expect(hotnessBucket(0, 10, 4)).toBe(0)
    expect(hotnessBucket(5, 10, 4)).toBe(2)
    expect(hotnessBucket(10, 10, 4)).toBe(3)
    expect(hotnessBucket(100, 10, 4)).toBe(3)
    expect(hotnessBucket(5, 0, 4)).toBe(0)
    expect(hotnessBucket(5, 10, 1)).toBe(0)
  })
})

describe('subagent compact formatters', () => {
  test.each([
    [0, '0s'],
    [42, '42s'],
    [59.4, '59s'],
    [60, '1m'],
    [134, '2m 14s'],
    [605, '10m 5s'],
    [Number.NaN, '0s']
  ])('formats duration %s as %s', (seconds, expected) => {
    expect(fmtDuration(seconds)).toBe(expected)
  })

  test.each([
    [0, '0'],
    [542, '542'],
    [1234, '1.2k'],
    [45_678, '46k'],
    [Number.POSITIVE_INFINITY, '0']
  ])('formats token count %s as %s', (tokens, expected) => {
    expect(fmtTokens(tokens)).toBe(expected)
  })

  test('formats cost ranges and a rich summary', () => {
    expect(fmtCost(0)).toBe('')
    expect(fmtCost(0.001)).toBe('<$0.01')
    expect(fmtCost(0.42)).toBe('$0.42')
    expect(fmtCost(12.5)).toBe('$12.5')
    expect(
      formatSummary({
        ...emptyTotals,
        activeCount: 2,
        costUsd: 0.42,
        descendantCount: 7,
        inputTokens: 8000,
        maxDepthFromHere: 3,
        outputTokens: 2000,
        totalDuration: 134,
        totalTools: 124
      })
    ).toBe('d3 · 7 agents · 124 tools · 2m 14s · 10k tok · ⚡2')
  })
})
