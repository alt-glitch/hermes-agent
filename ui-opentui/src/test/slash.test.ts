/**
 * Slash dispatch test (spec §5 Layer 3/4). Pure logic: parse + the dispatch
 * ladder (client → slash.exec → command.dispatch) against a fake SlashContext.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { DetailsMode } from '../logic/details.ts'
import type { BusyInputMode } from '../logic/busyQueue.ts'
import {
  buildModelTabs,
  BUSY_QUEUE_FULL_MESSAGE,
  clearModelPrefetch,
  classifySubmit,
  clientCommandNames,
  catalogCommandItems,
  createCompletionGate,
  DASHBOARD_EXIT_DISABLED_MESSAGE,
  DASHBOARD_UPDATE_DISABLED_MESSAGE,
  dispatchSlash,
  formatHistory,
  HISTORY_MAX_MESSAGES,
  HISTORY_MAX_PAGER_CHARS,
  HISTORY_MAX_PREVIEW,
  mapCompletions,
  parseSlash,
  pickerTabs,
  planCompletion,
  readReplaceFrom,
  registerModelPrefetch,
  registerPickerRefresh,
  registerPickerTabs,
  runPickerRefresh,
  startModelPrefetch,
  type SlashContext
} from '../logic/slash.ts'
import type { SessionTabId } from '../logic/sessionPicker.ts'
import type { ConfirmRequest, Message, PickerItem } from '../logic/store.ts'
import type { BillingOverlayState, BillingStateResponse } from '../boundary/billing.ts'
import type { SessionCompressResponse } from '../boundary/compression.ts'

// the picker-refresh/tabs/prefetch seams are module-level state — never leak them across tests
afterEach(() => {
  vi.useRealTimers()
  registerPickerRefresh(undefined)
  registerPickerTabs(undefined)
  clearModelPrefetch()
})

/** A minimal billing.state snapshot for the /billing dispatch tests. */
function fakeCompressResponse(over: Partial<SessionCompressResponse> = {}): SessionCompressResponse {
  return {
    after_messages: 1,
    after_tokens: 40,
    before_messages: 6,
    before_tokens: 120,
    info: { model: 'test/model', running: false },
    messages: [{ role: 'assistant', text: 'compressed summary' }],
    removed: 5,
    status: 'compressed',
    summary: { headline: 'Compressed: 6 → 1 messages', noop: false, note: null, token_line: 'Approx request size: ~120 → ~40 tokens' },
    usage: { calls: 2, completion: 20, input: 80, model: 'test/model', output: 20, prompt: 80, reasoning: 0, total: 100 },
    ...over
  }
}

function fakeBillingState(over: Partial<BillingStateResponse> = {}): BillingStateResponse {
  return {
    auto_reload: null,
    balance_display: '$42.00',
    balance_usd: '42.00',
    can_charge: true,
    card: null,
    charge_presets: ['10', '25', '100'],
    charge_presets_display: ['$10', '$25', '$100'],
    cli_billing_enabled: true,
    is_admin: true,
    logged_in: true,
    max_usd: '1000',
    min_usd: '5',
    monthly_cap: null,
    ok: true,
    org_name: 'Nous',
    portal_url: 'https://portal.example/billing',
    role: 'owner',
    ...over
  }
}

/** A `model.options` payload: two authed providers + two unconfigured skeleton
 *  rows (the gateway sends them with `include_unconfigured=True,
 *  picker_hints=True`: empty models + `key_env`/`warning` setup hints). */
const MODEL_OPTIONS = {
  model: 'claude-sonnet-4.6',
  provider: 'anthropic',
  providers: [
    {
      authenticated: true,
      models: ['claude-sonnet-4.6', 'claude-opus-4.6'],
      name: 'Anthropic',
      slug: 'anthropic'
    },
    {
      authenticated: false,
      key_env: 'OPENAI_API_KEY',
      models: [],
      name: 'OpenAI API',
      slug: 'openai-api',
      warning: 'paste OPENAI_API_KEY to activate'
    },
    { authenticated: true, models: ['hermes-4-405b'], name: 'Nous Research', slug: 'nous' },
    {
      authenticated: false,
      key_env: '',
      models: [],
      name: 'OpenAI Codex',
      slug: 'openai-codex',
      warning: 'run `hermes model` to configure (oauth_external)'
    }
  ]
}

describe('mapCompletions', () => {
  test('maps complete.slash items → candidates (display/meta default)', () => {
    expect(
      mapCompletions({ items: [{ display: '/compact', meta: 'compress', text: '/compact' }, { text: '/details' }] })
    ).toEqual([
      { display: '/compact', meta: 'compress', text: '/compact' },
      { display: '/details', meta: '', text: '/details' }
    ])
    expect(mapCompletions({ items: [] })).toEqual([])
    expect(mapCompletions(null)).toEqual([])
  })
})

describe('catalogCommandItems (slash-highlight boot seed — glitch 2026-06-14)', () => {
  test('extracts canonical pairs plus de-duplicated alias keys from commands.catalog', () => {
    expect(
      catalogCommandItems({
        canon: { '/h': '/help', '/help': '/help', '/mod': '/model', '/q': '/queue' },
        pairs: [
          ['/handoff', 'compact the conversation'],
          ['/model', 'switch model'],
          ['/help', 'show help'],
          ['/clear', '']
        ]
      })
    ).toEqual([
      { text: '/handoff' },
      { text: '/model' },
      { text: '/help' },
      { text: '/clear' },
      { text: '/h' },
      { text: '/mod' },
      { text: '/q' }
    ])
  })
  test('shape-defensive: junk / missing pairs → []', () => {
    expect(catalogCommandItems(null)).toEqual([])
    expect(catalogCommandItems({})).toEqual([])
    expect(catalogCommandItems({ pairs: 'nope' })).toEqual([])
    // skip non-array pairs, non-string names, and empty names
    expect(catalogCommandItems({ pairs: [['/ok', 'd'], 42, [123, 'd'], ['', 'd'], []] })).toEqual([{ text: '/ok' }])
  })
})

describe('createCompletionGate (out-of-order completion guard — glitch 2026-06-14)', () => {
  test('only the most-recently-claimed token is current', () => {
    const gate = createCompletionGate()
    const a = gate.claim()
    expect(gate.isCurrent(a)).toBe(true)
    const b = gate.claim()
    // a newer keystroke superseded `a`
    expect(gate.isCurrent(a)).toBe(false)
    expect(gate.isCurrent(b)).toBe(true)
  })

  test('reproduces the bug scenario: a slow earlier response is dropped, a fresh one applies', () => {
    // Model the exact sequence: a slow `complete.slash` from a bare `/`, then a
    // synchronous clear keystroke (no RPC), then an `@`-mention `complete.path`.
    const gate = createCompletionGate()
    const slashToken = gate.claim() // user typed `/` → complete.slash fired
    gate.claim() // user typed `/x` → planCompletion null → clear branch (no RPC)
    // …user submits, then types `@file`:
    const pathToken = gate.claim() // complete.path fired

    // The slow complete.slash resolves LAST — it must be dropped, not applied,
    // so it can't blank/clobber the @-mention dropdown.
    expect(gate.isCurrent(slashToken)).toBe(false)
    // The @-mention response is still current and applies.
    expect(gate.isCurrent(pathToken)).toBe(true)
  })

  test('independent gates do not share state', () => {
    const g1 = createCompletionGate()
    const g2 = createCompletionGate()
    const t1 = g1.claim()
    g2.claim()
    expect(g1.isCurrent(t1)).toBe(true) // g2's claim doesn't supersede g1's
  })
})

describe('planCompletion (items 5 + 13)', () => {
  test('a slash command line → complete.slash with the full text (name AND args)', () => {
    expect(planCompletion('/mod')).toEqual({ from: 0, method: 'complete.slash', params: { text: '/mod' } })
    // args too — the gateway completes e.g. /details section names
    expect(planCompletion('/details thi')).toEqual({
      from: 0,
      method: 'complete.slash',
      params: { text: '/details thi' }
    })
  })

  test('a bare `/` opens the slash menu (hydrate immediately — glitch 2026-06-13)', () => {
    expect(planCompletion('/')).toEqual({ from: 0, method: 'complete.slash', params: { text: '/' } })
    // a trailing space past the (empty) name is not a command — no arg-complete on nothing.
    expect(planCompletion('/ ')).toBeNull()
  })

  test('a `/abs/path` is NOT a slash command — the lead token has a `/` (F2)', () => {
    expect(planCompletion('/usr/bin')).toBeNull()
    expect(planCompletion('/etc/hosts and notes')).toBeNull()
    expect(planCompletion('/./x')).toBeNull()
  })

  test('@-mention is the only path trigger (F8b) — `~`/`./`/bare paths no longer fire', () => {
    expect(planCompletion('explain @src/fo')).toEqual({
      from: 'explain '.length,
      method: 'complete.path',
      params: { word: '@src/fo' }
    })
    expect(planCompletion('@foo')).toEqual({ from: 0, method: 'complete.path', params: { word: '@foo' } })
    // dropped triggers:
    expect(planCompletion('cat ./rea')).toBeNull()
    expect(planCompletion('open ~/proj')).toBeNull()
    expect(planCompletion('see path/to/x')).toBeNull()
  })

  test('completion survives newlines, computed at the cursor (F7/F8)', () => {
    // a `@`-mention on a later line (after Shift+Enter) still completes
    const text = 'first line\nexplain @src/fo'
    expect(planCompletion(text, text.length)).toEqual({
      from: 'first line\nexplain '.length,
      method: 'complete.path',
      params: { word: '@src/fo' }
    })
    // mid-buffer: cursor inside the @token on line 2
    const t2 = 'see @foo\nmore'
    expect(planCompletion(t2, 8)).toEqual({ from: 4, method: 'complete.path', params: { word: '@foo' } })
  })

  test('a `/` after a newline is prose, never a slash command', () => {
    expect(planCompletion('/cmd with\nnewline')).toBeNull()
  })

  test('plain prose → no completion', () => {
    expect(planCompletion('just some words')).toBeNull()
    expect(planCompletion('hello')).toBeNull()
  })
})

describe('classifySubmit (F9 routing)', () => {
  test('a `!cmd` line routes to shell with the bang stripped + trimmed', () => {
    expect(classifySubmit('!ls -la')).toEqual({ kind: 'shell', payload: 'ls -la' })
    expect(classifySubmit('!  git status  ')).toEqual({ kind: 'shell', payload: 'git status' })
    expect(classifySubmit('!')).toEqual({ kind: 'shell', payload: '' })
  })

  test('a `/command` line routes to slash with the full text', () => {
    expect(classifySubmit('/model opus')).toEqual({ kind: 'slash', payload: '/model opus' })
  })

  test('everything else is a prompt turn', () => {
    expect(classifySubmit('hello world')).toEqual({ kind: 'prompt', payload: 'hello world' })
    expect(classifySubmit('explain @src/x')).toEqual({ kind: 'prompt', payload: 'explain @src/x' })
  })
})

describe('readReplaceFrom', () => {
  test('reads gateway replace_from, falls back when absent/non-number', () => {
    expect(readReplaceFrom({ items: [], replace_from: 9 }, 0)).toBe(9)
    expect(readReplaceFrom({ items: [] }, 4)).toBe(4)
    expect(readReplaceFrom({ replace_from: 'nope' }, 7)).toBe(7)
    expect(readReplaceFrom(null, 2)).toBe(2)
  })
})

describe('parseSlash', () => {
  test('splits name + arg; rejects non-slash / empty', () => {
    expect(parseSlash('/help')).toEqual({ name: 'help', arg: '' })
    expect(parseSlash('/model anthropic/claude')).toEqual({ name: 'model', arg: 'anthropic/claude' })
    expect(parseSlash('/HELP')).toEqual({ name: 'help', arg: '' })
    expect(parseSlash('/model   anthropic/claude\tfast')).toEqual({
      name: 'model',
      arg: 'anthropic/claude fast'
    })
    // Ink does not silently reinterpret whitespace immediately after `/` as a
    // local command name; preserve that distinction for the server fallback.
    expect(parseSlash('/ help')).toEqual({ name: '', arg: 'help' })
    expect(parseSlash('hello')).toBeNull()
    expect(parseSlash('/')).toBeNull()
  })
})

interface Probe {
  ctx: SlashContext
  calls: Array<{ method: string; params: Record<string, unknown> }>
  system: string[]
  submitted: string[]
  /** Skill invocations routed through submitSkill: [command, body] pairs. */
  skillSubmitted: Array<{ command: string; body: string }>
  confirmed: Array<{ request: ConfirmRequest; onConfirm: () => void }>
  paged: Array<{ title: string; text: string }>
  sessionPickers: SessionTabId[]
  resumed: string[]
  pickers: Array<{ title: string; items: PickerItem[]; onPick: (value: string) => void }>
  billed: BillingOverlayState[]
  quit: { value: boolean }
  exitCodes: Array<number | undefined>
  redraws: { value: number }
  dashboardMode: { value: boolean }
  history: { value: Message[] }
  cachedCatalog: { value: ReturnType<SlashContext['commandCatalog']> }
  logLines: { value: string[] }
  logLimits: number[]
  newSessions: Array<[string | undefined, string | undefined]>
  newLiveSessions: Array<[string | undefined, string | undefined]>
  toolsResets: Array<{ readonly [key: string]: unknown }>
  toolsConfiguring: { begins: number; ends: number; value: boolean }
  hasConversation: { value: boolean }
  sessionTitle: { value: string | undefined }
  commandCatalogs: Array<{ catalog: unknown; removedSkills: readonly string[] }>
  session: { value: string | undefined }
  busy: { value: boolean }
  transitioning: { value: boolean }
  dashboard: { value: boolean }
  copied: number[]
  copyN: { value: (n: number) => boolean }
  /** The cached /model rows (Epic 7) — seed to simulate a prefetched catalog. */
  modelCache: { value: PickerItem[] | undefined }
  /** Display flags (/compact, /details — Epic 3). */
  compactFlag: { value: boolean }
  detailsFlag: { value: DetailsMode }
  /** /timestamps display flag — show [HH:MM] on messages (port of 5ff11a689). */
  timestampsFlag: { value: boolean }
  /** /reasoning full|clamp display flag — expand all thinking. */
  reasoningFullFlag: { value: boolean }
  busyMode: { value: BusyInputMode }
  queued: string[]
  queueAccept: { value: boolean }
  prefills: string[]
  trimCalls: { value: number }
  historyMutation: { begins: number; ends: number; value: boolean }
  compressionMutations: Array<{ messages: Message[] | undefined; info: object | undefined; usage: object | undefined }>
  compressionKeys: string[]
  submitAccept: { value: boolean }
}

function makeCtx(request: (method: string, params: Record<string, unknown>) => Promise<unknown>): Probe {
  const calls: Probe['calls'] = []
  const system: string[] = []
  const submitted: string[] = []
  const skillSubmitted: Probe['skillSubmitted'] = []
  const confirmed: Probe['confirmed'] = []
  const paged: Probe['paged'] = []
  const sessionPickers: SessionTabId[] = []
  const resumed: string[] = []
  const pickers: Probe['pickers'] = []
  const billed: Probe['billed'] = []
  const quit = { value: false }
  const exitCodes: Array<number | undefined> = []
  const redraws = { value: 0 }
  const dashboardMode = { value: false }
  const history = { value: [] as Message[] }
  const cachedCatalog: Probe['cachedCatalog'] = { value: undefined }
  const logLines = { value: ['gateway: spawned', 'bootstrap: session created'] }
  const logLimits: number[] = []
  const newSessions: Probe['newSessions'] = []
  const newLiveSessions: Probe['newLiveSessions'] = []
  const toolsResets: Probe['toolsResets'] = []
  const toolsConfiguring: Probe['toolsConfiguring'] = { begins: 0, ends: 0, value: false }
  const hasConversation = { value: true }
  const sessionTitle: Probe['sessionTitle'] = { value: undefined }
  const commandCatalogs: Probe['commandCatalogs'] = []
  const session: Probe['session'] = { value: 'sid-1' }
  const busy = { value: false }
  const transitioning = { value: false }
  const dashboard = { value: false }
  const copied: number[] = []
  const copyN: Probe['copyN'] = { value: () => false }
  const modelCache: Probe['modelCache'] = { value: undefined }
  const compactFlag: Probe['compactFlag'] = { value: false }
  const detailsFlag: Probe['detailsFlag'] = { value: 'collapsed' }
  const timestampsFlag: Probe['timestampsFlag'] = { value: false }
  const reasoningFullFlag: Probe['reasoningFullFlag'] = { value: false }
  const busyMode: Probe['busyMode'] = { value: 'queue' }
  const queued: string[] = []
  const queueAccept = { value: true }
  const prefills: string[] = []
  const trimCalls = { value: 0 }
  const historyMutation = { begins: 0, ends: 0, value: false }
  const compressionMutations: Probe['compressionMutations'] = []
  const compressionKeys: string[] = []
  const submitAccept = { value: true }
  const ctx: SlashContext = {
    guardBusySessionSwitch: () => busy.value,
    newSession: (message, title) => newSessions.push([message, title]),
    newLiveSession: (message, title) => newLiveSessions.push([message, title]),
    beginToolsConfigure: () => {
      toolsConfiguring.begins += 1
      toolsConfiguring.value = true
    },
    endToolsConfigure: () => {
      toolsConfiguring.ends += 1
      toolsConfiguring.value = false
    },
    resetAfterToolsConfigure: info => toolsResets.push(info),
    hasConversation: () => hasConversation.value,
    setSessionTitle: title => (sessionTitle.value = title),
    refreshCommandCatalog: (catalog, removedSkills) => {
      commandCatalogs.push({ catalog, removedSkills })
      if (catalog && typeof catalog === 'object' && 'pairs' in catalog) {
        cachedCatalog.value = catalog as NonNullable<Probe['cachedCatalog']['value']>
      } else cachedCatalog.value = undefined
    },
    commandCatalog: () => cachedCatalog.value,
    historyItems: () => history.value,
    replaceConversationSnapshot: (messages, info, usage) => {
      compressionMutations.push({ messages, info, usage })
      if (messages !== undefined) history.value = messages
    },
    setCompressedSessionKey: key => compressionKeys.push(key),
    helpHeader: () => '(^_^)? Commands',
    dashboardMode: () => dashboardMode.value,
    compact: () => compactFlag.value,
    setCompact: on => (compactFlag.value = on),
    details: () => detailsFlag.value,
    setDetails: mode => (detailsFlag.value = mode),
    timestamps: () => timestampsFlag.value,
    setTimestamps: on => (timestampsFlag.value = on),
    reasoningFull: () => reasoningFullFlag.value,
    setReasoningFull: on => (reasoningFullFlag.value = on),
    isBusy: () => busy.value,
    isSessionTransitioning: () => transitioning.value,
    beginHistoryMutation: () => {
      if (historyMutation.value) return false
      historyMutation.value = true
      historyMutation.begins += 1
      return true
    },
    endHistoryMutation: () => {
      historyMutation.value = false
      historyMutation.ends += 1
    },
    busyInputMode: () => busyMode.value,
    setBusyInputMode: mode => (busyMode.value = mode),
    queueCount: () => queued.length,
    enqueueQueued: (text, front = false) => {
      if (!queueAccept.value) return false
      if (front) queued.unshift(text)
      else queued.push(text)
      return true
    },
    clearQueued: () => queued.splice(0).length,
    steer: async (sid, text) => {
      const params = { session_id: sid, text }
      calls.push({ method: 'session.steer', params })
      const raw = await request('session.steer', params)
      const status = raw && typeof raw === 'object' && 'status' in raw ? raw.status : undefined
      if (status === 'queued') return 'queued'
      if (status === 'retained') return 'retained'
      if (status === 'uncertain') {
        queued.push(text)
        return 'uncertain'
      }
      // The production entry decodes every non-queued success as a definite
      // rejection and retains the body before returning `fallback`.
      queued.push(text)
      return 'fallback'
    },
    lastUserMessage: () => [...history.value].reverse().find(message => message.role === 'user')?.text,
    trimLastExchange: () => {
      trimCalls.value += 1
      return 2
    },
    prefillComposer: text => prefills.push(text),
    renderableCount: () => undefined,
    confirm: (request, onConfirm) => confirmed.push({ request, onConfirm }),
    copyResponse: n => {
      copied.push(n)
      return copyN.value(n)
    },
    logTail: limit => {
      logLimits.push(limit)
      return logLines.value.slice(-limit)
    },
    modelItems: () => modelCache.value,
    setModelItems: items => (modelCache.value = items),
    openDashboard: () => (dashboard.value = true),
    openBackgroundPanel: () => {},
    openBilling: overlay => billed.push(overlay),
    addBgTask: () => {},
    openPager: (title, text) => paged.push({ text, title }),
    openPicker: p => pickers.push(p),
    openSessionPicker: tab => sessionPickers.push(tab),
    resumeSession: id => resumed.push(id),
    pushSystem: text => system.push(text),
    quit: code => {
      quit.value = true
      exitCodes.push(code)
    },
    redraw: () => {
      redraws.value += 1
    },
    request: (method, params) => {
      calls.push({ method, params })
      return request(method, params)
    },
    sessionId: () => session.value,
    sessionOwnerId: () => session.value,
    submit: text => {
      submitted.push(text)
      return submitAccept.value
    },
    submitSkill: (command, body) => void skillSubmitted.push({ command, body })
  }
  return {
    calls,
    newSessions,
    newLiveSessions,
    toolsResets,
    toolsConfiguring,
    hasConversation,
    sessionTitle,
    commandCatalogs,
    session,
    busy,
    transitioning,
    compactFlag,
    confirmed,
    copied,
    copyN,
    ctx,
    dashboard,
    detailsFlag,
    timestampsFlag,
    reasoningFullFlag,
    busyMode,
    queued,
    queueAccept,
    prefills,
    trimCalls,
    modelCache,
    paged,
    pickers,
    billed,
    cachedCatalog,
    dashboardMode,
    exitCodes,
    history,
    historyMutation,
    compressionMutations,
    compressionKeys,
    logLines,
    logLimits,
    quit,
    redraws,
    resumed,
    skillSubmitted,
    sessionPickers,
    submitted,
    submitAccept,
    system
  }
}

describe('dispatchSlash — client commands', () => {
  test('/quit and /exit request a cleanup-safe zero exit without hitting the gateway', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/quit', p.ctx)
    expect(p.quit.value).toBe(true)
    expect(p.exitCodes).toEqual([0])
    expect(p.calls).toHaveLength(0)

    const exit = makeCtx(async () => ({}))
    await dispatchSlash('/EXIT --delete', exit.ctx)
    expect(exit.exitCodes).toEqual([0])
    expect(exit.calls).toHaveLength(0)
  })

  test('/quit and /exit refuse to destroy a hosted dashboard PTY', async () => {
    for (const command of ['/quit', '/exit']) {
      const p = makeCtx(async () => ({}))
      p.dashboardMode.value = true
      await dispatchSlash(command, p.ctx)
      expect(p.exitCodes).toEqual([])
      expect(p.system).toEqual([DASHBOARD_EXIT_DISABLED_MESSAGE])
      expect(p.calls).toHaveLength(0)
    }
  })

  test('/update paints a notice, then exits 42 after 100ms; hosted mode refuses', async () => {
    vi.useFakeTimers()
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/update ignored', p.ctx)
    expect(p.system).toEqual(['exiting TUI to run update...'])
    expect(p.exitCodes).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(99)
    expect(p.exitCodes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(p.exitCodes).toEqual([42])
    expect(p.calls).toHaveLength(0)

    const hosted = makeCtx(async () => ({}))
    hosted.dashboardMode.value = true
    await dispatchSlash('/update', hosted.ctx)
    expect(hosted.system).toEqual([DASHBOARD_UPDATE_DISABLED_MESSAGE])
    expect(hosted.exitCodes).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  test('/redraw uses the renderer-native repaint capability and reports success', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/redraw', p.ctx)
    expect(p.redraws.value).toBe(1)
    expect(p.system).toEqual(['ui redrawn'])
    expect(p.calls).toHaveLength(0)
  })

  test('/clear opens the destructive session confirm and starts a replacement only after confirmation', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/clear', p.ctx)
    expect(p.confirmed).toHaveLength(1)
    expect(p.confirmed[0]?.request).toEqual({
      cancelLabel: 'No, keep going',
      confirmLabel: 'Yes, clear the session',
      danger: true,
      detail: 'This ends the current conversation and clears the transcript.',
      title: 'Clear the current session?'
    })
    expect(p.newSessions).toHaveLength(0)
    p.confirmed[0]!.onConfirm()
    expect(p.newSessions).toEqual([[undefined, undefined]])
  })

  test('/new trims and forwards its title; busy sessions never open the confirm', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/new   release candidate  ', p.ctx)
    expect(p.confirmed[0]?.request).toMatchObject({
      confirmLabel: 'Yes, start a new session',
      title: 'Start a new session?'
    })
    p.confirmed[0]!.onConfirm()
    expect(p.newSessions).toEqual([['new session started', 'release candidate']])

    const blocked = makeCtx(async () => ({}))
    blocked.busy.value = true
    await dispatchSlash('/clear', blocked.ctx)
    expect(blocked.confirmed).toHaveLength(0)
    expect(blocked.newSessions).toHaveLength(0)
  })

  test('/queue and /q inspect/enqueue locally, with explicit bounded-queue failure', async () => {
    const p = makeCtx(async () => {
      throw new Error('queue must stay local')
    })
    await dispatchSlash('/queue', p.ctx)
    await dispatchSlash('/q first queued prompt', p.ctx)
    await dispatchSlash(`/queue ${'x'.repeat(70)}`, p.ctx)
    expect(p.calls).toEqual([])
    expect(p.queued).toEqual(['first queued prompt', 'x'.repeat(70)])
    expect(p.system[0]).toBe('0 queued message(s)')
    expect(p.system[1]).toBe('queued: "first queued prompt"')
    expect(p.system[2]).toBe(`queued: "${'x'.repeat(50)}…"`)

    p.queueAccept.value = false
    await dispatchSlash('/queue rejected', p.ctx)
    expect(p.queued).toHaveLength(2)
    expect(p.system.at(-1)).toBe(BUSY_QUEUE_FULL_MESSAGE)
    expect(p.prefills).toEqual(['/queue rejected'])
  })

  test('/queue --clear requires explicit confirmation and bulk-discards', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/queue first', p.ctx)
    await dispatchSlash('/queue second', p.ctx)
    await dispatchSlash('/queue --clear', p.ctx)
    expect(p.queued).toEqual(['first', 'second'])
    expect(p.confirmed).toHaveLength(1)
    expect(p.confirmed[0]?.request).toMatchObject({ danger: true, title: 'Clear the pending queue?' })
    p.confirmed[0]?.onConfirm()
    expect(p.queued).toEqual([])
    expect(p.system.at(-1)).toBe('discarded 2 queued message(s)')
  })

  test('/steer queues while idle and uses the active session RPC while busy', async () => {
    const idle = makeCtx(async () => {
      throw new Error('idle steer must stay local')
    })
    await dispatchSlash('/steer later', idle.ctx)
    expect(idle.queued).toEqual(['later'])
    expect(idle.system).toEqual(['no active turn — queued for next: "later"'])

    const live = makeCtx(async method => (method === 'session.steer' ? { status: 'queued', text: 'now' } : {}))
    live.busy.value = true
    await dispatchSlash('/steer now', live.ctx)
    expect(live.calls).toEqual([{ method: 'session.steer', params: { session_id: 'sid-1', text: 'now' } }])
    expect(live.system).toEqual(['steer queued — arrives after next tool call: "now"'])

    const uncertain = makeCtx(async method => (method === 'session.steer' ? { status: 'uncertain' } : {}))
    uncertain.busy.value = true
    await dispatchSlash('/steer retry explicitly', uncertain.ctx)
    expect(uncertain.queued).toEqual(['retry explicitly'])
    expect(uncertain.system).toEqual(['steer delivery uncertain — message retained; send it explicitly to retry'])

    const fallback = makeCtx(async method => (method === 'session.steer' ? { status: 'fallback' } : {}))
    fallback.busy.value = true
    await dispatchSlash('/steer queued atomically', fallback.ctx)
    expect(fallback.queued).toEqual(['queued atomically'])
    expect(fallback.system).toEqual(['steer rejected — message queued for next turn'])

    const invalid = makeCtx(async () => ({ status: 'accepted' }))
    invalid.busy.value = true
    await dispatchSlash('/steer malformed', invalid.ctx)
    expect(invalid.queued).toEqual(['malformed'])
    expect(invalid.system).toEqual(['steer rejected — message queued for next turn'])
  })

  test('/steer preserves rejected, failed, and globally-superseded input', async () => {
    const rejected = makeCtx(async () => ({ status: 'rejected' }))
    rejected.busy.value = true
    await dispatchSlash('/steer rejected text', rejected.ctx)
    expect(rejected.queued).toEqual(['rejected text'])
    expect(rejected.system).toEqual(['steer rejected — message queued for next turn'])

    const failed = makeCtx(async () => {
      throw new Error('transport failed')
    })
    failed.busy.value = true
    await dispatchSlash('/steer failed text', failed.ctx)
    expect(failed.queued).toEqual(['failed text'])
    expect(failed.system).toEqual(['/steer: transport failed — message queued for next turn'])

    let resolveSteer!: (value: unknown) => void
    const pending = new Promise<unknown>(resolve => (resolveSteer = resolve))
    const superseded = makeCtx(async method =>
      method === 'session.steer' ? pending : method === 'session.status' ? { output: 'ready' } : {}
    )
    superseded.busy.value = true
    const steer = dispatchSlash('/steer keep me', superseded.ctx)
    await Promise.resolve()
    await dispatchSlash('/status', superseded.ctx)
    resolveSteer({ status: 'rejected' })
    await steer
    expect(superseded.queued).toEqual(['keep me'])
  })

  test('/busy reads or persists the live mode, rejects garbage, and decodes responses', async () => {
    const p = makeCtx(async (method, params) => {
      if (method === 'config.get') return { value: 'steer' }
      if (method === 'config.set') return { value: params.value }
      return {}
    })
    await dispatchSlash('/busy status', p.ctx)
    expect(p.busyMode.value).toBe('queue') // status reports; it does not change the live policy
    await dispatchSlash('/busy interrupt', p.ctx)
    expect(p.busyMode.value).toBe('interrupt')
    expect(p.calls).toEqual([{ method: 'config.set', params: { key: 'busy', value: 'interrupt' } }])
    expect(p.system).toEqual(['busy input mode: queue', 'busy input mode: interrupt'])

    await dispatchSlash('/busy drop', p.ctx)
    expect(p.system.at(-1)).toBe('usage: /busy [queue|steer|interrupt|status]')
    expect(p.calls).toHaveLength(1)

    const malformed = makeCtx(async () => ({ value: 42 }))
    await dispatchSlash('/busy steer', malformed.ctx)
    expect(malformed.system).toEqual(['/busy: invalid config response'])
  })

  test('/compress atomically applies a decoded same-SID snapshot and structured feedback', async () => {
    const response = fakeCompressResponse({
      summary: {
        headline: 'Compressed: 6 → 1 messages',
        noop: false,
        note: 'Note: denser summary',
        token_line: 'Approx request size: ~120 → ~40 tokens'
      }
    })
    const p = makeCtx(async method => (method === 'session.compress' ? response : {}))
    p.history.value = [{ role: 'user', text: 'old transcript' }]
    p.queued.push('keep queued')
    await dispatchSlash('/compress   retain deployment details  ', p.ctx)
    expect(p.calls).toEqual([{
      method: 'session.compress',
      params: { focus_topic: 'retain deployment details', session_id: 'sid-1' }
    }])
    expect(p.compressionMutations).toHaveLength(1)
    expect(p.history.value[0]).toMatchObject({ role: 'assistant', text: 'compressed summary' })
    expect(p.queued).toEqual(['keep queued'])
    expect(p.system).toEqual([
      '✓ Compressed: 6 → 1 messages',
      '  Approx request size: ~120 → ~40 tokens',
      '  Note: denser summary'
    ])
    expect(p.historyMutation).toMatchObject({ begins: 1, ends: 1, value: false })
  })

  test('/compress accepts sparse no-op and metadata-only responses', async () => {
    const noop = makeCtx(async () => ({ removed: 0, status: 'compressed' }))
    noop.history.value = [{ role: 'user', text: 'unchanged' }]
    await dispatchSlash('/compress', noop.ctx)
    expect(noop.history.value[0]?.text).toBe('unchanged')
    expect(noop.compressionMutations).toEqual([])
    expect(noop.system).toEqual(['nothing to compress'])

    const sparse = makeCtx(async () => ({
      info: { model: 'rotated-model' },
      removed: 2,
      session_key: 'durable-rotated',
      status: 'compressed',
      usage: { total: 1500 }
    }))
    sparse.history.value = [{ role: 'user', text: 'visible remains' }]
    await dispatchSlash('/compress', sparse.ctx)
    expect(sparse.history.value[0]?.text).toBe('visible remains')
    expect(sparse.compressionMutations).toEqual([{
      messages: undefined,
      info: { model: 'rotated-model' },
      usage: { total: 1500 }
    }])
    expect(sparse.compressionKeys).toEqual(['durable-rotated'])
    expect(sparse.system).toEqual(['compressed 2 messages · 1.5k tok'])
  })

  test('/compress leaves history intact on malformed/error/stale responses and respects guards', async () => {
    const malformed = makeCtx(async () => ({ ...fakeCompressResponse(), messages: 'bad' }))
    malformed.history.value = [{ role: 'user', text: 'untouched' }]
    await dispatchSlash('/compress', malformed.ctx)
    expect(malformed.history.value).toEqual([{ role: 'user', text: 'untouched' }])
    expect(malformed.compressionMutations).toEqual([])
    expect(malformed.system).toEqual(['/compress: invalid session.compress response'])
    expect(malformed.historyMutation.ends).toBe(1)

    const failed = makeCtx(async () => { throw new Error('compressor offline') })
    failed.history.value = [{ role: 'user', text: 'still intact' }]
    await dispatchSlash('/compress', failed.ctx)
    expect(failed.history.value[0]?.text).toBe('still intact')
    expect(failed.compressionMutations).toEqual([])
    expect(failed.system).toEqual(['/compress: compressor offline'])
    expect(failed.historyMutation.ends).toBe(1)

    const busy = makeCtx(async () => fakeCompressResponse())
    busy.busy.value = true
    await dispatchSlash('/compress', busy.ctx)
    expect(busy.calls).toEqual([])
    expect(busy.system).toEqual(['session busy — /interrupt the current turn before /compress'])

    let resolve!: (value: unknown) => void
    const stale = makeCtx(async () => new Promise(done => (resolve = done)))
    stale.history.value = [{ role: 'user', text: 'old visible' }]
    const run = dispatchSlash('/compress', stale.ctx)
    stale.session.value = 'sid-2'
    resolve(fakeCompressResponse())
    await run
    expect(stale.compressionMutations).toEqual([])
    expect(stale.history.value[0]?.text).toBe('old visible')
    expect(stale.historyMutation.ends).toBe(1)
  })

  test('/undo rewinds gateway + visible exchange and guards no-session/busy/malformed cases', async () => {
    const p = makeCtx(async method => (method === 'session.undo' ? { removed: 2 } : {}))
    await dispatchSlash('/undo', p.ctx)
    expect(p.calls).toEqual([{ method: 'session.undo', params: { session_id: 'sid-1' } }])
    expect(p.trimCalls.value).toBe(1)
    expect(p.system).toEqual(['undid 2 messages'])

    const none = makeCtx(async () => ({}))
    none.session.value = undefined
    await dispatchSlash('/undo', none.ctx)
    expect(none.system).toEqual(['nothing to undo'])
    expect(none.calls).toEqual([])

    const busy = makeCtx(async () => ({}))
    busy.busy.value = true
    await dispatchSlash('/undo', busy.ctx)
    expect(busy.system).toEqual(['session busy — /interrupt the current turn before /undo'])
    expect(busy.calls).toEqual([])

    const malformed = makeCtx(async () => ({ removed: -1 }))
    await dispatchSlash('/undo', malformed.ctx)
    expect(malformed.system).toEqual(['/undo: invalid session.undo response'])
    expect(malformed.trimCalls.value).toBe(0)
  })

  test('/retry captures the last user body, rewinds once, and resubmits once', async () => {
    const p = makeCtx(async method => (method === 'session.undo' ? { removed: 2 } : {}))
    p.history.value = [
      { role: 'user', text: 'try this' },
      { role: 'assistant', text: 'failed response' }
    ]
    await dispatchSlash('/retry', p.ctx)
    expect(p.calls).toEqual([{ method: 'session.undo', params: { session_id: 'sid-1' } }])
    expect(p.trimCalls.value).toBe(1)
    expect(p.submitted).toEqual(['try this'])

    const empty = makeCtx(async () => ({}))
    await dispatchSlash('/retry', empty.ctx)
    expect(empty.system).toEqual(['nothing to retry'])

    const busy = makeCtx(async () => ({}))
    busy.history.value = [{ role: 'user', text: 'blocked' }]
    busy.busy.value = true
    await dispatchSlash('/retry', busy.ctx)
    expect(busy.system).toEqual(['session busy — /interrupt the current turn before /retry'])
    expect(busy.calls).toEqual([])
  })

  test('/queue, /steer, /undo, and /retry reject cleanly during a session transition', async () => {
    const p = makeCtx(async () => ({}))
    p.transitioning.value = true
    p.history.value = [{ role: 'user', text: 'last prompt' }]
    await dispatchSlash('/queue later', p.ctx)
    await dispatchSlash('/steer correction', p.ctx)
    await dispatchSlash('/undo', p.ctx)
    await dispatchSlash('/retry', p.ctx)
    expect(p.calls).toEqual([])
    expect(p.queued).toEqual([])
    expect(p.trimCalls.value).toBe(0)
    expect(p.submitted).toEqual([])
    expect(p.prefills).toEqual(['/queue later', '/steer correction'])
    expect(p.system).toEqual([
      'session switch in progress — retry the queue command when it finishes',
      'session switch in progress — retry /steer when it finishes',
      'session switch in progress — retry /undo when it finishes',
      'session switch in progress — retry /retry when it finishes'
    ])
  })

  test('history mutation lock serializes rapid retries without global-flight suppression', async () => {
    let resolveUndo!: (value: unknown) => void
    const pendingUndo = new Promise<unknown>(resolve => (resolveUndo = resolve))
    const p = makeCtx(async method => (method === 'session.undo' ? pendingUndo : { output: 'ok' }))
    p.history.value = [
      { role: 'user', text: 'retry exactly once' },
      { role: 'assistant', text: 'old answer' }
    ]

    const first = dispatchSlash('/retry', p.ctx)
    await Promise.resolve()
    const second = dispatchSlash('/retry', p.ctx)
    await second
    expect(p.calls.filter(call => call.method === 'session.undo')).toHaveLength(1)
    expect(p.system).toContain('history update already in progress — wait before /retry')

    resolveUndo({ removed: 2 })
    await first
    expect(p.trimCalls.value).toBe(1)
    expect(p.submitted).toEqual(['retry exactly once'])
    expect(p.historyMutation).toEqual({ begins: 1, ends: 1, value: false })
  })

  test('a later read-only slash command cannot suppress undo reconciliation', async () => {
    let resolveUndo!: (value: unknown) => void
    const pendingUndo = new Promise<unknown>(resolve => (resolveUndo = resolve))
    const p = makeCtx(async method =>
      method === 'session.undo' ? pendingUndo : method === 'session.status' ? { output: 'ready' } : {}
    )
    const undo = dispatchSlash('/undo', p.ctx)
    await Promise.resolve()
    await dispatchSlash('/status', p.ctx)
    resolveUndo({ removed: 2 })
    await undo
    expect(p.trimCalls.value).toBe(1)
    expect(p.system).toContain('undid 2 messages')
  })

  test('retry restores the body to the composer when resubmit is rejected', async () => {
    const p = makeCtx(async method => (method === 'session.undo' ? { removed: 2 } : {}))
    p.history.value = [
      { role: 'user', text: 'do not lose this' },
      { role: 'assistant', text: 'old answer' }
    ]
    p.submitAccept.value = false
    await dispatchSlash('/retry', p.ctx)
    expect(p.prefills).toEqual(['do not lose this'])
    expect(p.system).toContain('retry could not submit — message restored to composer')
    expect(p.historyMutation.value).toBe(false)
  })

  test('a command.dispatch prefill writes the native composer draft instead of printing its body', async () => {
    const p = makeCtx(async method =>
      method === 'slash.exec' ? { message: 'editable prompt', notice: 'edit and resubmit', type: 'prefill' } : {}
    )
    await dispatchSlash('/extension-undo', p.ctx)
    expect(p.prefills).toEqual(['editable prompt'])
    expect(p.system).toEqual(['edit and resubmit'])
  })

  test('/logs opens the pager with the recent ring lines', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/logs', p.ctx)
    expect(p.paged[0]?.title).toBe('Logs')
    expect(p.paged[0]?.text).toContain('session created')
  })

  test('/sessions (and bare /resume) open the unified sessions orchestrator', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/sessions', p.ctx)
    expect(p.sessionPickers).toEqual(['recent'])
    expect(p.calls).toHaveLength(0) // the overlay fetches its own rows
    const p2 = makeCtx(async () => ({}))
    await dispatchSlash('/resume', p2.ctx)
    expect(p2.sessionPickers).toEqual(['recent'])
  })

  test('/sessions new keeps the current sibling; other args direct-resume', async () => {
    const rows = {
      sessions: [{ id: 'abc-123', message_count: 5, preview: 'hello', started_at: 1, title: 'First chat' }]
    }
    const p = makeCtx(async method => (method === 'session.list' ? rows : {}))
    await dispatchSlash('/sessions new', p.ctx)
    expect(p.newLiveSessions).toEqual([['new live session started', undefined]])
    expect(p.newSessions).toEqual([])
    await dispatchSlash('/sessions first chat', p.ctx)
    expect(p.resumed).toEqual(['abc-123'])
  })

  test('/skin <name> persists via config.set (the gateway then emits skin.changed)', async () => {
    const p = makeCtx(async method => (method === 'config.set' ? { key: 'skin', value: 'ares' } : {}))
    await dispatchSlash('/skin ares', p.ctx)
    const set = p.calls.find(c => c.method === 'config.set')
    expect(set).toBeDefined()
    expect(set?.params).toMatchObject({ key: 'skin', value: 'ares' })
    expect(p.system.at(-1)).toContain('ares')
  })

  test('/skin bare reports the persisted skin via config.get', async () => {
    const p = makeCtx(async method => (method === 'config.get' ? { value: 'poseidon' } : {}))
    await dispatchSlash('/skin', p.ctx)
    const get = p.calls.find(c => c.method === 'config.get')
    expect(get?.params).toMatchObject({ key: 'skin' })
    expect(p.system.at(-1)).toContain('poseidon')
  })

  test('/resume <id|name> keeps the DIRECT path: resolves against session.list and resumes', async () => {
    const rows = {
      sessions: [
        { id: 'abc-123', message_count: 5, preview: 'hello', source: 'tui', started_at: 1, title: 'First chat' },
        { id: 'def-456', message_count: 2, preview: 'yo', source: 'cli', started_at: 2, title: 'Goal v4' }
      ],
      truncated: false
    }
    const p = makeCtx(async method => (method === 'session.list' ? rows : {}))
    await dispatchSlash('/resume abc-123', p.ctx) // exact id
    await dispatchSlash('/resume def', p.ctx) // unique id prefix
    await dispatchSlash('/resume goal v4', p.ctx) // exact title (ci)
    expect(p.resumed).toEqual(['abc-123', 'def-456', 'def-456'])
    expect(p.sessionPickers).toHaveLength(0) // never opened the overlay
    await dispatchSlash('/resume nope', p.ctx)
    expect(p.resumed).toHaveLength(3)
    expect(p.system.at(-1)).toContain('no session matching')
  })

  test('/model (bare) opens a GROUPED picker of authenticated providers’ models; pick switches', async () => {
    const p = makeCtx(async method => {
      if (method === 'model.options') return MODEL_OPTIONS
      return { output: 'switched' }
    })
    await dispatchSlash('/model', p.ctx)
    expect(p.pickers).toHaveLength(1)
    expect(p.pickers[0]!.title).toBe('Switch model')
    // authenticated providers' models are the SELECTABLE rows; values carry the
    // explicit provider so a pick under a different provider switches both.
    const selectable = p.pickers[0]!.items.filter(i => !i.unavailable)
    expect(selectable.map(i => i.value)).toEqual([
      'claude-sonnet-4.6 --provider anthropic',
      'claude-opus-4.6 --provider anthropic',
      'hermes-4-405b --provider nous'
    ])
    // grouped by the provider's display (lab) name; slug+lab are fuzzy haystacks
    expect(selectable.map(i => i.group)).toEqual(['Anthropic', 'Anthropic', 'Nous Research'])
    expect(selectable[2]!.haystacks).toEqual(['nous', 'Nous Research'])
    // current is FLAGGED (not baked into the label, so fuzzy never matches the ✓)
    expect(selectable[0]!.current).toBe(true)
    expect(selectable[0]!.label).toBe('claude-sonnet-4.6')
    expect(selectable[1]!.current).toBeUndefined()
    // picking switches via slash.exec `model <model> --provider <slug>`
    p.pickers[0]!.onPick('claude-opus-4.6 --provider anthropic')
    await new Promise(r => setTimeout(r, 0))
    expect(
      p.calls.some(c => c.method === 'slash.exec' && c.params.command === 'model claude-opus-4.6 --provider anthropic')
    ).toBe(true)
  })

  test('/model maps UNCONFIGURED providers to dimmed hint rows (key_env → env-var hint, else warning)', async () => {
    const p = makeCtx(async method => (method === 'model.options' ? MODEL_OPTIONS : { output: 'switched' }))
    await dispatchSlash('/model', p.ctx)
    const unavailable = p.pickers[0]!.items.filter(i => i.unavailable)
    expect(unavailable).toHaveLength(2)
    // api_key provider → the `no API key — set <ENV_VAR>` hint as the row label
    expect(unavailable[0]).toEqual({
      group: 'OpenAI API',
      haystacks: ['openai-api', 'OpenAI API'],
      label: 'no API key — set OPENAI_API_KEY',
      unavailable: true,
      value: 'openai-api'
    })
    // oauth provider (no key_env) → the gateway's own warning text
    expect(unavailable[1]!.group).toBe('OpenAI Codex')
    expect(unavailable[1]!.label).toBe('run `hermes model` to configure (oauth_external)')
    // payload (canonical) order is preserved — unconfigured rows interleave
    expect(p.pickers[0]!.items.map(i => i.group)).toEqual([
      'Anthropic',
      'Anthropic',
      'OpenAI API',
      'Nous Research',
      'OpenAI Codex'
    ])
  })

  test('/model with ONLY unconfigured providers keeps the no-models notice', async () => {
    const p = makeCtx(async () => ({
      providers: [{ authenticated: false, key_env: 'XAI_API_KEY', models: [], name: 'xAI', slug: 'xai' }]
    }))
    await dispatchSlash('/model', p.ctx)
    expect(p.pickers).toHaveLength(0)
    expect(p.system).toEqual(['No models available (no authenticated providers).'])
  })

  test('/model registers the picker refresh seam; running it does ONE RPC and re-syncs the cache', async () => {
    const p = makeCtx(async method => (method === 'model.options' ? MODEL_OPTIONS : { output: 'switched' }))
    await dispatchSlash('/model', p.ctx)
    const opened = p.calls.filter(c => c.method === 'model.options').length // 1 (uncached open)
    const refreshed = await runPickerRefresh()
    expect(p.calls.filter(c => c.method === 'model.options')).toHaveLength(opened + 1)
    expect(refreshed!.filter(i => !i.unavailable)).toHaveLength(3)
    expect(p.modelCache.value).toEqual(refreshed) // cache re-synced for the next open
  })

  test('/skills clears the picker refresh seam (Ctrl+R is a no-op there)', async () => {
    registerPickerRefresh(() => Promise.resolve([]))
    const p = makeCtx(async () => ({ skills: { General: ['memory'] } }))
    await dispatchSlash('/skills', p.ctx)
    expect(runPickerRefresh()).toBeUndefined()
  })

  test('/model with a CACHED catalog opens instantly — ZERO RPCs on open', async () => {
    const p = makeCtx(async () => {
      throw new Error('no RPC expected on open')
    })
    p.modelCache.value = [
      {
        group: 'Anthropic',
        haystacks: ['anthropic', 'Anthropic'],
        label: 'claude-sonnet-4.6',
        value: 'claude-sonnet-4.6 --provider anthropic'
      },
      {
        group: 'Nous Research',
        haystacks: ['nous', 'Nous Research'],
        label: 'hermes-4-405b',
        value: 'hermes-4-405b --provider nous'
      }
    ]
    await dispatchSlash('/model', p.ctx)
    expect(p.pickers).toHaveLength(1)
    expect(p.pickers[0]!.items).toHaveLength(2)
    expect(p.calls).toHaveLength(0) // the whole point: open = memory, not network
  })

  test('/model uncached fetches ONCE, caches, and a pick refreshes the cache', async () => {
    const p = makeCtx(async method => (method === 'model.options' ? MODEL_OPTIONS : { output: 'switched' }))
    await dispatchSlash('/model', p.ctx)
    expect(p.calls.filter(c => c.method === 'model.options')).toHaveLength(1)
    expect(p.modelCache.value).toHaveLength(5) // first open seeded the cache (3 models + 2 unconfigured hints)
    // cross-provider pick: switch lands on the gateway, then a background
    // refresh re-fetches model.options so the cached ✓ stays fresh.
    p.pickers[0]!.onPick('hermes-4-405b --provider nous')
    await new Promise(r => setTimeout(r, 0))
    expect(
      p.calls.some(c => c.method === 'slash.exec' && c.params.command === 'model hermes-4-405b --provider nous')
    ).toBe(true)
    expect(p.calls.filter(c => c.method === 'model.options')).toHaveLength(2)
  })

  test('buildModelTabs: Nous-identified groups first, then catalog order; unconfigured providers get NO tab', () => {
    const items: PickerItem[] = [
      { group: 'Anthropic', haystacks: ['anthropic', 'Anthropic'], label: 'claude-sonnet-4.6', value: 'a' },
      { group: 'Anthropic', haystacks: ['anthropic', 'Anthropic'], label: 'claude-opus-4.6', value: 'b' },
      {
        group: 'OpenAI API',
        haystacks: ['openai-api', 'OpenAI API'],
        label: 'no API key',
        unavailable: true,
        value: 'openai-api'
      },
      { group: 'GitHub Copilot', haystacks: ['copilot', 'GitHub Copilot'], label: 'gpt-5', value: 'c' },
      // Nous identified via the SLUG haystack even when the display name hides it
      { group: 'Portal', haystacks: ['nous-portal', 'Portal'], label: 'hermes-4-405b', value: 'd' }
    ]
    expect(buildModelTabs(items)).toEqual(['Portal', 'Anthropic', 'GitHub Copilot'])
    expect(buildModelTabs([])).toEqual([])
  })

  test('/model registers the provider-tab seam (buildModelTabs); /skills clears it back to stripless', async () => {
    const p = makeCtx(async method => (method === 'model.options' ? MODEL_OPTIONS : { output: 'switched' }))
    await dispatchSlash('/model', p.ctx)
    // the open picker derives Nous-first tabs through the seam
    expect(pickerTabs(p.pickers[0]!.items)).toEqual(['Nous Research', 'Anthropic'])
    const p2 = makeCtx(async () => ({ skills: { General: ['memory'] } }))
    await dispatchSlash('/skills', p2.ctx)
    expect(pickerTabs(p.pickers[0]!.items)).toEqual([])
  })

  test('bootstrap model prefetch is non-blocking and early /model performs ZERO additional RPCs', async () => {
    const p = makeCtx(async () => {
      throw new Error('no RPC expected — the prefetch owns model.options')
    })
    // a slow prefetch (entry/main.tsx shape): resolving it fills the cache
    let finish: (items: PickerItem[]) => void = () => {}
    const started = startModelPrefetch(
      p.session.value!,
      new Promise<PickerItem[]>(resolve => {
        finish = resolve
      }),
      items => {
        p.modelCache.value = items
      },
      5000
    )
    expect(started).toBeUndefined() // session setup never receives a promise to await
    const dispatched = dispatchSlash('/model', p.ctx)
    finish([{ group: 'Anthropic', haystacks: ['anthropic'], label: 'claude-sonnet-4.6', value: 'a' }])
    await dispatched
    expect(p.pickers).toHaveLength(1) // opened from the prefetched cache
    expect(p.pickers[0]!.items).toHaveLength(1)
    expect(p.calls).toHaveLength(0) // the dedupe: no second model.options
  })

  test('/model with a HUNG prefetch still opens via its own fetch after the bound', async () => {
    const p = makeCtx(async method => (method === 'model.options' ? MODEL_OPTIONS : { output: 'switched' }))
    registerModelPrefetch(p.session.value!, new Promise(() => {}), 10) // never settles; tiny test bound
    await dispatchSlash('/model', p.ctx)
    expect(p.pickers).toHaveLength(1) // fell back to fetching itself
    expect(p.calls.filter(c => c.method === 'model.options')).toHaveLength(1)
  })

  test('/model after a REJECTED background prefetch falls back to one fetch', async () => {
    const p = makeCtx(async method => (method === 'model.options' ? MODEL_OPTIONS : { output: 'switched' }))
    startModelPrefetch(p.session.value!, Promise.reject(new Error('background hydration failed')), () => {})
    await dispatchSlash('/model', p.ctx)
    expect(p.pickers).toHaveLength(1)
    expect(p.calls.filter(c => c.method === 'model.options')).toHaveLength(1)
  })

  test('/model never waits on the predecessor session prefetch', async () => {
    const p = makeCtx(async method => (method === 'model.options' ? MODEL_OPTIONS : { output: 'switched' }))
    startModelPrefetch('sid-old', new Promise(() => {}), () => {}, 5000)
    p.session.value = 'sid-new'

    await dispatchSlash('/model', p.ctx)

    expect(p.pickers).toHaveLength(1)
    expect(p.calls.filter(c => c.method === 'model.options')).toHaveLength(1)
  })

  test('client slash RPC failures resolve with a user-visible error', async () => {
    const p = makeCtx(async () => {
      throw new Error('gateway unavailable')
    })

    await expect(dispatchSlash('/skills', p.ctx)).resolves.toBeUndefined()
    expect(p.system).toEqual(['/skills: gateway unavailable'])
  })

  test('/model <name> switches directly without opening the picker', async () => {
    const p = makeCtx(async () => ({ output: 'ok' }))
    await dispatchSlash('/model anthropic/claude-opus-4.6', p.ctx)
    expect(p.pickers).toHaveLength(0)
    expect(p.calls[0]).toEqual({
      method: 'slash.exec',
      params: { command: 'model anthropic/claude-opus-4.6', session_id: 'sid-1' }
    })
  })

  test('/copy copies via copyResponse; no system line on success', async () => {
    const p = makeCtx(async () => ({}))
    p.copyN.value = () => true
    await dispatchSlash('/copy', p.ctx)
    expect(p.copied).toEqual([1])
    expect(p.system).toHaveLength(0)
  })

  test('/copy 2 passes the n-th index through', async () => {
    const p = makeCtx(async () => ({}))
    p.copyN.value = () => true
    await dispatchSlash('/copy 2', p.ctx)
    expect(p.copied).toEqual([2])
  })

  test('/copy when nothing to copy pushes a system notice', async () => {
    const p = makeCtx(async () => ({}))
    p.copyN.value = () => false
    await dispatchSlash('/copy', p.ctx)
    expect(p.system).toContain('Nothing to copy yet.')
  })

  test('/agents (and /tasks) open the agents dashboard', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/agents', p.ctx)
    expect(p.dashboard.value).toBe(true)
    const p2 = makeCtx(async () => ({}))
    await dispatchSlash('/tasks', p2.ctx)
    expect(p2.dashboard.value).toBe(true)
  })

  test('/skills opens a picker flattened from skills.manage list', async () => {
    const p = makeCtx(async method =>
      method === 'skills.manage' ? { skills: { media: ['ffmpeg', 'whisper'], web: ['firecrawl'] } } : {}
    )
    await dispatchSlash('/skills', p.ctx)
    expect(p.pickers).toHaveLength(1)
    expect(p.pickers[0]!.title).toBe('Skills')
    expect(p.pickers[0]!.items.map(i => i.value).sort()).toEqual(['ffmpeg', 'firecrawl', 'whisper'])
  })

  test('/help renders the cached categorized catalog, skill count, TUI rows, and hotkeys', async () => {
    const p = makeCtx(async () => {
      throw new Error('cached help must not refetch')
    })
    p.cachedCatalog.value = {
      canon: { '/m': '/model' },
      categories: [{ name: 'Session', pairs: [['/model', 'switch model']] }],
      pairs: [['/model', 'switch model']],
      skill_count: 3,
      warning: 'skill discovery unavailable: fixture failure'
    }
    await dispatchSlash('/help', p.ctx)
    expect(p.calls).toHaveLength(0)
    expect(p.paged).toHaveLength(1)
    expect(p.paged[0]?.title).toBe('(^_^)? Commands')
    expect(p.paged[0]?.text).toContain('Session\n  /model  switch model')
    expect(p.paged[0]?.text).toContain('3 skill commands available — /skills to browse')
    expect(p.paged[0]?.text).toContain('Warning\n  skill discovery unavailable: fixture failure')
    expect(p.paged[0]?.text).toContain('/fortune [random|daily]')
    expect(p.paged[0]?.text.match(/\/fortune/g)).toHaveLength(1)
    expect(p.paged[0]?.text).toContain('Hotkeys')
    expect(p.paged[0]?.text).toContain('Ctrl+L')
  })

  test('/help hydrates once when the cache is absent and falls back locally on malformed/error', async () => {
    const p = makeCtx(async method =>
      method === 'commands.catalog'
        ? {
            categories: [{ name: 'Info', pairs: [['/status', 'show status']] }],
            pairs: [['/status', 'show status']]
          }
        : {}
    )
    await dispatchSlash('/HELP', p.ctx)
    expect(p.calls.map(call => call.method)).toEqual(['commands.catalog'])
    expect(p.commandCatalogs).toHaveLength(1)
    expect(p.paged[0]?.text).toContain('Info\n  /status  show status')

    for (const request of [
      async () => ({ pairs: [['/bad', 1]] }),
      async () => {
        throw new Error('offline')
      }
    ]) {
      const fallback = makeCtx(request)
      await dispatchSlash('/help', fallback.ctx)
      expect(fallback.paged[0]?.text).toContain('TUI')
      expect(fallback.paged[0]?.text).toContain('Hotkeys')
    }
  })

  test('/help drops a late catalog after a newer same-session slash command', async () => {
    let resolveCatalog!: (value: unknown) => void
    const pending = new Promise<unknown>(resolve => (resolveCatalog = resolve))
    const p = makeCtx(async method => (method === 'commands.catalog' ? pending : {}))
    const help = dispatchSlash('/help', p.ctx)
    await dispatchSlash('/fortune invalid', p.ctx)
    resolveCatalog({ categories: [], pairs: [['/late', 'stale']] })
    await help
    expect(p.paged).toEqual([])
    expect(p.commandCatalogs).toEqual([])
    expect(p.system).toEqual(['usage: /fortune [random|daily]'])
  })

  test('/history renders the live committed user/assistant transcript with Ink labels and tool fallback', async () => {
    const p = makeCtx(async () => {
      throw new Error('local history must not RPC')
    })
    p.history.value = [
      { role: 'system', text: 'hidden system row' },
      { role: 'user', text: 'question' },
      {
        role: 'assistant',
        text: '',
        parts: [{ id: 'answer-1', text: 'answer from ordered parts', type: 'text' }]
      },
      {
        role: 'assistant',
        text: '',
        parts: [{ id: 'tool-1', name: 'terminal', state: 'complete', type: 'tool' }]
      },
      { role: 'assistant', text: 'still streaming', streaming: true },
      { role: 'notification', text: 'hidden notification' }
    ]
    await dispatchSlash('/history', p.ctx)
    expect(p.calls).toHaveLength(0)
    expect(p.paged).toEqual([
      {
        title: 'History',
        text: '[You #1]\nquestion\n\n[Hermes #2]\nanswer from ordered parts\n\n[Hermes #3]\n(1 tool calls)'
      }
    ])
  })

  test('/history applies the 400 default / 80 minimum preview and handles empty state', async () => {
    const long = 'x'.repeat(500)
    const defaults = makeCtx(async () => ({}))
    defaults.history.value = [{ role: 'assistant', text: long }]
    await dispatchSlash('/history', defaults.ctx)
    expect(defaults.paged[0]?.text).toBe(`[Hermes #1]\n${'x'.repeat(400)}…`)

    const minimum = makeCtx(async () => ({}))
    minimum.history.value = [{ role: 'assistant', text: long }]
    await dispatchSlash('/history 1', minimum.ctx)
    expect(minimum.paged[0]?.text).toBe(`[Hermes #1]\n${'x'.repeat(80)}…`)

    const empty = makeCtx(async () => ({}))
    empty.history.value = [{ role: 'system', text: 'only system' }]
    await dispatchSlash('/history', empty.ctx)
    expect(empty.system).toEqual(['no conversation yet'])
    expect(empty.paged).toHaveLength(0)
  })

  test("/history applies Ink's 800-row cap and explicitly reports omitted older messages", () => {
    const messages: Message[] = Array.from({ length: HISTORY_MAX_MESSAGES + 5 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `message-${index}`
    }))
    const text = formatHistory(messages, '')
    expect(text).toContain(
      `[history truncated: showing latest ${HISTORY_MAX_MESSAGES} of ${HISTORY_MAX_MESSAGES + 5} messages]`
    )
    expect(text).not.toContain('message-0\n')
    expect(text).toContain(`message-${HISTORY_MAX_MESSAGES + 4}`)
  })

  test('/history bounds ordered-part extraction before joining and explains a clamped preview', () => {
    const text = formatHistory(
      [
        {
          role: 'assistant',
          text: '',
          parts: [
            { id: 'lead', text: `  ${'a'.repeat(HISTORY_MAX_PREVIEW)}`, type: 'text' },
            { id: 'reasoning', text: 'private'.repeat(100_000), type: 'reasoning' },
            { id: 'tail', text: 'b'.repeat(1_000_000), type: 'text' }
          ]
        }
      ],
      '999999999'
    )
    expect(text).toContain(`[preview limited to ${HISTORY_MAX_PREVIEW} characters per message]`)
    expect(text).toContain(`${'a'.repeat(HISTORY_MAX_PREVIEW)}…`)
    expect(text).not.toContain('bbbb')
    expect(text?.length).toBeLessThan(HISTORY_MAX_PREVIEW + 200)

    // Whitespace-only overflow is trimmed, not presented as lost content.
    expect(formatHistory([{ role: 'assistant', text: `ok${' '.repeat(10_000)}` }], '80')).toBe('[Hermes #1]\nok')
    // Never hand OpenTUI a lone surrogate when the preview boundary bisects an emoji.
    expect(formatHistory([{ role: 'assistant', text: `${'a'.repeat(79)}🔮tail` }], '80')).toBe(
      `[Hermes #1]\n${'a'.repeat(79)}…`
    )
  })

  test('/history keeps the native pager buffer under 512 Ki chars and gives newest rows priority', () => {
    const messages: Message[] = Array.from({ length: HISTORY_MAX_MESSAGES }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `message-${index}:${'x'.repeat(HISTORY_MAX_PREVIEW)}`
    }))
    const text = formatHistory(messages, String(HISTORY_MAX_PREVIEW))
    expect(text?.length).toBeLessThanOrEqual(HISTORY_MAX_PAGER_CHARS)
    expect(text).toContain(`[pager limit: showing latest `)
    expect(text).toContain(
      `of ${HISTORY_MAX_MESSAGES} retained messages (${HISTORY_MAX_PAGER_CHARS} characters maximum)]`
    )
    expect(text).not.toContain('message-0:')
    expect(text).toContain(`message-${HISTORY_MAX_MESSAGES - 1}:`)
  })

  test('/logs honors the default/count clamp and empty gateway-log copy', async () => {
    const defaultCount = makeCtx(async () => ({}))
    defaultCount.logLines.value = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`)
    await dispatchSlash('/logs', defaultCount.ctx)
    expect(defaultCount.logLimits).toEqual([20])
    expect(defaultCount.paged[0]?.text.split('\n')).toHaveLength(20)
    expect(defaultCount.paged[0]?.text).toContain('line-30')

    const capped = makeCtx(async () => ({}))
    capped.logLines.value = Array.from({ length: 100 }, (_, index) => `line-${index + 1}`)
    await dispatchSlash('/logs 999', capped.ctx)
    expect(capped.logLimits).toEqual([80])
    expect(capped.paged[0]?.text.split('\n')).toHaveLength(80)

    const negative = makeCtx(async () => ({}))
    await dispatchSlash('/logs -9', negative.ctx)
    expect(negative.logLimits).toEqual([1])

    const zero = makeCtx(async () => ({}))
    await dispatchSlash('/logs 0', zero.ctx)
    expect(zero.logLimits).toEqual([20])

    const empty = makeCtx(async () => ({}))
    empty.logLines.value = []
    await dispatchSlash('/logs', empty.ctx)
    expect(empty.system).toEqual(['no gateway logs'])
    expect(empty.paged).toHaveLength(0)
  })

  test('/fortune is entirely local and accepts Ink daily synonyms', async () => {
    for (const command of ['/fortune', '/fortune random', '/fortune daily', '/fortune stable', '/fortune today']) {
      const p = makeCtx(async () => {
        throw new Error('fortune must not RPC')
      })
      await dispatchSlash(command, p.ctx)
      expect(p.system[0]).toMatch(/^(?:🔮|🌟) /u)
      expect(p.calls).toHaveLength(0)
    }

    const invalid = makeCtx(async () => ({}))
    await dispatchSlash('/fortune tomorrow', invalid.ctx)
    expect(invalid.system).toEqual(['usage: /fortune [random|daily]'])
  })

  test('/billing fetches billing.state and opens the overlay on overview', async () => {
    const state = fakeBillingState({ logged_in: true })
    const p = makeCtx(async method => (method === 'billing.state' ? state : {}))
    await dispatchSlash('/billing', p.ctx)
    expect(p.calls[0]?.method).toBe('billing.state')
    expect(p.billed).toHaveLength(1)
    expect(p.billed[0]!.screen).toBe('overview')
    expect(p.billed[0]!.pendingCharge).toBeNull()
    expect(p.billed[0]!.state.balance_display).toBe('$42.00')
    // the ctx bundle is wired (RPC + validation reachable from the overlay)
    expect(typeof p.billed[0]!.ctx.charge).toBe('function')
    expect(p.billed[0]!.ctx.validate('10').amount).toBe('10')
  })

  test('/billing on a logged-out portal explains how to log in (no overlay)', async () => {
    const p = makeCtx(async method => (method === 'billing.state' ? fakeBillingState({ logged_in: false }) : {}))
    await dispatchSlash('/billing', p.ctx)
    expect(p.billed).toHaveLength(0)
    expect(p.system.join('\n')).toContain('Not logged into Nous Portal')
  })

  test('/billing surfaces a request failure instead of throwing', async () => {
    const p = makeCtx(async () => {
      throw new Error('gateway down')
    })
    await dispatchSlash('/billing', p.ctx)
    expect(p.billed).toHaveLength(0)
    expect(p.system.join('\n')).toContain('/billing: gateway down')
  })

  test('/tools enable uses the live configure RPC, resets same-SID state, and reports every result class', async () => {
    const info = { model: 'claude-sonnet', running: false }
    const p = makeCtx(async method =>
      method === 'tools.configure'
        ? {
            changed: ['web', 'github:create_issue'],
            enabled_toolsets: ['terminal', 'web'],
            info,
            missing_servers: ['missing'],
            reset: true,
            unknown: ['bogus']
          }
        : {}
    )
    await dispatchSlash('/tools enable web github:create_issue bogus missing:tool', p.ctx)
    expect(p.calls).toEqual([
      {
        method: 'tools.configure',
        params: {
          action: 'enable',
          names: ['web', 'github:create_issue', 'bogus', 'missing:tool'],
          session_id: 'sid-1'
        }
      }
    ])
    expect(p.toolsResets).toEqual([info])
    expect(p.toolsConfiguring).toEqual({ begins: 1, ends: 1, value: false })
    expect(p.system).toEqual([
      'enabled: web, github:create_issue',
      'unknown toolsets: bogus',
      'missing MCP servers: missing',
      'session reset. new tool configuration is active.'
    ])
  })

  test('/tools disable without names prints usage and never calls the gateway', async () => {
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/tools disable', p.ctx)
    expect(p.calls).toHaveLength(0)
    expect(p.system).toEqual([
      'usage: /tools disable <name> [name ...]',
      'built-in toolset: /tools disable web',
      'MCP tool: /tools disable github:create_issue'
    ])
  })

  test('/tools refuses to reset the agent while a turn or session transition is active', async () => {
    const p = makeCtx(async () => ({ changed: ['web'], reset: true }))
    p.busy.value = true
    await dispatchSlash('/tools disable web', p.ctx)
    expect(p.calls).toHaveLength(0)
    expect(p.toolsResets).toEqual([])
    expect(p.toolsConfiguring).toEqual({ begins: 0, ends: 0, value: false })
  })

  test('/tools drops an old-session configure response before reset or feedback', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise<unknown>(done => (resolve = done))
    const p = makeCtx(async () => pending)
    const run = dispatchSlash('/tools disable web', p.ctx)
    p.session.value = 'sid-2'
    resolve({ changed: ['web'], info: { model: 'other' }, reset: true })
    await run
    expect(p.toolsResets).toEqual([])
    expect(p.system).toEqual([])
    expect(p.toolsConfiguring).toEqual({ begins: 1, ends: 1, value: false })
  })

  test('/tools rejects a malformed configure response instead of casting it into state', async () => {
    const p = makeCtx(async () => ({ changed: 'web', info: [] }))
    await dispatchSlash('/tools enable web', p.ctx)
    expect(p.toolsResets).toEqual([])
    expect(p.system).toEqual(['/tools: invalid tools.configure response'])
  })

  test('/tools accepts the gateway detached-session info:null response and keeps feedback', async () => {
    const p = makeCtx(async () => ({ changed: ['web'], info: null, reset: false, unknown: [] }))
    await dispatchSlash('/tools enable web', p.ctx)
    expect(p.toolsResets).toEqual([])
    expect(p.system).toEqual(['enabled: web'])
  })

  test('/tools list/status keeps the slash-worker output path and short-output presentation', async () => {
    const p = makeCtx(async method => (method === 'slash.exec' ? { output: 'web: enabled' } : {}))
    await dispatchSlash('/tools', p.ctx)
    expect(p.calls).toEqual([{ method: 'slash.exec', params: { command: 'tools', session_id: 'sid-1' } }])
    expect(p.system).toEqual(['web: enabled'])
    expect(p.paged).toEqual([])
  })

  test('registers the five live maintenance commands and the reload-skills alias', () => {
    const names = clientCommandNames()
    for (const name of ['status', 'title', 'save', 'reload', 'reload-skills', 'reload_skills']) {
      expect(names).toContain(name)
    }
  })

  test('registers local UX commands and keeps /q on queue rather than quit', () => {
    const names = clientCommandNames()
    for (const name of ['help', 'quit', 'exit', 'update', 'redraw', 'history', 'fortune', 'logs']) {
      expect(names).toContain(name)
    }
    expect(names).toContain('q')
  })

  test('/status reads the authoritative live session and always opens the status pager', async () => {
    const p = makeCtx(async method =>
      method === 'session.status' ? { output: 'Hermes TUI Status\n\nSession ID: sid-1' } : {}
    )
    await dispatchSlash('/status', p.ctx)
    expect(p.calls).toEqual([{ method: 'session.status', params: { session_id: 'sid-1' } }])
    expect(p.paged).toEqual([{ title: 'Status', text: 'Hermes TUI Status\n\nSession ID: sid-1' }])
    expect(p.system).toEqual([])
  })

  test('/status handles no session, malformed data, and a stale response without worker fallback', async () => {
    const noSession = makeCtx(async () => ({}))
    noSession.session.value = undefined
    await dispatchSlash('/status', noSession.ctx)
    expect(noSession.calls).toEqual([])
    expect(noSession.system).toEqual(['no active session'])

    const malformed = makeCtx(async () => ({ output: 42 }))
    await dispatchSlash('/status', malformed.ctx)
    expect(malformed.system).toEqual(['/status: invalid session.status response'])

    let resolve!: (value: unknown) => void
    const pending = new Promise<unknown>(done => (resolve = done))
    const stale = makeCtx(async () => pending)
    const run = dispatchSlash('/status', stale.ctx)
    stale.session.value = 'sid-2'
    resolve({ output: 'old session' })
    await run
    expect(stale.system).toEqual([])
    expect(stale.paged).toEqual([])
  })

  test('/status drops a late same-session reply after a newer slash command', async () => {
    let resolveStatus!: (value: unknown) => void
    const pendingStatus = new Promise<unknown>(done => (resolveStatus = done))
    const p = makeCtx(async (method, params) => {
      if (method === 'session.status') return pendingStatus
      if (method === 'session.title') return { title: params.title }
      return {}
    })

    const old = dispatchSlash('/status', p.ctx)
    await Promise.resolve()
    await dispatchSlash('/title Current title', p.ctx)
    resolveStatus({ output: 'stale status' })
    await old

    expect(p.session.value).toBe('sid-1')
    expect(p.paged).toEqual([])
    expect(p.system).toEqual(['session title set: Current title'])
  })

  test('/title queries and renames the live session, including queued-title feedback and chrome refresh', async () => {
    const p = makeCtx(async (method, params) => {
      if (method !== 'session.title') return {}
      return 'title' in params ? { pending: true, title: params.title } : { session_key: 'db-1', title: 'Old title' }
    })

    await dispatchSlash('/title', p.ctx)
    await dispatchSlash('/title   Release candidate   ', p.ctx)

    expect(p.calls).toEqual([
      { method: 'session.title', params: { session_id: 'sid-1' } },
      { method: 'session.title', params: { session_id: 'sid-1', title: 'Release candidate' } }
    ])
    expect(p.system).toEqual([
      'title: Old title',
      'session title set: Release candidate (queued while session initializes)'
    ])
    expect(p.sessionTitle.value).toBe('Release candidate')
  })

  test('/title reports empty/malformed/error cases without mutating successor chrome', async () => {
    const empty = makeCtx(async () => ({ title: '' }))
    await dispatchSlash('/title', empty.ctx)
    expect(empty.system).toEqual(['no title set'])

    const malformed = makeCtx(async () => ({ pending: false }))
    await dispatchSlash('/title New', malformed.ctx)
    expect(malformed.system).toEqual(['/title: invalid session.title response'])
    expect(malformed.sessionTitle.value).toBeUndefined()

    const failed = makeCtx(async () => {
      throw new Error('duplicate title')
    })
    await dispatchSlash('/title New', failed.ctx)
    expect(failed.system).toEqual(['/title: duplicate title'])

    let resolve!: (value: unknown) => void
    const pending = new Promise<unknown>(done => (resolve = done))
    const stale = makeCtx(async () => pending)
    const run = dispatchSlash('/title Old session title', stale.ctx)
    stale.session.value = 'sid-2'
    resolve({ pending: false, title: 'Old session title' })
    await run
    expect(stale.sessionTitle.value).toBeUndefined()
    expect(stale.system).toEqual([])
  })

  test('/save exports active gateway history and surfaces empty/no-session/error cases', async () => {
    const saved = makeCtx(async method =>
      method === 'session.save' ? { file: '/tmp/hermes_conversation_20260711.json' } : {}
    )
    await dispatchSlash('/save', saved.ctx)
    expect(saved.calls).toEqual([{ method: 'session.save', params: { session_id: 'sid-1' } }])
    expect(saved.system).toEqual(['conversation saved to: /tmp/hermes_conversation_20260711.json'])

    const empty = makeCtx(async () => ({}))
    empty.hasConversation.value = false
    await dispatchSlash('/save', empty.ctx)
    expect(empty.calls).toEqual([])
    expect(empty.system).toEqual(['no conversation yet'])

    const detached = makeCtx(async () => ({}))
    detached.session.value = undefined
    await dispatchSlash('/save', detached.ctx)
    expect(detached.calls).toEqual([])
    expect(detached.system).toEqual(['no active session — nothing to save'])

    const malformed = makeCtx(async () => ({ file: 42 }))
    await dispatchSlash('/save', malformed.ctx)
    expect(malformed.system).toEqual(['/save: invalid session.save response'])

    const failed = makeCtx(async () => {
      throw new Error('disk full')
    })
    await dispatchSlash('/save', failed.ctx)
    expect(failed.system).toEqual(['/save: disk full'])
  })

  test('/reload re-reads env in the running gateway with singular/plural copy and validation', async () => {
    const one = makeCtx(async method => (method === 'reload.env' ? { updated: 1 } : {}))
    await dispatchSlash('/reload', one.ctx)
    expect(one.calls).toEqual([{ method: 'reload.env', params: {} }])
    expect(one.system).toEqual(['reloaded .env (1 var updated)'])

    const many = makeCtx(async () => ({ updated: 3 }))
    await dispatchSlash('/reload', many.ctx)
    expect(many.system).toEqual(['reloaded .env (3 vars updated)'])

    for (const raw of [{ updated: -1 }, { updated: 1.5 }, { updated: '1' }]) {
      const malformed = makeCtx(async () => raw)
      await dispatchSlash('/reload', malformed.ctx)
      expect(malformed.system).toEqual(['/reload: invalid reload.env response'])
    }
  })

  test('/reload-skills reloads live skills, pages output, then replaces the decoded command catalog', async () => {
    const catalog = {
      canon: { '/new-skill': '/new-skill', '/q': '/queue' },
      pairs: [['/new-skill', 'New skill']]
    }
    const p = makeCtx(async method => {
      if (method === 'skills.reload')
        return {
          output:
            'Reloading skills...\nAdded skills:\n  - new-skill\nRemoved skills:\n  - old-skill\n1 skill(s) available',
          result: {
            added: [{ description: 'New skill', name: 'new-skill' }],
            removed: [{ description: 'Old skill', name: 'old-skill' }],
            total: 1
          }
        }
      if (method === 'commands.catalog') return catalog
      return {}
    })
    await dispatchSlash('/reload_skills', p.ctx)
    expect(p.calls).toEqual([
      { method: 'skills.reload', params: {} },
      { method: 'commands.catalog', params: {} }
    ])
    expect(p.paged).toEqual([
      {
        title: 'Reload Skills',
        text: 'Reloading skills...\nAdded skills:\n  - new-skill\nRemoved skills:\n  - old-skill\n1 skill(s) available'
      }
    ])
    expect(p.commandCatalogs).toEqual([
      { catalog: undefined, removedSkills: ['old-skill'] },
      { catalog, removedSkills: [] }
    ])
    expect(p.system).toEqual([])
  })

  test('/reload-skills fails closed on malformed responses and reports catalog refresh failure', async () => {
    const badReload = makeCtx(async () => ({ output: 42 }))
    await dispatchSlash('/reload-skills', badReload.ctx)
    expect(badReload.calls.map(call => call.method)).toEqual(['skills.reload'])
    expect(badReload.system).toEqual(['/reload-skills: invalid skills.reload response'])

    const badCatalog = makeCtx(async method =>
      method === 'skills.reload'
        ? {
            output: 'skills reloaded',
            result: { added: [], removed: [{ name: 'removed-skill' }], total: 0 }
          }
        : { pairs: [['/broken', 42]] }
    )
    await dispatchSlash('/reload-skills', badCatalog.ctx)
    expect(badCatalog.paged).toEqual([{ title: 'Reload Skills', text: 'skills reloaded' }])
    expect(badCatalog.commandCatalogs).toEqual([{ catalog: undefined, removedSkills: ['removed-skill'] }])
    expect(badCatalog.system).toEqual(['warning: skills reloaded, but the command catalog response was invalid'])
  })

  test('/reload-skills clears stale help on refresh failure, then /help retries the catalog', async () => {
    let catalogAttempt = 0
    const fresh = { categories: [{ name: 'Info', pairs: [['/fresh', 'Fresh']] }], pairs: [['/fresh', 'Fresh']] }
    const p = makeCtx(async method => {
      if (method === 'skills.reload') {
        return { output: 'skills reloaded', result: { added: [], removed: [{ name: 'old' }], total: 0 } }
      }
      if (method === 'commands.catalog') {
        catalogAttempt += 1
        if (catalogAttempt === 1) throw new Error('temporary discovery failure')
        return fresh
      }
      return {}
    })
    p.cachedCatalog.value = { categories: [], pairs: [['/old', 'Stale']] }

    await dispatchSlash('/reload-skills', p.ctx)
    expect(p.cachedCatalog.value).toBeUndefined()
    await dispatchSlash('/help', p.ctx)

    expect(catalogAttempt).toBe(2)
    expect(p.paged.at(-1)?.text).toContain('/fresh  Fresh')
    expect(p.paged.at(-1)?.text).not.toContain('/old')
  })

  test('/reload-skills surfaces a valid but incomplete catalog warning', async () => {
    const p = makeCtx(async method =>
      method === 'skills.reload'
        ? { output: 'skills reloaded', result: { added: [], removed: [], total: 0 } }
        : { pairs: [], warning: 'skill discovery unavailable: permission denied' }
    )

    await dispatchSlash('/reload-skills', p.ctx)

    expect(p.system).toEqual(['command catalog warning: skill discovery unavailable: permission denied'])
  })
})

describe('dispatchSlash — server ladder', () => {
  test('unknown command → slash.exec; SHORT output shown as a system line', async () => {
    const p = makeCtx(async method => (method === 'slash.exec' ? { output: 'all good' } : {}))
    await dispatchSlash('/health', p.ctx)
    expect(p.calls[0]).toEqual({ method: 'slash.exec', params: { command: 'health', session_id: 'sid-1' } })
    expect(p.system).toContain('all good')
    expect(p.paged).toHaveLength(0)
  })

  test('LONG slash.exec output opens the pager (titled by command)', async () => {
    const longText = Array.from({ length: 6 }, (_, i) => `output line ${i}`).join('\n')
    const p = makeCtx(async method => (method === 'slash.exec' ? { output: longText } : {}))
    await dispatchSlash('/health', p.ctx)
    expect(p.paged).toHaveLength(1)
    expect(p.paged[0]?.title).toBe('Health')
    expect(p.paged[0]?.text).toContain('output line 5')
    expect(p.system).toHaveLength(0)
  })

  test('a newer slash command suppresses late same-session slash.exec output', async () => {
    let resolveSlow!: (value: unknown) => void
    const slow = new Promise<unknown>(done => (resolveSlow = done))
    const p = makeCtx(async (method, params) => {
      if (method !== 'slash.exec') return {}
      return params.command === 'slow' ? slow : { output: 'fresh output' }
    })

    const old = dispatchSlash('/slow', p.ctx)
    await Promise.resolve()
    await dispatchSlash('/fast', p.ctx)
    resolveSlow({ output: 'stale output' })
    await old

    expect(p.system).toEqual(['fresh output'])
  })

  test('slash.exec rejects → command.dispatch; send result submits a user turn', async () => {
    const p = makeCtx(async method => {
      if (method === 'slash.exec') throw new Error('not a worker command')
      if (method === 'command.dispatch') return { type: 'send', message: 'run the thing' }
      return {}
    })
    await dispatchSlash('/dothing', p.ctx)
    expect(p.calls.map(c => c.method)).toEqual(['slash.exec', 'command.dispatch'])
    expect(p.submitted).toEqual(['run the thing'])
  })

  test('command.dispatch exec → system output', async () => {
    const p = makeCtx(async method => {
      if (method === 'slash.exec') throw new Error('reject')
      return { type: 'exec', output: 'done' }
    })
    await dispatchSlash('/whatever', p.ctx)
    expect(p.system).toContain('done')
  })

  // The server's slash.exec routes _PENDING_INPUT_COMMANDS (goal/queue/steer/retry/
  // plan/undo) to command.dispatch and returns a {type:…} dispatch payload DIRECTLY
  // on the SUCCESS path — not a {output} payload. The slash.exec branch must detect
  // that shape and render it via handleDispatchResult, NOT as "/<name>: no output".
  test('slash.exec returns a {type:send} dispatch payload → notice + submit (no "no output")', async () => {
    const p = makeCtx(async method =>
      method === 'slash.exec' ? { type: 'send', notice: '⊙ Goal set', message: 'do the goal' } : {}
    )
    await dispatchSlash('/goal do the goal', p.ctx)
    // Stayed on the slash.exec path (no command.dispatch fallback needed).
    expect(p.calls.map(c => c.method)).toEqual(['slash.exec'])
    expect(p.calls[0]).toEqual({
      method: 'slash.exec',
      params: { command: 'goal do the goal', session_id: 'sid-1' }
    })
    // The notice rendered AND the kickoff was submitted as a user turn…
    expect(p.system).toContain('⊙ Goal set')
    expect(p.submitted).toEqual(['do the goal'])
    // …and the bogus "/goal: no output" line is NOT present.
    expect(p.system).not.toContain('/goal: no output')
  })

  test('a rejected {type:send} result restores the generated body instead of dropping it', async () => {
    const p = makeCtx(async () => ({ type: 'send', message: 'release-critical generated prompt' }))
    const ctx = { ...p.ctx, submit: () => false }
    await dispatchSlash('/extension', ctx)
    expect(p.prefills).toEqual(['release-critical generated prompt'])
    expect(p.system.at(-1)).toBe('generated prompt could not be queued — message restored to composer')
  })

  test('slash.exec returns a {type:exec} dispatch payload → exec output (no "no output")', async () => {
    const p = makeCtx(async method => (method === 'slash.exec' ? { type: 'exec', output: '⏸ Goal paused' } : {}))
    await dispatchSlash('/goal pause', p.ctx)
    expect(p.calls.map(c => c.method)).toEqual(['slash.exec'])
    expect(p.system).toContain('⏸ Goal paused')
    expect(p.system).not.toContain('/goal: no output')
  })

  test('REGRESSION: a plain {output} result (no `type`) still renders normally', async () => {
    const p = makeCtx(async method => (method === 'slash.exec' ? { output: 'hello' } : {}))
    await dispatchSlash('/goal status', p.ctx)
    expect(p.calls.map(c => c.method)).toEqual(['slash.exec'])
    // Short output → system line (unchanged normal path); no dispatch handling.
    expect(p.system).toContain('hello')
    expect(p.submitted).toHaveLength(0)
    expect(p.paged).toHaveLength(0)
  })

  // A skill slash command (/dogfood) returns {type:'skill', name, message:<body>}.
  // It must route through submitSkill (collapsed render + full body to the model),
  // NOT through submit (which would dump the whole body as a giant user bubble).
  test('slash.exec returns a {type:skill} dispatch payload → submitSkill (collapsed), not submit', async () => {
    const body = '# Dogfood Skill\n\nfull body line 1\nfull body line 2'
    const p = makeCtx(async method =>
      method === 'slash.exec' ? { type: 'skill', name: 'dogfood', message: body } : {}
    )
    await dispatchSlash('/dogfood', p.ctx)
    expect(p.calls.map(c => c.method)).toEqual(['slash.exec'])
    // Routed to submitSkill with the slash command + the FULL body…
    expect(p.skillSubmitted).toEqual([{ command: '/dogfood', body }])
    // …and NOT to submit (no giant user bubble).
    expect(p.submitted).toHaveLength(0)
    expect(p.system).not.toContain('/dogfood: no output')
  })

  test('a {type:skill} with args preserves the args in the rendered command', async () => {
    const p = makeCtx(async method =>
      method === 'slash.exec' ? { type: 'skill', name: 'triage-nous', message: 'body' } : {}
    )
    await dispatchSlash('/triage-nous since yesterday', p.ctx)
    expect(p.skillSubmitted).toEqual([{ command: '/triage-nous since yesterday', body: 'body' }])
  })
})

describe('diagnostic command gating (HERMES_TUI_DIAGNOSTICS)', () => {
  const KEY = 'HERMES_TUI_DIAGNOSTICS'
  const prev = process.env[KEY]
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY]
    else process.env[KEY] = prev
  })

  test('OFF (default): /mem and /heapdump respond with the enable hint, not the command', async () => {
    delete process.env[KEY]
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/mem', p.ctx)
    await dispatchSlash('/heapdump', p.ctx)
    expect(p.system[0]).toContain('HERMES_TUI_DIAGNOSTICS=1')
    expect(p.system[1]).toContain('HERMES_TUI_DIAGNOSTICS=1')
    expect(p.calls).toHaveLength(0) // never reached the gateway ladder either
  })

  test('OFF: the diagnostic names are absent from clientCommandNames()', () => {
    delete process.env[KEY]
    const names = clientCommandNames()
    expect(names).not.toContain('mem')
    expect(names).not.toContain('heapdump')
    expect(names).toContain('logs') // non-diagnostic neighbors stay
  })

  test('ON: /mem executes (live memory stats), names are listed', async () => {
    process.env[KEY] = '1'
    expect(clientCommandNames()).toContain('mem')
    expect(clientCommandNames()).toContain('heapdump')
    const p = makeCtx(async () => ({}))
    await dispatchSlash('/mem', p.ctx)
    const out = [...p.system, ...p.paged.map(x => x.text)].join('\n')
    expect(out).toMatch(/rss|heap/i)
  })
})
