import { describe, expect, test } from 'vitest'

import {
  captureLiveSpawnTree,
  diffSpawnHistory,
  diffSpawnSnapshots,
  emptySpawnHistory,
  listSpawnHistory,
  loadSpawnTree,
  selectSpawnSnapshot,
  stableSpawnAgentId,
  type SpawnHistoryState,
  type SpawnSnapshot
} from '../logic/spawnHistory.ts'

function capture(
  state: SpawnHistoryState,
  id: string,
  finishedAtMs: number,
  subagents: readonly unknown[] = [{ goal: id, id: `agent-${id}`, status: 'completed' }]
): { snapshot: SpawnSnapshot; state: SpawnHistoryState } {
  const result = captureLiveSpawnTree(state, subagents, {
    finishedAtMs,
    id,
    sessionId: 'session-1',
    startedAtMs: finishedAtMs - 100
  })
  expect(result.snapshot).not.toBeNull()
  return { snapshot: result.snapshot!, state: result.state }
}

describe('spawn history capture', () => {
  test('copies and deeply freezes live rows before the reducer clears them', () => {
    const source = {
      depth: 0,
      future_metric: { samples: [1, 2] },
      goal: 'research',
      model: 'cheap/model',
      subagent_id: 'sa-1',
      task_index: 0
    }
    // Solid stores expose proxy rows; structuredClone(proxy) throws.
    const live = [new Proxy(source, {})]
    const result = captureLiveSpawnTree(emptySpawnHistory(), live, {
      finishedAtMs: 2_000,
      sessionId: 's1',
      startedAtMs: 1_000
    })

    source.goal = 'mutated after capture'
    source.future_metric.samples.push(3)
    live.splice(0)

    expect(result.snapshot?.subagents).toEqual([
      {
        depth: 0,
        future_metric: { samples: [1, 2] },
        goal: 'research',
        model: 'cheap/model',
        subagent_id: 'sa-1',
        task_index: 0
      }
    ])
    expect(Object.isFrozen(result.snapshot)).toBe(true)
    expect(Object.isFrozen(result.snapshot?.subagents[0]?.['future_metric'])).toBe(true)
  })

  test('drops empty captures and keeps exactly the newest ten snapshots', () => {
    const empty = emptySpawnHistory()
    expect(captureLiveSpawnTree(empty, [], { finishedAtMs: 1 }).state).toBe(empty)

    let state = empty
    for (let index = 1; index <= 12; index += 1) {
      state = capture(state, `snap-${String(index)}`, index).state
    }

    expect(state.snapshots).toHaveLength(10)
    expect(state.snapshots.map(snapshot => snapshot.id)).toEqual([
      'snap-12',
      'snap-11',
      'snap-10',
      'snap-9',
      'snap-8',
      'snap-7',
      'snap-6',
      'snap-5',
      'snap-4',
      'snap-3'
    ])
  })

  test('uses deterministic stable ids for snake_case, camelCase, and legacy rows', () => {
    expect(stableSpawnAgentId({ subagent_id: 'issued' })).toBe('issued')
    expect(stableSpawnAgentId({ id: 'ink-issued' })).toBe('ink-issued')
    const legacy = { goal: 'same goal', parent_id: 'parent', task_index: 2 }
    expect(stableSpawnAgentId(legacy)).toBe(stableSpawnAgentId(structuredClone(legacy), 99))
    expect(stableSpawnAgentId(legacy)).toContain('legacy:parent:2:')
  })
})

describe('spawn history list, select, and disk load', () => {
  test('lists newest-first with one-based indexes and selects without mutating history', () => {
    const first = capture(emptySpawnHistory(), 'first', 1_000)
    const second = capture(first.state, 'second', 2_000)
    const before = second.state.snapshots

    expect(listSpawnHistory(second.state).map(entry => ({ id: entry.id, index: entry.index }))).toEqual([
      { id: 'second', index: 1 },
      { id: 'first', index: 2 }
    ])
    expect(selectSpawnSnapshot(second.state, { index: 1 })?.id).toBe('second')
    expect(selectSpawnSnapshot(second.state, { id: 'first' })?.id).toBe('first')
    expect(selectSpawnSnapshot(second.state, { index: 0 })).toBeUndefined()
    expect(selectSpawnSnapshot(second.state, { index: 3 })).toBeUndefined()
    expect(second.state.snapshots).toBe(before)
  })

  test('loads rich snake_case gateway payloads without dropping future fields', () => {
    const payload = {
      archive_version: 7,
      finished_at: 1_700_000_010,
      label: 'fan-out',
      session_id: 'sid-7',
      started_at: 1_700_000_000,
      subagents: [
        {
          api_calls: 4,
          cost_usd: 0.08,
          files_read: ['a.ts'],
          future_rollup: { cache_hits: 9 },
          goal: 'audit',
          input_tokens: 120,
          output_tail: [{ is_error: false, preview: 'ok', tool: 'read_file' }],
          parent_id: null,
          status: 'timeout',
          subagent_id: 'sa-rich',
          task_index: 0,
          tool_count: 3
        }
      ]
    }
    const loaded = loadSpawnTree(emptySpawnHistory(), payload, {
      nowMs: 99,
      path: '/spawn/sid-7/tree.json'
    })
    const snapshot = loaded.snapshot!

    expect(snapshot).toMatchObject({
      finishedAtMs: 1_700_000_010_000,
      label: 'fan-out',
      path: '/spawn/sid-7/tree.json',
      sessionId: 'sid-7',
      source: 'disk',
      startedAtMs: 1_700_000_000_000
    })
    expect(snapshot.metadata['archive_version']).toBe(7)
    expect(snapshot.metadata).not.toHaveProperty('subagents')
    expect(snapshot.subagents[0]).toEqual(payload.subagents[0])
    expect(selectSpawnSnapshot(loaded.state, { path: '/spawn/sid-7/tree.json' })).toBe(snapshot)
  })

  test('loading the same path replaces its prior row and malformed loads are no-ops', () => {
    const first = loadSpawnTree(
      emptySpawnHistory(),
      {
        finished_at: 10,
        subagents: [{ goal: 'old', subagent_id: 'a' }]
      },
      { path: '/same.json' }
    )
    const second = loadSpawnTree(
      first.state,
      {
        finished_at: 20,
        subagents: [{ goal: 'new', subagent_id: 'a' }]
      },
      { path: '/same.json' }
    )

    expect(second.state.snapshots).toHaveLength(1)
    expect(second.state.snapshots[0]?.subagents[0]?.['goal']).toBe('new')
    expect(loadSpawnTree(second.state, { subagents: [] }).state).toBe(second.state)
    expect(loadSpawnTree(second.state, { subagents: 'bad' }).state).toBe(second.state)
  })
})

describe('spawn replay diff', () => {
  function pair(): { baseline: SpawnSnapshot; candidate: SpawnSnapshot; state: SpawnHistoryState } {
    const baseline = capture(emptySpawnHistory(), 'baseline', 1_000, [
      { goal: 'removed', id: 'sa-removed', status: 'completed', toolCount: 1 },
      {
        future: { score: 1 },
        goal: 'changed',
        id: 'sa-changed',
        status: 'running',
        toolCount: 2
      },
      { goal: 'same', id: 'sa-same', status: 'completed', toolCount: 1 }
    ])
    const candidate = capture(baseline.state, 'candidate', 2_000, [
      {
        future: { score: 2 },
        goal: 'changed',
        status: 'completed',
        subagent_id: 'sa-changed',
        tool_count: 3
      },
      { goal: 'same', status: 'completed', subagent_id: 'sa-same', tool_count: 1 },
      { goal: 'added', status: 'queued', subagent_id: 'sa-added', tool_count: 0 }
    ])
    return { baseline: baseline.snapshot, candidate: candidate.snapshot, state: candidate.state }
  }

  test('reports added, removed, and changed rows by issued stable id', () => {
    const { baseline, candidate } = pair()
    const diff = diffSpawnSnapshots(baseline, candidate)

    expect(diff.added.map(item => item.id)).toEqual(['sa-added'])
    expect(diff.removed.map(item => item.id)).toEqual(['sa-removed'])
    expect(diff.unchangedIds).toEqual(['sa-same'])
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]).toMatchObject({ id: 'sa-changed' })
    expect(diff.changed[0]?.changedFields).toEqual(['future', 'status', 'tool_count'])
  })

  test('canonicalizes snake/camel aliases so representation alone is not a change', () => {
    const left = capture(emptySpawnHistory(), 'left', 1, [
      {
        id: 'sa-1',
        lastTool: 'read_file',
        outputTail: [{ isError: false, preview: 'ok', tool: 'read_file' }],
        parentId: 'p',
        startedAt: 1_700_000_000_000,
        status: 'completed',
        toolCount: 2
      }
    ])
    const right = capture(left.state, 'right', 2, [
      {
        last_tool: 'read_file',
        output_tail: [{ is_error: false, preview: 'ok', tool: 'read_file' }],
        parent_id: 'p',
        started_at: 1_700_000_000,
        status: 'completed',
        subagent_id: 'sa-1',
        tool_count: 2
      }
    ])

    expect(diffSpawnSnapshots(left.snapshot, right.snapshot).unchangedIds).toEqual(['sa-1'])
  })

  test('resolves diff selectors read-only and never resurrects removed agents into the candidate', () => {
    const { candidate, state } = pair()
    const before = state.snapshots
    const diff = diffSpawnHistory(state, { baseline: { id: 'baseline' }, candidate: { index: 1 } })

    expect(diff?.candidateId).toBe('candidate')
    expect(candidate.subagents.map(agent => stableSpawnAgentId(agent))).not.toContain('sa-removed')
    expect(state.snapshots).toBe(before)
    expect(diffSpawnHistory(state, { baseline: { id: 'missing' }, candidate: { index: 1 } })).toBeUndefined()
  })
})
