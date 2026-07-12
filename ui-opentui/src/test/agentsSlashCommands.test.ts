import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { decodeSpawnTreeLoadResponse } from '../boundary/schema/Delegation.ts'
import { applyDelegationState, createDelegationState, type DelegationState } from '../logic/agentStatus.ts'
import {
  clientCommandNames,
  dispatchSlash,
  type AgentsDashboardOpenRequest,
  type AgentsSlashControl,
  type SlashContext
} from '../logic/slash.ts'
import { emptySpawnHistory, loadSpawnTree, type SpawnHistoryState, type SpawnSnapshot } from '../logic/spawnHistory.ts'

interface RpcCall {
  readonly method: string
  readonly params: Record<string, unknown>
}

interface PagerCall {
  readonly text: string
  readonly title: string
}

interface Harness {
  readonly calls: RpcCall[]
  readonly ctx: SlashContext
  readonly delegation: () => DelegationState
  readonly history: () => SpawnHistoryState
  readonly opens: Array<AgentsDashboardOpenRequest | undefined>
  readonly pagers: PagerCall[]
  readonly system: string[]
}

interface HarnessOptions {
  readonly delegation?: DelegationState
  readonly history?: SpawnHistoryState
  readonly responder?: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

function treePayload(label: string, id: string, finishedAt: number) {
  return {
    finished_at: finishedAt,
    label,
    session_id: 'sid-1',
    started_at: finishedAt - 4,
    subagents: [
      {
        goal: label,
        status: 'completed',
        subagent_id: id,
        tool_count: 2
      }
    ]
  }
}

/** Build newest-first history without fabricating typed snapshots in tests. */
function spawnHistory(labels: readonly string[]): SpawnHistoryState {
  let state = emptySpawnHistory()
  for (let index = labels.length - 1; index >= 0; index -= 1) {
    const label = labels[index]
    if (label === undefined) continue
    const path = `/spawn/${String(index + 1)}.json`
    const loaded = loadSpawnTree(state, treePayload(label, `agent-${String(index + 1)}`, 1_760_000_000 + index), {
      path
    })
    state = loaded.state
  }
  return state
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const calls: RpcCall[] = []
  const opens: Array<AgentsDashboardOpenRequest | undefined> = []
  const pagers: PagerCall[] = []
  const system: string[] = []
  let history = options.history ?? emptySpawnHistory()
  let delegation = options.delegation ?? createDelegationState()
  const responder = options.responder ?? (() => Promise.resolve({}))

  const agentsControl: AgentsSlashControl = {
    applyPauseResponse: response => {
      if (typeof response !== 'object' || response === null) return false
      const paused = Reflect.get(response, 'paused')
      if (typeof paused !== 'boolean') return false
      delegation = applyDelegationState(delegation, { paused }, 42)
      return true
    },
    delegation: () => delegation,
    history: () => history,
    loadSnapshot: (response, path): SpawnSnapshot | null => {
      const decoded = decodeSpawnTreeLoadResponse(response)
      if (Option.isNone(decoded)) return null
      const loaded = loadSpawnTree(history, decoded.value, { path })
      history = loaded.state
      return loaded.snapshot
    }
  }

  const ctx: SlashContext = {
    addBgTask: () => {},
    agentsControl,
    beginHistoryMutation: () => true,
    beginToolsConfigure: () => {},
    busyInputMode: () => 'queue',
    clearQueued: () => 0,
    commandCatalog: () => undefined,
    compact: () => false,
    confirm: () => {},
    copyResponse: () => false,
    copySelection: () => undefined,
    dashboardMode: () => false,
    details: () => 'collapsed',
    detailSections: () => ({}),
    endHistoryMutation: () => {},
    endToolsConfigure: () => {},
    enqueueQueued: () => true,
    guardBusySessionSwitch: () => false,
    hasConversation: () => false,
    helpHeader: () => 'Commands',
    historyItems: () => [],
    isBusy: () => false,
    isSessionTransitioning: () => false,
    lastUserMessage: () => undefined,
    logTail: () => [],
    modelItems: () => undefined,
    newSession: () => {},
    newLiveSession: () => {},
    openBackgroundPanel: () => {},
    openBilling: () => {},
    openDashboard: request => opens.push(request),
    openPager: (title, text) => pagers.push({ text, title }),
    openPicker: () => {},
    openSessionPicker: () => {},
    prefillComposer: () => {},
    pushSystem: text => system.push(text),
    queueCount: () => 0,
    quit: () => {},
    reasoningFull: () => false,
    redraw: () => {},
    refreshCommandCatalog: () => {},
    renderableCount: () => undefined,
    request: (method, params) => {
      calls.push({ method, params })
      return responder(method, params)
    },
    resetAfterToolsConfigure: () => {},
    replaceConversationSnapshot: () => {},
    setCompressedSessionKey: () => {},
    resumeSession: () => {},
    sessionId: () => 'sid-1',
    sessionOwnerId: () => 'sid-1',
    setBrowserState: () => {},
    setVoiceMode: () => {},
    setBusyInputMode: () => {},
    setCompact: () => {},
    setDetails: () => {},
    setDetailSection: () => {},
    setModelItems: () => {},
    setCurrentModel: () => {},
    setReasoningFull: () => {},
    setSessionTitle: () => {},
    setTimestamps: () => {},
    steer: () => Promise.resolve('fallback'),
    submit: () => true,
    submitSkill: () => true,
    timestamps: () => false,
    trimLastExchange: () => 0
  }

  return {
    calls,
    ctx,
    delegation: () => delegation,
    history: () => history,
    opens,
    pagers,
    system
  }
}

describe('/agents control plane (Ink parity)', () => {
  test('bare /agents, /tasks, and unknown subcommands open the native dashboard', async () => {
    const probe = makeHarness()
    await dispatchSlash('/agents', probe.ctx)
    await dispatchSlash('/tasks', probe.ctx)
    await dispatchSlash('/agents future-subcommand', probe.ctx)
    expect(probe.opens).toEqual([undefined, undefined, undefined])
    expect(probe.calls).toEqual([])
  })

  test('pause/resume/unpause call delegation.pause, update state, and report exact status', async () => {
    const probe = makeHarness({
      responder: (_method, params) => Promise.resolve({ paused: params['paused'] })
    })

    await dispatchSlash('/agents pause', probe.ctx)
    await dispatchSlash('/agents resume', probe.ctx)
    await dispatchSlash('/tasks pause', probe.ctx)
    await dispatchSlash('/agents unpause', probe.ctx)

    expect(probe.calls).toEqual([
      { method: 'delegation.pause', params: { paused: true } },
      { method: 'delegation.pause', params: { paused: false } },
      { method: 'delegation.pause', params: { paused: true } },
      { method: 'delegation.pause', params: { paused: false } }
    ])
    expect(probe.system).toEqual([
      'delegation · paused',
      'delegation · resumed',
      'delegation · paused',
      'delegation · resumed'
    ])
    expect(probe.delegation().paused).toBe(false)
  })

  test('status reads the hydrated store state without another RPC', async () => {
    const delegation = applyDelegationState(
      createDelegationState(),
      { max_concurrent_children: 5, max_spawn_depth: 3, paused: true },
      12
    )
    const probe = makeHarness({ delegation })
    await dispatchSlash('/agents status', probe.ctx)
    expect(probe.system).toEqual(['delegation · paused · caps d3/5'])
    expect(probe.calls).toEqual([])
  })

  test('invalid and rejected pause responses surface useful errors and do not mutate state', async () => {
    const invalid = makeHarness({ responder: () => Promise.resolve({ paused: 'yes' }) })
    await dispatchSlash('/agents pause', invalid.ctx)
    expect(invalid.system).toEqual(['/agents: invalid delegation.pause response'])
    expect(invalid.delegation().paused).toBe(false)

    const rejected = makeHarness({
      responder: () => Promise.reject(new Error('pause unavailable'))
    })
    await dispatchSlash('/agents pause', rejected.ctx)
    expect(rejected.system).toEqual(['/agents: pause unavailable'])
  })

  test('a superseded pause response still reconciles global state without leaking feedback', async () => {
    let settle: ((value: unknown) => void) | undefined
    const response = new Promise<unknown>(resolve => {
      settle = resolve
    })
    const probe = makeHarness({ responder: () => response })
    const pausing = dispatchSlash('/agents pause', probe.ctx)
    await dispatchSlash('/agents', probe.ctx)
    settle?.({ paused: true })
    await pausing

    expect(probe.delegation().paused).toBe(true)
    expect(probe.system).toEqual([])
    expect(probe.opens).toEqual([undefined])
  })
})

describe('/replay in-memory and disk control plane (Ink parity)', () => {
  test('bare, last, and N open the same-session history without gateway calls', async () => {
    const probe = makeHarness({ history: spawnHistory(['newest', 'older']) })
    await dispatchSlash('/replay', probe.ctx)
    await dispatchSlash('/replay last', probe.ctx)
    await dispatchSlash('/replay 2', probe.ctx)
    expect(probe.opens).toEqual([{ initialHistoryIndex: 1 }, { initialHistoryIndex: 1 }, { initialHistoryIndex: 2 }])
    expect(probe.calls).toEqual([])
  })

  test('empty history and invalid indexes point users at the explicit disk list', async () => {
    const empty = makeHarness()
    await dispatchSlash('/replay', empty.ctx)
    expect(empty.system).toEqual(['no completed spawn trees this session · try /replay list'])

    const invalid = makeHarness({ history: spawnHistory(['only']) })
    await dispatchSlash('/replay 0', invalid.ctx)
    await dispatchSlash('/replay nope', invalid.ctx)
    await dispatchSlash('/replay 2', invalid.ctx)
    expect(invalid.system).toEqual([
      'replay: index out of range 1..1 · use /replay list for disk',
      'replay: index out of range 1..1 · use /replay list for disk',
      'replay: index out of range 1..1 · use /replay list for disk'
    ])
  })

  test('list/ls decode disk entries and page their labels and paths', async () => {
    const probe = makeHarness({
      responder: method =>
        Promise.resolve(
          method === 'spawn_tree.list'
            ? {
                entries: [
                  {
                    count: 2,
                    finished_at: 1_760_000_000,
                    label: 'fanout A',
                    path: '/spawn/fanout-a.json',
                    session_id: 'sid-1'
                  }
                ]
              }
            : {}
        )
    })
    await dispatchSlash('/replay list', probe.ctx)
    expect(probe.calls).toEqual([{ method: 'spawn_tree.list', params: { limit: 30, session_id: 'sid-1' } }])
    expect(probe.pagers[0]?.title).toBe('Archived spawn trees')
    expect(probe.pagers[0]?.text).toContain('2×')
    expect(probe.pagers[0]?.text).toContain('fanout A')
    expect(probe.pagers[0]?.text).toContain('/spawn/fanout-a.json')
  })

  test('empty and malformed disk lists remain non-destructive', async () => {
    const empty = makeHarness({ responder: () => Promise.resolve({ entries: [] }) })
    await dispatchSlash('/replay ls', empty.ctx)
    expect(empty.system).toEqual(['no archived spawn trees on disk for this session'])
    expect(empty.opens).toEqual([])

    const malformed = makeHarness({ responder: () => Promise.resolve({ entries: 'bad' }) })
    await dispatchSlash('/replay list', malformed.ctx)
    expect(malformed.system).toEqual(['/replay: invalid spawn_tree.list response'])
    expect(malformed.opens).toEqual([])
  })

  test('load inserts a decoded disk snapshot into history then opens index 1', async () => {
    const payload = treePayload('loaded fanout', 'loaded-agent', 1_760_000_010)
    const probe = makeHarness({ responder: () => Promise.resolve(payload) })
    await dispatchSlash('/replay load /spawn/loaded.json', probe.ctx)
    expect(probe.calls).toEqual([{ method: 'spawn_tree.load', params: { path: '/spawn/loaded.json' } }])
    expect(probe.history().snapshots[0]?.path).toBe('/spawn/loaded.json')
    expect(probe.history().snapshots[0]?.label).toBe('loaded fanout')
    expect(probe.opens).toEqual([{ initialHistoryIndex: 1 }])
  })

  test('missing, empty, and rejected loads never open the dashboard', async () => {
    const missing = makeHarness()
    await dispatchSlash('/replay load', missing.ctx)
    expect(missing.system).toEqual(['usage: /replay load <path>'])
    expect(missing.calls).toEqual([])

    const empty = makeHarness({ responder: () => Promise.resolve({ subagents: [] }) })
    await dispatchSlash('/replay load /spawn/empty.json', empty.ctx)
    expect(empty.system).toEqual(['snapshot empty or unreadable'])
    expect(empty.opens).toEqual([])

    const rejected = makeHarness({ responder: () => Promise.reject(new Error('disk unavailable')) })
    await dispatchSlash('/replay load /spawn/missing.json', rejected.ctx)
    expect(rejected.system).toEqual(['/replay: disk unavailable'])
    expect(rejected.opens).toEqual([])
  })

  test('a superseded disk load cannot populate history or reopen the dashboard', async () => {
    let settle: ((value: unknown) => void) | undefined
    const response = new Promise<unknown>(resolve => {
      settle = resolve
    })
    const probe = makeHarness({ responder: () => response })
    const loading = dispatchSlash('/replay load /spawn/slow.json', probe.ctx)
    await dispatchSlash('/agents', probe.ctx)
    settle?.(treePayload('stale fanout', 'stale-agent', 1_760_000_020))
    await loading

    expect(probe.history().snapshots).toEqual([])
    expect(probe.opens).toEqual([undefined])
    expect(probe.system).toEqual([])
  })
})

describe('/replay-diff and /stop', () => {
  test('replay-diff resolves two history indexes and opens the dashboard diff', async () => {
    const history = spawnHistory(['newest', 'older'])
    const probe = makeHarness({ history })
    await dispatchSlash('/replay-diff 1 2', probe.ctx)
    const request = probe.opens[0]
    expect(request?.initialHistoryIndex).toBe(0)
    expect(request?.diffPair?.baseline).toBe(history.snapshots[0])
    expect(request?.diffPair?.candidate).toBe(history.snapshots[1])
    expect(probe.calls).toEqual([])
  })

  test('replay-diff validates arity and indexes', async () => {
    const usage = makeHarness({ history: spawnHistory(['only']) })
    await dispatchSlash('/replay-diff 1', usage.ctx)
    expect(usage.system).toEqual(['usage: /replay-diff <a> <b>  (e.g. /replay-diff 1 2 for last two)'])

    const invalid = makeHarness({ history: spawnHistory(['only']) })
    await dispatchSlash('/replay-diff 1 2', invalid.ctx)
    expect(invalid.system).toEqual(['replay-diff: could not resolve indices · history has 1 entries'])
    expect(invalid.opens).toEqual([])
  })

  test('/stop calls the live process registry and pluralizes exact feedback', async () => {
    const one = makeHarness({ responder: () => Promise.resolve({ killed: 1 }) })
    await dispatchSlash('/stop', one.ctx)
    expect(one.calls).toEqual([{ method: 'process.stop', params: {} }])
    expect(one.system).toEqual(['stopped 1 background process'])

    const many = makeHarness({ responder: () => Promise.resolve({ killed: 3 }) })
    await dispatchSlash('/stop', many.ctx)
    expect(many.system).toEqual(['stopped 3 background processes'])

    const malformed = makeHarness({ responder: () => Promise.resolve({ killed: 'many' }) })
    await dispatchSlash('/stop', malformed.ctx)
    expect(malformed.system).toEqual(['/stop: invalid process.stop response'])
  })

  test('/stop failures surface under the command name', async () => {
    const probe = makeHarness({ responder: () => Promise.reject(new Error('registry unavailable')) })
    await dispatchSlash('/stop', probe.ctx)
    expect(probe.system).toEqual(['/stop: registry unavailable'])
  })

  test('/stop suppresses stale completion text after a newer slash interaction', async () => {
    let settle: ((value: unknown) => void) | undefined
    const response = new Promise<unknown>(resolve => {
      settle = resolve
    })
    const probe = makeHarness({ responder: () => response })
    const stopping = dispatchSlash('/stop', probe.ctx)
    await dispatchSlash('/agents', probe.ctx)
    settle?.({ killed: 2 })
    await stopping

    expect(probe.system).toEqual([])
    expect(probe.opens).toEqual([undefined])
  })

  test('all direct control-plane commands are registered client-side', () => {
    expect(clientCommandNames()).toEqual(expect.arrayContaining(['agents', 'tasks', 'replay', 'replay-diff', 'stop']))
  })
})
