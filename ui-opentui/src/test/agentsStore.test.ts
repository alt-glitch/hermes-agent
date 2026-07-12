import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import { createSessionStore, type SessionStore } from '../logic/store.ts'

const decodeEvent = Schema.decodeUnknownOption(GatewayEventSchema)

function startTurn(store: SessionStore): void {
  store.apply({ type: 'message.start' })
}

function spawn(store: SessionStore, id: string, goal = id, index = 0): void {
  store.apply({
    type: 'subagent.start',
    payload: { depth: 0, goal, subagent_id: id, task_count: 1, task_index: index }
  })
}

describe('Agents gateway schemas', () => {
  test('decodes every rich f7 subagent field and preserves additive fields', () => {
    const decoded = decodeEvent({
      type: 'subagent.complete',
      session_id: 'sid-1',
      payload: {
        api_calls: 4,
        child_session_id: 'child-1',
        cost_usd: 0.25,
        depth: 2,
        duration_seconds: 8.5,
        files_read: ['a.ts'],
        files_written: ['b.ts'],
        future_metric: { p99: 7 },
        goal: 'audit',
        input_tokens: 100,
        iteration: 3,
        model: 'claude',
        output_tail: [{ is_error: false, preview: 'ok', tool: 'read_file' }],
        output_tokens: 50,
        parent_id: 'root',
        reasoning_tokens: 12,
        status: 'completed',
        subagent_id: 'a1',
        summary: 'done',
        task_count: 3,
        task_index: 1,
        text: 'final',
        tool_count: 5,
        tool_name: 'read_file',
        tool_preview: 'a.ts',
        toolsets: ['terminal']
      }
    })

    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isSome(decoded) && decoded.value.type === 'subagent.complete') {
      expect(decoded.value.payload).toMatchObject({
        api_calls: 4,
        child_session_id: 'child-1',
        cost_usd: 0.25,
        duration_seconds: 8.5,
        subagent_id: 'a1',
        task_index: 1
      })
      expect(decoded.value.payload['future_metric']).toEqual({ p99: 7 })
    }
  })

  test('rejects a wrong-typed known rich field instead of leaking it into state', () => {
    expect(
      Option.isNone(
        decodeEvent({
          type: 'subagent.complete',
          payload: { api_calls: 'many', goal: 'audit', subagent_id: 'a1', task_index: 0 }
        })
      )
    ).toBe(true)
  })
})

describe('Agents live reducer', () => {
  test('maps the full snake_case payload into one canonical camelCase row', () => {
    const store = createSessionStore()
    startTurn(store)
    store.apply({
      type: 'subagent.start',
      payload: {
        api_calls: 4,
        child_session_id: 'child-1',
        cost_usd: 0.25,
        depth: 2,
        duration_seconds: 8.5,
        files_read: ['a.ts'],
        files_written: ['b.ts'],
        goal: 'audit',
        input_tokens: 100,
        iteration: 3,
        last_tool: 'read_file',
        model: 'claude',
        notes: ['seed note'],
        output_tail: [{ is_error: false, preview: 'ok', tool: 'read_file' }],
        output_tokens: 50,
        parent_id: 'root',
        reasoning_tokens: 12,
        started_at: 1_700_000_000,
        subagent_id: 'a1',
        summary: 'partial',
        task_count: 3,
        task_index: 1,
        thinking: ['seed thought'],
        tool_count: 5,
        tools: ['Seed Tool'],
        toolsets: ['terminal']
      }
    })

    expect(store.state.subagents[0]).toEqual(
      expect.objectContaining({
        apiCalls: 4,
        childSessionId: 'child-1',
        costUsd: 0.25,
        depth: 2,
        durationSeconds: 8.5,
        filesRead: ['a.ts'],
        filesWritten: ['b.ts'],
        goal: 'audit',
        id: 'a1',
        index: 1,
        inputTokens: 100,
        iteration: 3,
        lastTool: 'read_file',
        model: 'claude',
        notes: ['seed note'],
        outputTail: [{ isError: false, preview: 'ok', tool: 'read_file' }],
        outputTokens: 50,
        parentId: 'root',
        reasoningTokens: 12,
        startedAt: 1_700_000_000_000,
        status: 'running',
        summary: 'partial',
        taskCount: 3,
        thinking: ['seed thought'],
        toolCount: 5,
        tools: ['Seed Tool'],
        toolsets: ['terminal']
      })
    )
  })

  test('uses the f7 legacy composite id when an older gateway omits subagent_id', () => {
    const store = createSessionStore()
    store.apply({ type: 'subagent.spawn_requested', payload: { goal: 'legacy task', task_index: 2 } })
    expect(store.state.subagents[0]).toMatchObject({ id: 'sa:2:legacy task', status: 'queued' })
  })

  test('post-start variants are update-only and never resurrect a cleared or missed row', () => {
    const store = createSessionStore()
    store.apply({ type: 'subagent.thinking', payload: { subagent_id: 'missing', text: 'late' } })
    store.apply({ type: 'subagent.tool', payload: { subagent_id: 'missing', tool_name: 'bash' } })
    store.apply({ type: 'subagent.progress', payload: { subagent_id: 'missing', text: 'late' } })
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'missing', summary: 'late' } })
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'missing', text: 'late' } })
    expect(store.state.subagents).toEqual([])

    spawn(store, 'a1')
    store.clearTranscript()
    store.apply({ type: 'subagent.progress', payload: { subagent_id: 'a1', text: 'after clear' } })
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a1', summary: 'after clear' } })
    expect(store.state.subagents).toEqual([])

    store.apply({ type: 'subagent.start', payload: { subagent_id: 'a1' } })
    expect(store.state.subagents).toHaveLength(1)
  })

  test('terminal state survives stale spawn/start/thinking/tool/progress/text events', () => {
    const store = createSessionStore()
    spawn(store, 'a1')
    store.apply({ type: 'subagent.complete', payload: { status: 'failed', subagent_id: 'a1' } })
    expect(store.state.subagents[0]?.status).toBe('failed')

    store.apply({ type: 'subagent.spawn_requested', payload: { subagent_id: 'a1' } })
    store.apply({ type: 'subagent.start', payload: { subagent_id: 'a1' } })
    store.apply({ type: 'subagent.thinking', payload: { subagent_id: 'a1', text: 'late thought' } })
    store.apply({ type: 'subagent.tool', payload: { subagent_id: 'a1', tool_name: 'bash' } })
    store.apply({ type: 'subagent.progress', payload: { subagent_id: 'a1', text: 'late progress' } })
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: 'late reply' } })
    expect(store.state.subagents[0]?.status).toBe('failed')
  })

  test('subagent.text coalescing preserves boundary whitespace byte-for-byte', () => {
    const store = createSessionStore()
    spawn(store, 'a1')
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: 'The release' } })
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: ' ships two ' } })
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: 'features.' } })
    expect(store.state.subagents[0]?.trace?.at(-1)).toEqual({
      kind: 'reply',
      text: 'The release ships two features.'
    })
  })
})

describe('Agents turn archives and delivery intents', () => {
  test('normal completion snapshots synchronously, queues save intent, then clears live rows', () => {
    const store = createSessionStore()
    store.setSessionId('sid-1')
    startTurn(store)
    spawn(store, 'a1', 'research')
    store.apply({ type: 'subagent.complete', payload: { status: 'completed', subagent_id: 'a1', summary: 'done' } })
    store.apply({ type: 'message.complete', payload: { text: 'answer' } })

    expect(store.state.subagents).toEqual([])
    expect(store.state.spawnHistory.snapshots).toHaveLength(1)
    expect(store.state.spawnHistory.snapshots[0]?.subagents[0]).toMatchObject({
      goal: 'research',
      id: 'a1',
      status: 'completed'
    })
    const intent = store.nextSpawnTreeSaveIntent()
    expect(intent?.request).toMatchObject({ label: 'research', session_id: 'sid-1' })
    expect(intent?.request.subagents).toHaveLength(1)

    startTurn(store)
    spawn(store, 'a1', 'new goal')
    expect(store.state.spawnHistory.snapshots[0]?.subagents[0]?.['goal']).toBe('research')
  })

  test('history and persistence intent queues retain only the newest ten trees', () => {
    const store = createSessionStore()
    for (let turn = 0; turn < 12; turn += 1) {
      startTurn(store)
      spawn(store, `a${String(turn)}`, `goal ${String(turn)}`)
      store.apply({ type: 'message.complete' })
    }
    expect(store.state.spawnHistory.snapshots).toHaveLength(10)
    expect(store.state.spawnTreeSaveIntents).toHaveLength(10)
    expect(store.state.spawnHistory.snapshots[0]?.subagents[0]?.['goal']).toBe('goal 11')
  })

  test('error and actual child exit archive; a post-complete exit cannot duplicate', () => {
    const store = createSessionStore()
    startTurn(store)
    spawn(store, 'error-agent')
    store.apply({ type: 'error', payload: { message: 'turn failed' } })
    expect(store.state.spawnHistory.snapshots).toHaveLength(1)
    expect(store.state.subagents).toEqual([])

    startTurn(store)
    spawn(store, 'exit-agent')
    store.apply({ type: 'gateway.exited', payload: { reason: 'SIGKILL' } })
    expect(store.state.spawnHistory.snapshots).toHaveLength(2)
    expect(store.state.subagents).toEqual([])

    startTurn(store)
    spawn(store, 'complete-agent')
    store.apply({ type: 'message.complete' })
    expect(store.state.spawnHistory.snapshots).toHaveLength(3)
    // A stale start may create by contract, but the exit in the optimistic
    // complete→session.info(false) gap clears it without a duplicate archive.
    spawn(store, 'late-agent')
    store.apply({ type: 'gateway.exited' })
    expect(store.state.spawnHistory.snapshots).toHaveLength(3)
    expect(store.state.subagents).toEqual([])
  })

  test('history and unacked save intents survive adoption; settlement is explicit', () => {
    const store = createSessionStore()
    store.setSessionId('old-sid')
    startTurn(store)
    spawn(store, 'a1')
    store.apply({ type: 'message.complete' })
    const intent = store.nextSpawnTreeSaveIntent()
    expect(intent).toBeDefined()

    store.adoptFreshSession('new-sid')
    expect(store.state.spawnHistory.snapshots).toHaveLength(1)
    expect(store.nextSpawnTreeSaveIntent()?.snapshotId).toBe(intent?.snapshotId)
    expect(store.settleSpawnTreeSaveIntent('unknown')).toBe(false)
    expect(intent && store.settleSpawnTreeSaveIntent(intent.snapshotId)).toBe(true)
    expect(store.nextSpawnTreeSaveIntent()).toBeUndefined()
  })

  test('disk history ingestion never feeds archived rows back into live state', () => {
    const store = createSessionStore()
    const loaded = store.loadSpawnTreeSnapshot(
      {
        finished_at: 1_700_000_010,
        label: 'disk tree',
        session_id: 'old-sid',
        started_at: 1_700_000_000,
        subagents: [{ goal: 'archived', status: 'completed', subagent_id: 'disk-a1' }]
      },
      '/tmp/tree.json'
    )
    expect(loaded).toMatchObject({ label: 'disk tree', path: '/tmp/tree.json', source: 'disk' })
    expect(store.state.spawnHistory.snapshots).toHaveLength(1)
    expect(store.state.subagents).toEqual([])
  })
})

describe('Agents status and session-owned lifecycle', () => {
  test('dashboard open state carries bounded replay/diff intent and resets on close', () => {
    const store = createSessionStore()
    startTurn(store)
    spawn(store, 'a1', 'first tree')
    store.apply({ type: 'message.complete' })
    const snapshot = store.state.spawnHistory.snapshots[0]
    expect(snapshot).toBeDefined()

    store.openDashboard({
      diffPair: { baseline: snapshot!, candidate: snapshot! },
      initialHistoryIndex: 99
    })
    expect(store.state).toMatchObject({
      dashboard: true,
      dashboardAgent: undefined,
      dashboardHistoryIndex: 1
    })
    expect(store.state.dashboardDiffPair?.baseline.id).toBe(snapshot?.id)

    store.closeDashboard()
    expect(store.state).toMatchObject({
      dashboard: false,
      dashboardAgent: undefined,
      dashboardHistoryIndex: 0
    })
    expect(store.state.dashboardDiffPair).toBeUndefined()

    store.openDashboard('a1')
    expect(store.state).toMatchObject({ dashboardAgent: 'a1', dashboardHistoryIndex: 0 })
  })

  test('usage.active_subagents is authoritative including zero', () => {
    const store = createSessionStore()
    spawn(store, 'local')
    expect(store.activeSubagentCount()).toEqual({ count: 1, source: 'local' })

    store.applyInfo({ usage: { active_subagents: 0 } })
    expect(store.state.info.activeSubagents).toBe(0)
    expect(store.activeSubagentCount()).toEqual({ count: 0, source: 'usage' })

    // Invalid negative usage is rejected by Schema and cannot clobber zero.
    store.applyInfo({ usage: { active_subagents: -1 } })
    expect(store.state.info.activeSubagents).toBe(0)
    store.apply({ type: 'message.complete', payload: { usage: { active_subagents: 3 } } })
    expect(store.activeSubagentCount()).toEqual({ count: 3, source: 'usage' })

    store.clearTranscript()
    expect(store.state.info.activeSubagents).toBeUndefined()
  })

  test('gateway exit drops the dead child process registry before idle chrome renders', () => {
    const store = createSessionStore()
    startTurn(store)
    spawn(store, 'local')
    store.applyInfo({ usage: { active_subagents: 2 } })
    expect(store.applyDelegationPauseResponse({ paused: true })).toBe(true)
    expect(store.activeSubagentCount()).toEqual({ count: 2, source: 'usage' })

    store.apply({ type: 'gateway.exited', payload: { reason: 'SIGKILL' } })
    expect(store.state.info.activeSubagents).toBeUndefined()
    expect(store.state.subagents).toEqual([])
    expect(store.activeSubagentCount()).toEqual({ count: 0, source: 'local' })
    expect(store.state.delegation).toMatchObject({ paused: false, updatedAtMs: null })
  })

  test('nudge decision is once per turn, suppresses while open, and resets on adoption', () => {
    const store = createSessionStore()
    startTurn(store)
    spawn(store, 'a1')
    expect(store.consumeAgentsNudge()).toBe(true)
    spawn(store, 'a2')
    expect(store.consumeAgentsNudge()).toBe(false)
    store.apply({ type: 'message.complete' })
    expect(store.state.agentsNudge.activeTurnId).toBeNull()

    startTurn(store)
    store.openDashboard()
    spawn(store, 'a3')
    expect(store.consumeAgentsNudge()).toBe(false)
    store.closeDashboard()
    spawn(store, 'a4')
    expect(store.consumeAgentsNudge()).toBe(true)

    store.configureAgentsNudge(false)
    store.adoptFreshSession('new-sid')
    expect(store.state.agentsNudge).toMatchObject({ activeTurnId: null, enabled: false, nudgedTurnId: null })
    expect(store.state.agentsNudgePending).toBe(false)
    expect(store.state.subagents).toEqual([])
  })

  test('delegation status/pause responses decode before they enter Solid state', () => {
    const store = createSessionStore()
    expect(
      store.applyDelegationStatusResponse(
        { active: [], max_concurrent_children: 4, max_spawn_depth: 3, paused: false },
        100
      )
    ).toBe(true)
    expect(store.state.delegation).toEqual({
      maxConcurrentChildren: 4,
      maxSpawnDepth: 3,
      paused: false,
      updatedAtMs: 100
    })
    expect(store.applyDelegationPauseResponse({ paused: true }, 200)).toBe(true)
    expect(store.state.delegation).toMatchObject({ paused: true, updatedAtMs: 200 })
    expect(store.applyDelegationPauseResponse({ paused: 'yes' }, 300)).toBe(false)
    expect(store.state.delegation).toMatchObject({ paused: true, updatedAtMs: 200 })
  })
})
