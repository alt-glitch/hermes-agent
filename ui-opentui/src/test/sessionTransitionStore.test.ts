import { describe, expect, test } from 'vitest'

import { eventBelongsToSession } from '../logic/eventScope.ts'
import { createSessionStore, type Message } from '../logic/store.ts'

describe('session-store replacement boundary', () => {
  test('committed-event side effects wait for buffer filtering and reject stale SIDs', () => {
    const store = createSessionStore()
    const committed: string[] = []
    store.registerCommittedEventHandler(event => committed.push(`${event.type}:${event.session_id ?? ''}`))
    store.adoptFreshSession('old-live', {}, 'persisted-old')

    store.beginBuffer()
    store.apply({
      type: 'billing.step_up.verification',
      session_id: 'old-live',
      payload: { verification_url: 'https://old.example/device' }
    })
    store.apply({
      type: 'billing.step_up.verification',
      session_id: 'new-live',
      payload: { verification_url: 'https://new.example/device' }
    })
    expect(committed).toEqual([])

    store.commitSessionSnapshot('new-live', [], {}, event => eventBelongsToSession(event, 'new-live'), 'persisted-new')
    expect(committed).toEqual(['billing.step_up.verification:new-live'])
  })

  test('fresh adoption replaces all session slices and preserves process/global preferences', () => {
    const store = createSessionStore()
    store.apply({
      type: 'gateway.ready',
      payload: { skin: { branding: { agent_name: 'Aurora' }, colors: { ui_primary: '#abcdef' } } }
    })
    store.setCompact(true)
    store.setDetails('expanded')
    store.setTimestamps(true)
    store.setReasoningFull(true)
    store.setBackgroundProcesses([{ command: 'sleep 10', sessionId: 'proc-42', status: 'running', uptimeSeconds: 5 }])
    store.setSessionId('old-live')
    store.pushUser('old transcript')
    store.setComposerDraft('old draft')
    store.enqueuePrompt('old queued prompt')
    store.openPager('Old', 'old pager')
    store.openSessionPicker('all')
    store.openDashboard('agent-1')
    store.openBackgroundPanel()
    store.addBgTask('bg-old')
    store.setModelItems([{ label: 'old-model', value: 'old-model' }])
    store.setCompletions([{ display: '/old', meta: '', text: '/old' }], 2)
    store.applyInfo({
      branch: 'old-branch',
      cwd: '/old',
      model: 'old-model',
      provider: 'old-provider',
      running: true,
      title: 'Old title',
      usage: { compressions: 3, context_percent: 50, context_used: 100, cost_usd: 1.25 }
    })

    const before = Date.now()
    store.adoptFreshSession('new-live', { cwd: '/new', model: 'new-model' })

    expect(store.state.ready).toBe(true)
    expect(store.state.theme.brand.name).toBe('Aurora')
    expect(store.state.compact).toBe(true)
    expect(store.state.details).toBe('expanded')
    expect(store.state.timestamps).toBe(true)
    expect(store.state.reasoningFull).toBe(true)
    expect(store.state.backgroundProcesses).toEqual([
      { command: 'sleep 10', sessionId: 'proc-42', status: 'running', uptimeSeconds: 5 }
    ])

    expect(store.state.sessionId).toBe('new-live')
    expect(store.state.resumeId).toBe('new-live')
    expect(store.state.messages).toEqual([])
    expect(store.state.composerDraft).toBe('')
    expect(store.state.queuedPrompts).toEqual([])
    expect(store.state.pager).toBeUndefined()
    expect(store.state.sessionPicker).toBeUndefined()
    expect(store.state.dashboard).toBe(false)
    expect(store.state.dashboardAgent).toBeUndefined()
    expect(store.state.backgroundPanel).toBe(false)
    expect(store.state.bgTasks).toEqual([])
    expect(store.state.modelItems).toBeUndefined()
    expect(store.state.completions).toBeUndefined()
    expect(store.state.info).toMatchObject({ cwd: '/new', model: 'new-model' })
    expect(store.state.info.startedAt).toBeGreaterThanOrEqual(before)
    for (const stale of [
      'branch',
      'provider',
      'running',
      'title',
      'compressions',
      'contextPercent',
      'contextUsed',
      'costUsd'
    ]) {
      expect(store.state.info).not.toHaveProperty(stale)
    }
  })

  test('detach leaves an honest no-session state after close/create failure', () => {
    const store = createSessionStore()
    store.setSessionId('closed-live')
    store.pushUser('closed transcript')
    store.detachSession()
    expect(store.state.sessionId).toBeUndefined()
    expect(store.state.messages).toEqual([])
    expect(store.state.info.title).toBeUndefined()
  })

  test('failed resume aborts buffering and replays the still-active session events', () => {
    const store = createSessionStore()
    store.pushUser('existing')
    store.beginBuffer()
    store.apply({ type: 'message.start', session_id: 'old-live' })
    store.apply({ type: 'message.delta', session_id: 'old-live', payload: { text: 'still here' } })
    expect(store.state.messages).toHaveLength(1)
    store.abortBuffer()
    expect(store.state.messages).toHaveLength(2)
    expect(store.state.messages.at(-1)?.parts?.[0]).toMatchObject({ text: 'still here', type: 'text' })
  })

  test('resume adoption filters coalesced old-session events before replay', () => {
    const store = createSessionStore()
    store.beginBuffer()
    store.apply({ type: 'message.start', session_id: 'old-live' })
    store.apply({ type: 'message.delta', session_id: 'old-live', payload: { text: 'stale' } })
    store.apply({ type: 'message.start', session_id: 'new-live' })
    store.apply({ type: 'message.delta', session_id: 'new-live', payload: { text: 'fresh' } })
    const snapshot: Message[] = [{ role: 'user', text: 'resumed question' }]

    store.commitSessionSnapshot(
      'new-live',
      snapshot,
      { model: 'resumed-model' },
      event => eventBelongsToSession(event, 'new-live'),
      'persisted-key'
    )

    expect(store.state.sessionId).toBe('new-live')
    expect(store.state.resumeId).toBe('persisted-key')
    expect(store.state.messages).toHaveLength(2)
    expect(store.state.messages[0]?.text).toBe('resumed question')
    expect(store.state.messages[1]?.parts?.[0]).toMatchObject({ text: 'fresh', type: 'text' })
    expect(JSON.stringify(store.state.messages)).not.toContain('stale')
  })

  test('live snapshot commit preserves age and arms the completion latch', () => {
    const store = createSessionStore()
    let drained = 0
    store.registerTurnCompleteHandler(() => (drained += 1))
    store.commitSessionSnapshot('live', [], { running: true }, () => true, 'key', true, 42_000)
    expect(store.state.info.startedAt).toBe(42_000)
    expect(store.isTurnInFlight()).toBe(true)
    store.applyInfo({ running: false })
    expect(drained).toBe(1)
  })

  test('active-list application prefers the supplied SID over stale wire current flags', () => {
    const store = createSessionStore()
    expect(
      store.applyActiveSessionsResponse(
        { sessions: [
          { id: 'old', status: 'idle', title: 'Old', current: true },
          { id: 'new', status: 'working', title: 'New', current: false }
        ] },
        'new'
      )
    ).toBe(true)
    expect(store.state.info.title).toBe('New')
    expect(store.state.liveSessions.map(row => [row.id, row.current])).toEqual([
      ['old', false],
      ['new', true]
    ])
  })

  test('busy lifetime includes message.complete until server-confirmed idle', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start', session_id: 'live' })
    expect(store.isTurnInFlight()).toBe(true)
    store.apply({ type: 'message.complete', session_id: 'live' })
    expect(store.state.info.running).toBe(false)
    expect(store.isTurnInFlight()).toBe(true)
    store.apply({ type: 'session.info', session_id: 'live', payload: { running: false } })
    expect(store.isTurnInFlight()).toBe(false)
  })

  test('same-SID compression replacement preserves input, identity, and process-global state', () => {
    const store = createSessionStore()
    store.adoptFreshSession('live-1', { model: 'old-model' }, 'durable-1')
    store.setComposerDraft('keep draft')
    store.enqueuePrompt('keep queued')
    store.setCompact(true)
    store.setBackgroundProcesses([{ command: 'dev server', sessionId: 'proc-1', status: 'running', uptimeSeconds: 3 }])
    store.pushUser('old transcript')

    store.replaceConversationSnapshot(
      [{ role: 'assistant', text: 'compressed', parts: [{ id: 'r1', type: 'text', text: 'compressed' }] }],
      { cwd: '/work', model: 'new-model', running: false },
      { compressions: 2, context_max: 100, context_percent: 25, context_used: 25, cost_usd: 0.5 }
    )

    expect(store.state.messages).toHaveLength(1)
    expect(store.state.messages[0]?.text).toBe('compressed')
    expect(store.state.sessionId).toBe('live-1')
    expect(store.state.resumeId).toBe('durable-1')
    expect(store.state.composerDraft).toBe('keep draft')
    expect(store.state.queuedPrompts).toEqual(['keep queued'])
    expect(store.state.compact).toBe(true)
    expect(store.state.backgroundProcesses).toHaveLength(1)
    expect(store.state.info).toMatchObject({
      compressions: 2,
      contextMax: 100,
      contextPercent: 25,
      contextUsed: 25,
      costUsd: 0.5,
      cwd: '/work',
      model: 'new-model',
      running: false
    })
  })

})
