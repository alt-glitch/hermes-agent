/**
 * Utility slash commands (Epic 3 port: /compact /details /replay /heapdump /mem).
 * Pure logic + dispatch tests against a fake SlashContext: catalog registration,
 * arg parsing (incl. garbage → usage lines), the store display-flag effects,
 * replay RPC call shapes against a fake gateway, and the mem/heapdump system
 * lines with node:v8 / process.memoryUsage mocked.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  collapseHiddenParts,
  collapseHiddenPartsBy,
  compactFromConfig,
  detailsFromConfig,
  hiddenRunLabel,
  nextDetailsMode,
  sectionMode,
  parseDetailsMode,
  type DetailsMode,
  type DetailsSections
} from '../logic/details.ts'
import { formatBytes, heapSnapshotPath, memReport } from '../logic/diagnostics.ts'
import type { BusyInputMode } from '../logic/busyQueue.ts'
import { formatSpawnTree, formatSpawnTreeList, readSpawnTreeEntries } from '../logic/replay.ts'
import { clientCommandNames, dispatchSlash, type SlashContext } from '../logic/slash.ts'
import type { Message, Part } from '../logic/store.ts'

// The utility commands under test are DIAGNOSTIC commands — gated behind
// HERMES_TUI_DIAGNOSTICS (logic/env.ts). This suite tests the commands
// themselves, so enable the gate for the whole file (gating behavior has its
// own tests in slash.test.ts).
const PREV_DIAG = process.env.HERMES_TUI_DIAGNOSTICS
beforeEach(() => {
  process.env.HERMES_TUI_DIAGNOSTICS = '1'
})
afterEach(() => {
  if (PREV_DIAG === undefined) delete process.env.HERMES_TUI_DIAGNOSTICS
  else process.env.HERMES_TUI_DIAGNOSTICS = PREV_DIAG
})

// /heapdump must not write a REAL multi-MB snapshot per test run — stub the V8
// seam; the path/mkdir plumbing still runs for real (under a temp HERMES_HOME).
vi.mock('node:v8', () => ({ writeHeapSnapshot: vi.fn((path?: string) => path ?? 'unnamed.heapsnapshot') }))

interface Probe {
  ctx: SlashContext
  calls: Array<{ method: string; params: Record<string, unknown> }>
  system: string[]
  paged: Array<{ title: string; text: string }>
  compactFlag: { value: boolean }
  detailsFlag: { value: DetailsMode }
  detailSections: { value: DetailsSections }
  timestampsFlag: { value: boolean }
  reasoningFullFlag: { value: boolean }
  renderables: { value: number | undefined }
  sessionId: { value: string | undefined }
  compressionMutations: Array<{
    messages: Message[] | undefined
    info: object | undefined
    usage: object | undefined
  }>
  trimCalls: { value: number }
}

function makeCtx(request: (method: string, params: Record<string, unknown>) => Promise<unknown>): Probe {
  const calls: Probe['calls'] = []
  const system: string[] = []
  const paged: Probe['paged'] = []
  const compactFlag = { value: false }
  const detailsFlag: Probe['detailsFlag'] = { value: 'collapsed' }
  const detailSections: Probe['detailSections'] = { value: {} }
  const timestampsFlag = { value: false }
  const reasoningFullFlag = { value: false }
  const busyMode: { value: BusyInputMode } = { value: 'queue' }
  const queue: string[] = []
  const renderables: Probe['renderables'] = { value: undefined }
  const sessionId: Probe['sessionId'] = { value: 'sid-1' }
  const compressionMutations: Probe['compressionMutations'] = []
  const trimCalls = { value: 0 }
  const ctx: SlashContext = {
    batteryEnabled: () => false,
    guardBusySessionSwitch: () => false,
    newSession: () => {},
    newLiveSession: () => {},
    beginToolsConfigure: () => {},
    endToolsConfigure: () => {},
    resetAfterToolsConfigure: () => {},
    replaceConversationSnapshot: (messages, info, usage) => compressionMutations.push({ messages, info, usage }),
    setCompressedSessionKey: () => {},
    hasConversation: () => true,
    setSessionTitle: () => {},
    refreshCommandCatalog: () => {},
    commandCatalog: () => undefined,
    historyItems: () => [],
    helpHeader: () => 'Commands',
    dashboardMode: () => false,
    compact: () => compactFlag.value,
    setCompact: on => (compactFlag.value = on),
    setBatteryEnabled: () => {},
    details: () => detailsFlag.value,
    setDetails: (mode, commandOverride) => {
      detailsFlag.value = mode
      if (commandOverride) detailSections.value = { activity: mode, subagents: mode, thinking: mode, tools: mode }
    },
    detailSections: () => detailSections.value,
    setDetailSection: (section, mode) => {
      if (mode === null) delete detailSections.value[section]
      else detailSections.value[section] = mode
    },
    timestamps: () => timestampsFlag.value,
    setTimestamps: on => (timestampsFlag.value = on),
    reasoningFull: () => reasoningFullFlag.value,
    setReasoningFull: on => (reasoningFullFlag.value = on),
    isBusy: () => false,
    isSessionTransitioning: () => false,
    beginHistoryMutation: () => true,
    endHistoryMutation: () => {},
    busyInputMode: () => busyMode.value,
    setBrowserState: () => {},
    setVoiceMode: () => {},
    setBusyInputMode: mode => (busyMode.value = mode),
    queueCount: () => queue.length,
    enqueueQueued: (text, front = false) => {
      if (front) queue.unshift(text)
      else queue.push(text)
      return true
    },
    clearQueued: () => queue.splice(0).length,
    steer: async () => 'queued',
    lastUserMessage: () => undefined,
    trimLastExchange: () => {
      trimCalls.value += 1
      return 1
    },
    prefillComposer: () => {},
    renderableCount: () => renderables.value,
    confirm: () => {},
    copyResponse: () => false,
    copySelection: () => undefined,
    logTail: () => [],
    modelItems: () => undefined,
    setModelItems: () => {},
    setCurrentModel: () => {},
    openDashboard: () => {},
    openBackgroundPanel: () => {},
    openBilling: () => {},
    openSubscription: () => {},
    addBgTask: () => {},
    openPager: (title, text) => paged.push({ text, title }),
    openPicker: () => {},
    openSessionPicker: () => {},
    resumeSession: () => {},
    pushSystem: text => system.push(text),
    quit: () => {},
    redraw: () => {},
    request: (method, params) => {
      calls.push({ method, params })
      return request(method, params)
    },
    sessionId: () => sessionId.value,
    sessionOwnerId: () => 'sid-1',
    submit: () => {},
    submitSkill: () => {}
  }
  return {
    calls,
    compressionMutations,
    trimCalls,
    compactFlag,
    ctx,
    detailsFlag,
    detailSections,
    paged,
    renderables,
    reasoningFullFlag,
    sessionId,
    system,
    timestampsFlag
  }
}

/** Let the fire-and-forget config.set promise settle (it's detached). */
const tick = () => new Promise(r => setTimeout(r, 0))

describe('client command catalog (registration)', () => {
  test('all five utility commands (and the /detail alias) are registered', () => {
    const names = clientCommandNames()
    for (const name of ['density', 'details', 'detail', 'replay', 'heapdump', 'mem', 'verbose']) {
      expect(names).toContain(name)
    }
  })
})

describe('/density', () => {
  test('bare /density toggles on, persists via config.set, reports', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/density', p.ctx)
    expect(p.compactFlag.value).toBe(true)
    expect(p.system).toEqual(['density on'])
    expect(p.calls).toEqual([{ method: 'config.set', params: { key: 'density', value: 'on' } }])
  })

  test('/density on|off|toggle set explicitly', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/density on', p.ctx)
    expect(p.compactFlag.value).toBe(true)
    await dispatchSlash('/density off', p.ctx)
    expect(p.compactFlag.value).toBe(false)
    expect(p.calls.at(-1)).toEqual({ method: 'config.set', params: { key: 'density', value: 'off' } })
    await dispatchSlash('/density toggle', p.ctx)
    expect(p.compactFlag.value).toBe(true)
    expect(p.system).toEqual(['density on', 'density off', 'density on'])
  })

  test('/density garbage → usage line, no flag change, no RPC', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/density sideways', p.ctx)
    expect(p.system).toEqual(['usage: /density [on|off|toggle]'])
    expect(p.compactFlag.value).toBe(false)
    expect(p.calls).toHaveLength(0)
  })

  test('a failing config.set never breaks the local toggle', async () => {
    const p = makeCtx(async () => {
      throw new Error('gateway down')
    })
    await dispatchSlash('/density on', p.ctx)
    await tick()
    expect(p.compactFlag.value).toBe(true)
    expect(p.system).toEqual(['density on'])
  })
})

describe('/verbose', () => {
  test('cycles by default and forwards explicit modes to the live session', async () => {
    const p = makeCtx(async (_method, params) => ({ value: params.value === 'cycle' ? 'new' : params.value }))
    await dispatchSlash('/verbose', p.ctx)
    await dispatchSlash('/verbose all', p.ctx)
    expect(p.calls).toEqual([
      { method: 'config.set', params: { key: 'verbose', session_id: 'sid-1', value: 'cycle' } },
      { method: 'config.set', params: { key: 'verbose', session_id: 'sid-1', value: 'all' } }
    ])
    expect(p.system).toEqual(['verbose: new', 'verbose: all'])
  })
})

describe('/fast, /yolo, /reload-mcp', () => {
  test('fast validates, reads status, and sets explicit modes', async () => {
    const p = makeCtx(async (method, params) => ({
      value: method === 'config.get' ? 'normal' : params.value === 'on' ? 'fast' : 'normal'
    }))
    await dispatchSlash('/fast', p.ctx)
    await dispatchSlash('/fast on', p.ctx)
    await dispatchSlash('/fast turbo', p.ctx)
    expect(p.calls).toEqual([
      { method: 'config.get', params: { key: 'fast', session_id: 'sid-1' } },
      { method: 'config.set', params: { key: 'fast', session_id: 'sid-1', value: 'on' } }
    ])
    expect(p.system).toEqual([
      'fast mode: normal',
      'fast mode: fast',
      'usage: /fast [normal|fast|status|on|off|toggle]'
    ])
  })

  test('fast refuses to mutate global config before a session exists', async () => {
    const p = makeCtx(async () => ({ value: 'fast' }))
    p.sessionId.value = undefined
    await dispatchSlash('/fast fast', p.ctx)
    expect(p.calls).toHaveLength(0)
    expect(p.system).toEqual(['fast mode: no active session'])
  })

  test('yolo toggles only the live session', async () => {
    const p = makeCtx(async () => ({ value: '1' }))
    await dispatchSlash('/yolo', p.ctx)
    expect(p.calls).toEqual([{ method: 'config.set', params: { key: 'yolo', session_id: 'sid-1' } }])
    expect(p.system).toEqual(['yolo on'])
  })

  test('reload-mcp preserves the cache-warning gate and explicit approvals', async () => {
    const p = makeCtx(async (_method, params) =>
      params.confirm ? { status: 'reloaded' } : { status: 'confirm_required', message: 'cache warning' }
    )
    await dispatchSlash('/reload-mcp', p.ctx)
    await dispatchSlash('/reload-mcp now', p.ctx)
    expect(p.calls).toEqual([
      { method: 'reload.mcp', params: { session_id: 'sid-1' } },
      { method: 'reload.mcp', params: { confirm: true, session_id: 'sid-1' } }
    ])
    expect(p.system).toEqual(['cache warning', 'MCP servers reloaded · live agent tools refreshed'])
  })
})

describe('account, personality, and rollback commands', () => {
  test('usage renders decoded account data locally and always shows the account CTA', async () => {
    const p = makeCtx(async () => ({
      calls: 1,
      input: 10,
      output: 4,
      total: 14,
      model: 'test-model',
      context_used: 20,
      context_max: 100,
      context_percent: 20
    }))
    await dispatchSlash('/usage', p.ctx)
    expect(p.paged.at(-1)).toMatchObject({ title: 'Usage' })
    expect(p.paged.at(-1)?.text).toContain('Total tokens: 14')
    expect(p.system).toContain('Run /subscription to change plan · /topup to add to your balance')
  })

  test('credits is no longer a native alias and follows the gateway dispatch ladder', async () => {
    const p = makeCtx(async method => (method === 'slash.exec' ? { output: 'unknown command: credits' } : {}))
    await dispatchSlash('/credits', p.ctx)
    expect(p.calls[0]).toEqual({ method: 'slash.exec', params: { command: 'credits', session_id: 'sid-1' } })
  })

  test('usage renders dollar plan and top-up bars without credits wording', async () => {
    const p = makeCtx(async () => ({
      calls: 0,
      input: 0,
      output: 0,
      total: 0,
      usage: {
        available: true,
        status: 'healthy',
        plan_name: 'Plus',
        renews_display: 'Aug 1',
        total_spendable_display: '$26.00',
        has_topup: true,
        plan_bar: {
          kind: 'plan',
          remaining_display: '$14.00',
          total_display: '$20.00',
          spent_display: '$6.00',
          pct_used: 30,
          fill_fraction: 0.7
        },
        topup_bar: {
          kind: 'topup',
          remaining_display: '$12.00',
          total_display: '$12.00',
          spent_display: '$0.00',
          pct_used: null,
          fill_fraction: 1
        }
      }
    }))
    await dispatchSlash('/usage', p.ctx)
    const body = p.paged.at(-1)?.text ?? ''
    expect(body).toContain('$14.00 left of $20.00')
    expect(body).toContain('top-up')
    expect(body.toLowerCase()).not.toContain('credits')
  })

  test('personality resets visible history only when the gateway says so', async () => {
    const p = makeCtx(async () => ({ value: 'friendly', history_reset: true, info: { model: 'm' } }))
    await dispatchSlash('/personality friendly', p.ctx)
    expect(p.calls).toEqual([
      { method: 'config.set', params: { key: 'personality', session_id: 'sid-1', value: 'friendly' } }
    ])
    expect(p.compressionMutations).toEqual([{ messages: [], info: { model: 'm' }, usage: undefined }])
    expect(p.system).toEqual(['personality: friendly · transcript cleared'])
  })

  test('rollback lists, diffs, restores, and reconciles one visible exchange', async () => {
    const p = makeCtx(async method => {
      if (method === 'rollback.list')
        return { enabled: true, checkpoints: [{ hash: 'abcdef123456', timestamp: 'now', message: 'turn' }] }
      if (method === 'rollback.diff') return { stat: '1 file', diff: '+line' }
      return { success: true, reason: 'ok', history_removed: 2 }
    })
    await dispatchSlash('/rollback list', p.ctx)
    await dispatchSlash('/rollback diff abcdef', p.ctx)
    await dispatchSlash('/rollback abcdef', p.ctx)
    expect(p.paged.map(row => row.title)).toEqual(['Rollback checkpoints', 'Rollback diff'])
    expect(p.system).toContain('rollback restored workspace: ok')
    expect(p.trimCalls.value).toBe(1)
  })
})

describe('/details', () => {
  test('sets each explicit mode + persists via config.set details_mode', async () => {
    const p = makeCtx(async () => ({}))
    for (const mode of ['expanded', 'hidden', 'collapsed'] as const) {
      await dispatchSlash(`/details ${mode}`, p.ctx)
      expect(p.detailsFlag.value).toBe(mode)
      expect(p.calls.at(-1)).toEqual({ method: 'config.set', params: { key: 'details_mode', value: mode } })
    }
    expect(p.system).toEqual(['details: expanded', 'details: hidden', 'details: collapsed'])
  })

  test('/details cycle advances hidden → collapsed → expanded → hidden', async () => {
    const p = makeCtx(async () => ({}))
    expect(p.detailsFlag.value).toBe('collapsed')
    await dispatchSlash('/details cycle', p.ctx)
    expect(p.detailsFlag.value).toBe('expanded')
    await dispatchSlash('/details cycle', p.ctx)
    expect(p.detailsFlag.value).toBe('hidden')
    await dispatchSlash('/details cycle', p.ctx)
    expect(p.detailsFlag.value).toBe('collapsed')
  })

  test('/details garbage → usage line, nothing set', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/details loud', p.ctx)
    expect(p.system).toEqual(['usage: /details [hidden|collapsed|expanded|cycle]'])
    expect(p.detailsFlag.value).toBe('collapsed')
    expect(p.calls).toHaveLength(0)
  })

  test('/details supports per-section override, reset, and authoritative bare summary', async () => {
    const p = makeCtx(async method => (method === 'config.get' ? { value: 'collapsed' } : {}))
    await dispatchSlash('/details tools hidden', p.ctx)
    expect(p.detailSections.value).toEqual({ tools: 'hidden' })
    expect(p.calls.at(-1)).toEqual({
      method: 'config.set',
      params: { key: 'details_mode.tools', value: 'hidden' }
    })
    await dispatchSlash('/details', p.ctx)
    expect(p.system.at(-1)).toBe('details: collapsed  (tools=hidden)')
    await dispatchSlash('/details tools reset', p.ctx)
    expect(p.detailSections.value).toEqual({})
    expect(p.calls.at(-1)).toEqual({
      method: 'config.set',
      params: { key: 'details_mode.tools', value: '' }
    })
  })

  test('/details section rejects invalid mode with section-specific usage', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/details thinking loud', p.ctx)
    expect(p.system).toEqual([
      'usage: /details <thinking|tools|subagents|activity|delegation> <hidden|collapsed|expanded|reset>'
    ])
    expect(p.calls).toHaveLength(0)
  })

  test('bare /details reads config.get and syncs the local flag', async () => {
    const p = makeCtx(async method => (method === 'config.get' ? { value: 'expanded' } : {}))
    await dispatchSlash('/details', p.ctx)
    expect(p.calls[0]).toEqual({ method: 'config.get', params: { key: 'details_mode' } })
    expect(p.detailsFlag.value).toBe('expanded')
    expect(p.system).toEqual(['details: expanded'])
  })

  test('bare /details with config.get failing falls back to the live flag', async () => {
    const p = makeCtx(async () => {
      throw new Error('no config.get')
    })
    p.detailsFlag.value = 'hidden'
    await dispatchSlash('/details', p.ctx)
    expect(p.system).toEqual(['details: hidden'])
  })

  test('/detail (Ink alias) dispatches the same handler', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/detail expanded', p.ctx)
    expect(p.detailsFlag.value).toBe('expanded')
  })
})

describe('/reasoning', () => {
  test('/reasoning full → flag on + persists config.set reasoning=full', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/reasoning full', p.ctx)
    expect(p.reasoningFullFlag.value).toBe(true)
    expect(p.calls.at(-1)).toEqual({ method: 'config.set', params: { key: 'reasoning', value: 'full' } })
    expect(p.system).toEqual(['reasoning: full'])
  })

  test('/reasoning all is an alias for full', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/reasoning all', p.ctx)
    expect(p.reasoningFullFlag.value).toBe(true)
    expect(p.system).toEqual(['reasoning: full'])
  })

  test('/reasoning clamp → flag off + persists config.set reasoning=clamp', async () => {
    const p = makeCtx(async () => ({}))
    p.reasoningFullFlag.value = true
    await dispatchSlash('/reasoning clamp', p.ctx)
    expect(p.reasoningFullFlag.value).toBe(false)
    expect(p.calls.at(-1)).toEqual({ method: 'config.set', params: { key: 'reasoning', value: 'clamp' } })
    expect(p.system).toEqual(['reasoning: clamp'])
  })

  test('/reasoning collapse and short are aliases for clamp', async () => {
    for (const alias of ['collapse', 'short'] as const) {
      const p = makeCtx(async () => ({}))
      p.reasoningFullFlag.value = true
      await dispatchSlash(`/reasoning ${alias}`, p.ctx)
      expect(p.reasoningFullFlag.value).toBe(false)
      expect(p.system).toEqual(['reasoning: clamp'])
    }
  })

  test('bare /reasoning reads this session and reports effort, visibility, and native section mode', async () => {
    const p = makeCtx(async method =>
      method === 'config.get' ? { value: 'medium', display: 'show', reasoning_full: true } : {}
    )
    await dispatchSlash('/reasoning', p.ctx)
    expect(p.calls[0]).toEqual({ method: 'config.get', params: { key: 'reasoning', session_id: 'sid-1' } })
    expect(p.reasoningFullFlag.value).toBe(true)
    expect(p.system).toEqual(['reasoning: medium · display show · sections full'])
  })

  test('bare /reasoning with config.get failing falls back to the live flag', async () => {
    const p = makeCtx(async () => {
      throw new Error('no config.get')
    })
    p.reasoningFullFlag.value = true
    await dispatchSlash('/reasoning', p.ctx)
    expect(p.system).toEqual(['reasoning: full'])
  })

  test('effort updates the live session through config.set', async () => {
    const p = makeCtx(async method => (method === 'config.set' ? { key: 'reasoning', value: 'high' } : {}))
    await dispatchSlash('/reasoning high', p.ctx)
    expect(p.reasoningFullFlag.value).toBe(false)
    expect(p.calls).toEqual([
      { method: 'config.set', params: { key: 'reasoning', value: 'high', session_id: 'sid-1' } }
    ])
    expect(p.system).toEqual(['reasoning: high'])
  })

  test('reasoning accepts explicit session/global scope without treating flags as the effort', async () => {
    const session = makeCtx(async () => ({ value: 'medium' }))
    await dispatchSlash('/reasoning --session medium', session.ctx)
    expect(session.calls).toEqual([
      {
        method: 'config.set',
        params: { key: 'reasoning', scope: 'session', session_id: 'sid-1', value: 'medium' }
      }
    ])

    const global = makeCtx(async () => ({ value: 'low' }))
    await dispatchSlash('/reasoning --session low --global', global.ctx)
    expect(global.calls).toEqual([
      {
        method: 'config.set',
        params: { key: 'reasoning', scope: 'global', session_id: 'sid-1', value: 'low' }
      }
    ])
  })

  test('effort requires an active session', async () => {
    const p = makeCtx(async () => ({ value: 'medium' }))
    p.sessionId.value = undefined

    await dispatchSlash('/reasoning medium', p.ctx)

    expect(p.calls).toEqual([])
    expect(p.system).toEqual(['reasoning: no active session'])
  })

  test('a delayed effort reply cannot land in a successor session', async () => {
    let resolveRequest: (value: unknown) => void = () => {}
    const p = makeCtx(
      () =>
        new Promise(resolve => {
          resolveRequest = resolve
        })
    )
    const dispatch = dispatchSlash('/reasoning medium', p.ctx)
    p.sessionId.value = 'sid-2'
    resolveRequest({ value: 'medium' })

    await dispatch

    expect(p.system).toEqual([])
  })
})

const TREE_ENTRIES = {
  entries: [
    { count: 3, finished_at: 1_760_000_000, label: 'fanout A', path: '/trees/sid-1/a.json', session_id: 'sid-1' },
    { count: 1, finished_at: 1_760_000_100, label: '', path: '/trees/sid-1/b.json', session_id: 'sid-1' }
  ]
}

const TREE_PAYLOAD = {
  finished_at: 1_760_000_000,
  label: 'fanout A',
  session_id: 'sid-1',
  subagents: [
    {
      depth: 0,
      durationSeconds: 12.4,
      goal: 'crunch the data',
      inputTokens: 1200,
      model: 'hermes-4-405b',
      outputTokens: 300,
      status: 'completed',
      summary: 'crunched it',
      toolCount: 3
    },
    { depth: 1, goal: 'child probe', status: 'failed' }
  ]
}

describe('/replay (spawn-tree inspector)', () => {
  test('bare /replay lists via spawn_tree.list and pages indexed rows', async () => {
    const p = makeCtx(async method => (method === 'spawn_tree.list' ? TREE_ENTRIES : {}))
    await dispatchSlash('/replay', p.ctx)
    expect(p.calls).toEqual([{ method: 'spawn_tree.list', params: { limit: 30, session_id: 'sid-1' } }])
    expect(p.paged).toHaveLength(1)
    expect(p.paged[0]!.title).toBe('Spawn trees')
    expect(p.paged[0]!.text).toContain('1. ')
    expect(p.paged[0]!.text).toContain('fanout A')
    expect(p.paged[0]!.text).toContain('/trees/sid-1/a.json')
    // label-less rows fall back to the subagent count
    expect(p.paged[0]!.text).toContain('1 subagent')
  })

  test('/replay <n> lists then loads the n-th entry by path and pages the tree', async () => {
    const p = makeCtx(async method =>
      method === 'spawn_tree.list' ? TREE_ENTRIES : method === 'spawn_tree.load' ? TREE_PAYLOAD : {}
    )
    await dispatchSlash('/replay 1', p.ctx)
    expect(p.calls.map(c => c.method)).toEqual(['spawn_tree.list', 'spawn_tree.load'])
    expect(p.calls[1]!.params).toEqual({ path: '/trees/sid-1/a.json' })
    expect(p.paged[0]!.title).toBe('Replay 1')
    expect(p.paged[0]!.text).toContain('✓ [1] crunch the data')
    expect(p.paged[0]!.text).toContain('completed · hermes-4-405b · 12s · 3 tools · 1200 in / 300 out tok')
    expect(p.paged[0]!.text).toContain('crunched it')
    // depth-1 child is indented under its parent and flags the failure
    expect(p.paged[0]!.text).toContain('  ✗ [2] child probe')
  })

  test('/replay with an out-of-range index reports the valid range', async () => {
    const p = makeCtx(async method => (method === 'spawn_tree.list' ? TREE_ENTRIES : {}))
    await dispatchSlash('/replay 99', p.ctx)
    expect(p.system[0]).toContain('index out of range 1..2')
    expect(p.calls.map(c => c.method)).toEqual(['spawn_tree.list'])
  })

  test('/replay <path> loads straight from disk (no list RPC)', async () => {
    const p = makeCtx(async method => (method === 'spawn_tree.load' ? TREE_PAYLOAD : {}))
    await dispatchSlash('/replay /trees/sid-1/a.json', p.ctx)
    expect(p.calls).toEqual([{ method: 'spawn_tree.load', params: { path: '/trees/sid-1/a.json' } }])
    expect(p.paged[0]!.title).toBe('Replay')
    expect(p.paged[0]!.text).toContain('fanout A')
  })

  test('empty archive and RPC failures land as system notices', async () => {
    const p = makeCtx(async () => ({ entries: [] }))
    await dispatchSlash('/replay', p.ctx)
    expect(p.system[0]).toContain('no archived spawn trees')

    const p2 = makeCtx(async () => {
      throw new Error('boom')
    })
    await dispatchSlash('/replay', p2.ctx)
    expect(p2.system).toEqual(['/replay: boom'])
  })
})

describe('/mem', () => {
  afterEach(() => vi.restoreAllMocks())

  test('prints heap/external/rss/uptime + the renderable count, no gateway RPC', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      arrayBuffers: 1024,
      external: 2 * 1024 * 1024,
      heapTotal: 200 * 1024 * 1024,
      heapUsed: 123_456_789,
      rss: 456 * 1024 * 1024
    } as NodeJS.MemoryUsage)
    vi.spyOn(process, 'uptime').mockReturnValue(42.4)
    const p = makeCtx(async () => ({}))
    p.renderables.value = 321
    await dispatchSlash('/mem', p.ctx)
    expect(p.calls).toHaveLength(0)
    const out = p.system[0]!
    expect(out).toContain('heap used')
    expect(out).toContain('117.7 MB')
    expect(out).toContain('heap total')
    expect(out).toContain('200.0 MB')
    expect(out).toContain('external')
    expect(out).toContain('array buffers')
    expect(out).toContain('rss')
    expect(out).toContain('456.0 MB')
    expect(out).toContain('uptime')
    expect(out).toContain('42s')
    expect(out).toContain('renderables')
    expect(out).toContain('321')
  })

  test('omits the renderables row when no renderer is reachable', async () => {
    vi.spyOn(process, 'uptime').mockReturnValue(5)
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/mem', p.ctx)
    expect(p.system[0]).not.toContain('renderables')
  })
})

describe('/heapdump', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-heap-'))
    process.env.HERMES_HOME = home
  })
  afterEach(() => {
    delete process.env.HERMES_HOME
    rmSync(home, { force: true, recursive: true })
    vi.restoreAllMocks()
  })

  test('writes the snapshot under $HERMES_HOME/logs and reports before/after', async () => {
    const v8 = await import('node:v8')
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/heapdump', p.ctx)
    expect(p.calls).toHaveLength(0)
    expect(p.system).toHaveLength(2)
    expect(p.system[0]).toContain('writing heap dump (heap ')
    expect(p.system[1]).toContain(`heapdump: ${join(home, 'logs')}`)
    expect(p.system[1]).toContain('.heapsnapshot')
    expect(p.system[1]).toMatch(/heap .+ → .+ · rss .+ → .+/)
    expect(vi.mocked(v8.writeHeapSnapshot)).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(v8.writeHeapSnapshot).mock.calls[0]![0] as string
    expect(arg.startsWith(join(home, 'logs', 'opentui-heap-'))).toBe(true)
  })

  test('a write failure lands as a system error, not a crash', async () => {
    const v8 = await import('node:v8')
    vi.mocked(v8.writeHeapSnapshot).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/heapdump', p.ctx)
    expect(p.system[1]).toBe('heapdump failed: disk full')
  })
})

describe('details logic (pure)', () => {
  test('compactFromConfig mirrors Ink truthiness for the persisted compact flag', () => {
    expect(compactFromConfig({ display: { tui_compact: true } })).toBe(true)
    expect(compactFromConfig({ display: { tui_compact: false } })).toBe(false)
    expect(compactFromConfig({ display: { tui_compact: 'true' } })).toBe(true)
    expect(compactFromConfig({})).toBe(false)
  })

  test('detailsFromConfig hydrates global mode and only validated section overrides', () => {
    expect(
      detailsFromConfig({
        display: {
          details_mode: 'expanded',
          sections: { activity: 'hidden', thinking: 'loud', tools: 'collapsed', future: 'hidden' }
        }
      })
    ).toEqual({ mode: 'expanded', sections: { activity: 'hidden', tools: 'collapsed' } })
    expect(detailsFromConfig({ display: { thinking_mode: 'full' } })).toEqual({ mode: 'expanded', sections: {} })
  })

  test('parseDetailsMode + nextDetailsMode', () => {
    expect(parseDetailsMode(' Expanded ')).toBe('expanded')
    expect(parseDetailsMode('nope')).toBeNull()
    expect(nextDetailsMode('hidden')).toBe('collapsed')
    expect(nextDetailsMode('collapsed')).toBe('expanded')
    expect(nextDetailsMode('expanded')).toBe('hidden')
  })

  test('collapseHiddenParts folds consecutive tool/reasoning runs; text passes through by reference', () => {
    const parts: Part[] = [
      { id: 'p1', text: 'intro', type: 'text' },
      { id: 'p2', name: 'bash', state: 'complete', type: 'tool' },
      { id: 'p3', text: 'mull', type: 'reasoning' },
      { id: 'p4', name: 'read', state: 'complete', type: 'tool' },
      { id: 'p5', text: 'middle', type: 'text' },
      { id: 'p6', name: 'grep', state: 'running', type: 'tool' }
    ]
    const out = collapseHiddenParts(parts)
    expect(out.map(p => p.type)).toEqual(['text', 'hiddenRun', 'text', 'hiddenRun'])
    expect(out[0]).toBe(parts[0]) // identity preserved → no remount of text parts
    expect(out[1]).toMatchObject({ id: 'hidden-p2', thoughts: 1, tools: 2 })
    expect(out[3]).toMatchObject({ thoughts: 0, tools: 1 })
  })

  test('sectionMode follows explicit override → global command → built-in default → global config', () => {
    expect(sectionMode('tools', 'collapsed', { tools: 'hidden' })).toBe('hidden')
    expect(sectionMode('tools', 'hidden', {}, true)).toBe('hidden')
    expect(sectionMode('tools', 'collapsed', {})).toBe('expanded')
    expect(sectionMode('subagents', 'collapsed', {})).toBe('collapsed')
    expect(sectionMode('delegation', 'expanded', {})).toBe('collapsed')
    expect(sectionMode('delegation', 'collapsed', { delegation: 'expanded' })).toBe('expanded')
  })

  test('collapseHiddenPartsBy folds only hidden sections and preserves visible boundaries', () => {
    const parts: Part[] = [
      { id: 'r', text: 'thought', type: 'reasoning' },
      { id: 't', name: 'bash', state: 'complete', type: 'tool' }
    ]
    const out = collapseHiddenPartsBy(parts, section => section === 'tools')
    expect(out.map(part => part.type)).toEqual(['reasoning', 'hiddenRun'])
    expect(out[1]).toMatchObject({ thoughts: 0, tools: 1 })
  })

  test('hiddenRunLabel pluralizes honestly and points back to /details', () => {
    expect(hiddenRunLabel({ id: 'h', thoughts: 0, tools: 3, type: 'hiddenRun' })).toBe(
      '3 tools hidden — /details collapsed to show'
    )
    expect(hiddenRunLabel({ id: 'h', thoughts: 1, tools: 1, type: 'hiddenRun' })).toBe(
      '1 tool · 1 thought hidden — /details collapsed to show'
    )
  })
})

describe('diagnostics + replay formatters (pure)', () => {
  test('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(123_456_789)).toBe('117.7 MB')
    expect(formatBytes(-1)).toBe('0 B')
  })

  test('heapSnapshotPath prefers HERMES_HOME', () => {
    process.env.HERMES_HOME = '/custom/home'
    try {
      const p = heapSnapshotPath(new Date('2026-06-10T12:00:00Z'))
      expect(p).toBe('/custom/home/logs/opentui-heap-2026-06-10T12-00-00-000Z.heapsnapshot')
    } finally {
      delete process.env.HERMES_HOME
    }
  })

  test('memReport without a renderable count omits the row', () => {
    const text = memReport({ arrayBuffers: 0, external: 0, heapTotal: 1024, heapUsed: 512, rss: 2048 }, 9.6)
    expect(text.split('\n')[0]).toBe('memory')
    expect(text).toContain('uptime')
    expect(text).toContain('10s')
    expect(text).not.toContain('renderables')
  })

  test('readSpawnTreeEntries tolerates garbage', () => {
    expect(readSpawnTreeEntries(null)).toEqual([])
    expect(readSpawnTreeEntries({ entries: 'nope' })).toEqual([])
    expect(readSpawnTreeEntries({ entries: [{ label: 'no path' }, 7, null] })).toEqual([])
    expect(readSpawnTreeEntries({ entries: [{ count: 2, path: '/a.json' }] })).toEqual([
      { count: 2, label: '', path: '/a.json' }
    ])
  })

  test('formatSpawnTreeList indexes rows; formatSpawnTree handles an empty snapshot', () => {
    const list = formatSpawnTreeList([{ count: 2, label: 'x', path: '/a.json' }])
    expect(list).toContain('  1. ')
    expect(list).toContain('/a.json')
    expect(formatSpawnTree({ subagents: [] })).toContain('(snapshot empty or unreadable)')
    expect(formatSpawnTree('garbage')).toContain('(snapshot empty or unreadable)')
  })
})
