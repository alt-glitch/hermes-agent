import { describe, expect, test } from 'vitest'
import { Option } from 'effect'

import {
  decodeDelegationPauseRequest,
  decodeDelegationPauseResponse,
  decodeDelegationStatusResponse,
  decodeSpawnTreeListRequest,
  decodeSpawnTreeListResponse,
  decodeSpawnTreeLoadRequest,
  decodeSpawnTreeLoadResponse,
  decodeSpawnTreeSaveRequest,
  decodeSpawnTreeSaveResponse,
  decodeSubagentInterruptRequest,
  decodeSubagentInterruptResponse,
  decodeUsageActiveSubagents
} from '../boundary/schema/Delegation.ts'

function expectSome<A>(value: Option.Option<A>): A {
  if (Option.isNone(value)) throw new Error('expected schema decode to succeed')
  return value.value
}

describe('delegation control schemas', () => {
  test('decodes the exact delegation.status result and preserves additive fields', () => {
    const result = expectSome(
      decodeDelegationStatusResponse({
        active: [
          {
            depth: 1,
            future_heartbeat_ms: 250,
            goal: 'review release wiring',
            last_tool: 'read_file',
            model: null,
            parent_id: 'sa-parent',
            started_at: 1_765_000_000.25,
            status: 'running',
            subagent_id: 'sa-1-abcd1234',
            tool_count: 4
          }
        ],
        future_cap_source: 'config.yaml',
        max_concurrent_children: 5,
        max_spawn_depth: 3,
        paused: false
      })
    )

    expect(result.active).toHaveLength(1)
    expect(result.active[0]?.subagent_id).toBe('sa-1-abcd1234')
    expect(result.active[0]?.parent_id).toBe('sa-parent')
    expect(result.active[0]?.model).toBeNull()
    expect(result.active[0]?.last_tool).toBe('read_file')
    expect(result.active[0]?.['future_heartbeat_ms']).toBe(250)
    expect(result['future_cap_source']).toBe('config.yaml')
  })

  test('fails closed on partial or type-invalid status results', () => {
    expect(Option.isNone(decodeDelegationStatusResponse({ active: [], paused: false }))).toBe(true)
    expect(
      Option.isNone(
        decodeDelegationStatusResponse({
          active: [{ subagent_id: 'thin' }],
          max_concurrent_children: 3,
          max_spawn_depth: 1,
          paused: false
        })
      )
    ).toBe(true)
    expect(
      Option.isNone(
        decodeDelegationStatusResponse({
          active: [],
          max_concurrent_children: 0,
          max_spawn_depth: 1,
          paused: false
        })
      )
    ).toBe(true)
  })

  test('decodes pause and targeted-interrupt request/result pairs', () => {
    expect(expectSome(decodeDelegationPauseRequest({ paused: true, reason: 'operator' }))).toEqual({
      paused: true,
      reason: 'operator'
    })
    expect(expectSome(decodeDelegationPauseResponse({ paused: false, effective_at: 42 }))).toEqual({
      effective_at: 42,
      paused: false
    })
    expect(expectSome(decodeSubagentInterruptRequest({ subagent_id: 'sa-7' }))).toEqual({
      subagent_id: 'sa-7'
    })
    expect(expectSome(decodeSubagentInterruptResponse({ found: false, subagent_id: 'sa-7' }))).toEqual({
      found: false,
      subagent_id: 'sa-7'
    })

    expect(Option.isNone(decodeDelegationPauseResponse({ paused: 'yes' }))).toBe(true)
    expect(Option.isNone(decodeSubagentInterruptRequest({ subagent_id: '' }))).toBe(true)
    expect(Option.isNone(decodeSubagentInterruptResponse({ found: true }))).toBe(true)
  })
})

const richSubagent = {
  api_calls: 7,
  child_session_id: 'child-session-1',
  cost_usd: 0.031,
  depth: 1,
  duration_seconds: 18.4,
  files_read: ['src/a.ts'],
  files_written: ['src/b.ts'],
  future_metric: { cache_hits: 4 },
  goal: 'port the Agents dashboard',
  input_tokens: 1200,
  iteration: 3,
  last_tool: 'write_file',
  model: 'cheap/model',
  notes: ['kept unknown fields'],
  output_tail: [
    {
      future_render_hint: 'diff',
      is_error: false,
      preview: 'updated two files',
      tool: 'terminal'
    }
  ],
  output_tokens: 320,
  parent_id: null,
  reasoning_tokens: 90,
  started_at: 1_765_000_000,
  status: 'completed',
  subagent_id: 'sa-0-abcd1234',
  summary: 'done',
  task_count: 2,
  task_index: 0,
  thinking: ['trace'],
  tool_count: 5,
  tools: ['terminal', 'read_file'],
  toolsets: ['terminal']
}

describe('spawn-tree RPC schemas', () => {
  test('decodes a non-empty save request and preserves rich/future fields', () => {
    const result = expectSome(
      decodeSpawnTreeSaveRequest({
        finished_at: 1_765_000_018.4,
        label: 'Agents parity',
        persistence_version: 2,
        session_id: 'session-1',
        started_at: null,
        subagents: [richSubagent]
      })
    )

    expect(result.subagents[0]?.api_calls).toBe(7)
    expect(result.subagents[0]?.parent_id).toBeNull()
    expect(result.subagents[0]?.last_tool).toBe('write_file')
    expect(result.subagents[0]?.['future_metric']).toEqual({ cache_hits: 4 })
    expect(result.subagents[0]?.output_tail?.[0]?.['future_render_hint']).toBe('diff')
    expect(result['persistence_version']).toBe(2)

    expect(Option.isNone(decodeSpawnTreeSaveRequest({ subagents: [] }))).toBe(true)
    expect(Option.isNone(decodeSpawnTreeSaveRequest({ subagents: 'not-an-array' }))).toBe(true)
  })

  test('keeps older camelCase snapshot fields as forward-compatible records', () => {
    const result = expectSome(
      decodeSpawnTreeSaveRequest({
        subagents: [
          {
            depth: 0,
            durationSeconds: 2,
            goal: 'legacy Ink row',
            id: 'legacy-1',
            index: 0,
            status: 'completed',
            toolCount: 1
          }
        ]
      })
    )
    expect(result.subagents[0]?.['id']).toBe('legacy-1')
    expect(result.subagents[0]?.['durationSeconds']).toBe(2)
    expect(result.subagents[0]?.['toolCount']).toBe(1)
  })

  test('decodes save/list request and response contracts', () => {
    expect(expectSome(decodeSpawnTreeSaveResponse({ path: '/trees/s1/one.json', session_id: 's1' }))).toEqual({
      path: '/trees/s1/one.json',
      session_id: 's1'
    })
    expect(expectSome(decodeSpawnTreeListRequest({ cross_session: true, limit: 30, session_id: 's1' }))).toEqual({
      cross_session: true,
      limit: 30,
      session_id: 's1'
    })
    expect(expectSome(decodeSpawnTreeLoadRequest({ path: '/trees/s1/one.json' }))).toEqual({
      path: '/trees/s1/one.json'
    })

    expect(Option.isNone(decodeSpawnTreeSaveResponse({ path: '/trees/s1/one.json' }))).toBe(true)
    expect(Option.isNone(decodeSpawnTreeListRequest({ limit: 0 }))).toBe(true)
    expect(Option.isNone(decodeSpawnTreeLoadRequest({ path: '' }))).toBe(true)
  })

  test('decodes indexed list rows and fails the response closed on a malformed row', () => {
    const result = expectSome(
      decodeSpawnTreeListResponse({
        entries: [
          {
            count: 2,
            finished_at: 1_765_000_020,
            label: 'fanout',
            path: '/trees/s1/one.json',
            session_id: 's1',
            started_at: null,
            storage_class: 'local'
          }
        ],
        next_cursor: 'future'
      })
    )
    expect(result.entries[0]?.path).toBe('/trees/s1/one.json')
    expect(result.entries[0]?.['storage_class']).toBe('local')
    expect(result['next_cursor']).toBe('future')

    expect(Option.isNone(decodeSpawnTreeListResponse({ entries: [{ count: 1 }] }))).toBe(true)
    expect(Option.isNone(decodeSpawnTreeListResponse({ entries: [{ count: -1, path: '/bad' }] }))).toBe(true)
  })

  test('decodes loaded rich trees without stripping top-level or nested future fields', () => {
    const result = expectSome(
      decodeSpawnTreeLoadResponse({
        archive_format: 'v2',
        finished_at: 1_765_000_020,
        label: 'fanout',
        session_id: 's1',
        started_at: 1_765_000_000,
        subagents: [richSubagent]
      })
    )
    expect(result.subagents[0]?.subagent_id).toBe('sa-0-abcd1234')
    expect(result.subagents[0]?.files_written).toEqual(['src/b.ts'])
    expect(result.subagents[0]?.['future_metric']).toEqual({ cache_hits: 4 })
    expect(result['archive_format']).toBe('v2')

    expect(Option.isNone(decodeSpawnTreeLoadResponse({ label: 'missing rows' }))).toBe(true)
    expect(Option.isNone(decodeSpawnTreeLoadResponse({ subagents: [null] }))).toBe(true)
  })
})

describe('usage.active_subagents schema', () => {
  test('preserves authoritative zero/nonzero counts and unrelated usage fields', () => {
    const running = expectSome(decodeUsageActiveSubagents({ active_subagents: 4, input: 1200 }))
    expect(running.active_subagents).toBe(4)
    expect(running['input']).toBe(1200)

    const idle = expectSome(decodeUsageActiveSubagents({ active_subagents: 0 }))
    expect(idle.active_subagents).toBe(0)
  })

  test('allows the documented omission but rejects a malformed count', () => {
    expect(expectSome(decodeUsageActiveSubagents({ calls: 2 })).active_subagents).toBeUndefined()
    expect(Option.isNone(decodeUsageActiveSubagents({ active_subagents: '4' }))).toBe(true)
    expect(Option.isNone(decodeUsageActiveSubagents({ active_subagents: -1 }))).toBe(true)
  })
})
