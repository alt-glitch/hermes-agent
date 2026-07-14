/**
 * Status chrome v3 — ONE left-aligned labeled line at every width.
 * Layers covered:
 *   1. schema: the SessionInfo wire fields decode (and null/absence is safe)
 *   2. store: applyInfo merges the usage/chrome fields
 *   3. pure logic: statusSegments width table (priority drop order), the
 *      ctxBarCells gauge ladder, ctx/cmp threshold levels, compact formatters,
 *      and Ink-compatible spawn-HUD pressure/labels
 *   4. frames: the bar renders ONE left-flowing labeled row (`ctx:`/`cost:`/
 *      `up:`/`cmp:`/`mcp:`), drops tail segments whole as the terminal
 *      narrows (never wraps to a second line), and the update notice borrows
 *      the line.
 */
import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { decodeSessionInfoPatch } from '../boundary/schema/SessionInfo.ts'
import { applyDelegationState, createDelegationState } from '../logic/agentStatus.ts'
import { createSessionStore, type SessionStore, type SubagentInfo } from '../logic/store.ts'
import {
  cmpLevel,
  ctxBarCells,
  ctxLevel,
  effortSuffix,
  fmtShortDuration,
  fmtTokens,
  spawnHudModel,
  StatusBar,
  statusSegments
} from '../view/statusBar.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame, renderProbe } from './lib/render.ts'

// ── 1. schema ────────────────────────────────────────────────────────────

describe('SessionInfoPatchSchema — chrome wire fields', () => {
  test('decodes the chrome fields (update/profile/mcp/cost)', () => {
    const decoded = decodeSessionInfoPatch({
      model: 'anthropic/claude-opus-4-8',
      update_behind: 3,
      update_command: 'hermes update',
      profile_name: 'researcher',
      mcp_servers: [{ name: 'railway' }, { name: 'beeper' }],
      usage: { context_percent: 42, context_used: 84_000, cost_usd: 0.41, compressions: 2 }
    })
    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isSome(decoded)) {
      expect(decoded.value.update_behind).toBe(3)
      expect(decoded.value.update_command).toBe('hermes update')
      expect(decoded.value.profile_name).toBe('researcher')
      expect(decoded.value.mcp_servers).toHaveLength(2)
      expect(decoded.value.usage?.cost_usd).toBe(0.41)
    }
  })

  test('update_behind: null (check not resolved yet) decodes — None-safe', () => {
    const decoded = decodeSessionInfoPatch({ model: 'm', update_behind: null, update_command: '' })
    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isSome(decoded)) expect(decoded.value.update_behind).toBeNull()
  })

  test('all chrome fields absent still decodes (every key optional)', () => {
    expect(Option.isSome(decodeSessionInfoPatch({ model: 'm' }))).toBe(true)
  })
})

// ── 2. store applyInfo ───────────────────────────────────────────────────

describe('store.applyInfo — chrome merge', () => {
  test('merges cost/update/profile/mcp into SessionInfo', () => {
    const store = createSessionStore()
    store.applyInfo({
      model: 'opus',
      update_behind: 4,
      update_command: 'uv tool upgrade hermes',
      profile_name: 'researcher',
      // mcpServers now counts CONNECTED servers (not configured-but-disabled);
      // all three are connected here, so the merged count is 3.
      mcp_servers: [{ connected: true }, { connected: true }, { connected: true }],
      usage: { cost_usd: 0.4129, context_percent: 42 }
    })
    expect(store.state.info.costUsd).toBeCloseTo(0.4129)
    expect(store.state.info.updateBehind).toBe(4)
    expect(store.state.info.updateCommand).toBe('uv tool upgrade hermes')
    expect(store.state.info.profileName).toBe('researcher')
    expect(store.state.info.mcpServers).toBe(3)
  })

  test('update_behind: null leaves the prior value alone (partial-patch rule)', () => {
    const store = createSessionStore()
    store.applyInfo({ update_behind: 2 })
    store.applyInfo({ update_behind: null })
    expect(store.state.info.updateBehind).toBe(2)
  })

  test('a usage patch with cost does not clobber unrelated chrome', () => {
    const store = createSessionStore()
    store.applyInfo({ model: 'opus', profile_name: 'researcher' })
    store.applyInfo({ usage: { cost_usd: 0.1 } })
    expect(store.state.info).toMatchObject({ model: 'opus', profileName: 'researcher', costUsd: 0.1 })
  })

  test('startedAt is seeded at store creation and never patched off the wire', () => {
    const before = Date.now()
    const store = createSessionStore()
    expect(store.state.info.startedAt).toBeGreaterThanOrEqual(before)
    const seeded = store.state.info.startedAt
    store.applyInfo({ model: 'opus' })
    expect(store.state.info.startedAt).toBe(seeded)
  })
})

// ── 3. pure logic ────────────────────────────────────────────────────────

test('reasoning footer removes a prior xhigh suffix when medium arrives', () => {
  expect(effortSuffix('xhigh', false)).toBe(' ·xhigh')
  expect(effortSuffix('medium', false)).toBe('')
})

describe('statusSegments — progressive disclosure table (chrome v3 order)', () => {
  test('full width shows everything', () => {
    expect(statusSegments(220)).toEqual({
      agents: true,
      ctxDetail: true,
      cost: true,
      voice: true,
      up: true,
      compressions: true,
      sessions: true,
      profile: true,
      browser: true,
      bg: true,
      mcp: true
    })
  })

  test('segments drop whole in reverse priority as width shrinks: mcp → bg → profile → cmp → up → cost → ctx detail', () => {
    // each row: [width, expected visible flags]
    const table: Array<[number, Partial<ReturnType<typeof statusSegments>>]> = [
      [125, { mcp: false, bg: true }], // mcp drops first
      [117, { mcp: false, bg: false, profile: true }], // then bg
      [107, { profile: false, compressions: true }], // then profile
      [111, { browser: false, profile: true }], // browser drops before profile
      [99, { sessions: false, compressions: true }], // then live-session count
      [93, { compressions: false, up: true }], // then cmp
      [87, { up: false, cost: true }], // then uptime
      [83, { voice: false, cost: true }], // exact-f7 voice breakpoint
      [79, { cost: false, ctxDetail: true }], // then cost
      [71, { ctxDetail: false }] // finally the bar/token detail collapses to `ctx: 42%`
    ]
    for (const [width, expected] of table) {
      expect(statusSegments(width)).toMatchObject(expected)
    }
  })

  test('pinned essentials are never gated: statusSegments only governs the tail', () => {
    // even at absurdly narrow widths the table stays well-formed (booleans, no throw)
    const segs = statusSegments(10)
    expect(Object.values(segs).every(v => v === false)).toBe(true)
  })
})

describe('ctxBarCells — the gauge breathes (10–14 cells, vs the old 5)', () => {
  test('14 cells wide, 12 at normal widths, 10 when tight', () => {
    expect(ctxBarCells(220)).toBe(14)
    expect(ctxBarCells(160)).toBe(14)
    expect(ctxBarCells(159)).toBe(12)
    expect(ctxBarCells(120)).toBe(12)
    expect(ctxBarCells(100)).toBe(12)
    expect(ctxBarCells(99)).toBe(10)
    expect(ctxBarCells(80)).toBe(10)
    expect(ctxBarCells(0)).toBe(10) // degenerate input stays well-formed
  })
})

describe('threshold levels (spec 50/80/95 and cmp 5/10)', () => {
  test('ctxLevel boundaries', () => {
    expect(ctxLevel(0)).toBe('ok')
    expect(ctxLevel(49)).toBe('ok')
    expect(ctxLevel(50)).toBe('warn')
    expect(ctxLevel(79)).toBe('warn')
    expect(ctxLevel(80)).toBe('bad')
    expect(ctxLevel(94)).toBe('bad')
    expect(ctxLevel(95)).toBe('critical')
    expect(ctxLevel(100)).toBe('critical')
  })

  test('cmpLevel boundaries', () => {
    expect(cmpLevel(0)).toBe('ok')
    expect(cmpLevel(4)).toBe('ok')
    expect(cmpLevel(5)).toBe('warn')
    expect(cmpLevel(9)).toBe('warn')
    expect(cmpLevel(10)).toBe('bad')
  })
})

describe('compact formatters', () => {
  test('fmtTokens', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(84_321)).toBe('84k')
    expect(fmtTokens(1_000_000)).toBe('1M')
    expect(fmtTokens(1_250_000)).toBe('1.3M')
  })

  test('fmtShortDuration', () => {
    expect(fmtShortDuration(42)).toBe('42s')
    expect(fmtShortDuration(23 * 60)).toBe('23m')
    expect(fmtShortDuration(65 * 60)).toBe('1h05m')
  })
})

describe('spawnHudModel — Ink compact tree/cap semantics', () => {
  const agent = (id: string, status: string, depth: number, parentId?: string): SubagentInfo => ({
    depth,
    goal: id,
    id,
    ...(parentId === undefined ? {} : { parentId }),
    status
  })
  const tree = [
    agent('root', 'running', 0),
    agent('child-a', 'running', 1, 'root'),
    agent('child-b', 'queued', 1, 'root')
  ]
  const caps = (depth: number, concurrency: number) =>
    applyDelegationState(createDelegationState(), { max_concurrent_children: concurrency, max_spawn_depth: depth }, 1)

  test('hides only when both the live tree is empty and delegation is not paused', () => {
    expect(spawnHudModel([], createDelegationState())).toEqual({ text: '', tone: 'muted' })
    const paused = applyDelegationState(createDelegationState(), { paused: true }, 1)
    expect(spawnHudModel([], paused)).toEqual({ text: '⏸ paused', tone: 'error' })
  })

  test.each([
    {
      name: 'unknown caps stay compact and neutral',
      rows: [agent('root', 'running', 0)],
      delegation: createDelegationState(),
      expected: { text: 'd1 ⚡1', tone: 'muted' }
    },
    {
      name: 'below .66 is neutral',
      rows: [agent('root', 'running', 0)],
      delegation: caps(4, 4),
      expected: { text: 'd1/4 ⚡1/4', tone: 'muted' }
    },
    {
      name: 'widest level drives warn while +extra reports the remaining active rows',
      rows: tree,
      delegation: caps(3, 3),
      expected: { text: 'd2/3 ⚡2/3+1', tone: 'warn' }
    },
    {
      name: 'at-cap prefixes the warning glyph and uses error tone',
      rows: tree,
      delegation: caps(2, 2),
      expected: { text: '⚠ d2/2 ⚡2/2+1', tone: 'error' }
    },
    {
      name: 'a terminal tree keeps the depth HUD but omits the active-width label',
      rows: [agent('root', 'completed', 0)],
      delegation: caps(3, 4),
      expected: { text: 'd1/3', tone: 'muted' }
    }
  ])('$name', ({ rows, delegation, expected }) => {
    expect(spawnHudModel(rows, delegation)).toEqual(expected)
  })
})

// ── 4. frames ────────────────────────────────────────────────────────────

function seededStore(): SessionStore {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.applyInfo({
    model: 'anthropic/claude-opus-4-8',
    reasoning_effort: 'high',
    cwd: '/tmp/proj',
    branch: 'main',
    profile_name: 'researcher',
    // both servers connected → `mcp: 2` (the count is connected servers, not configured).
    mcp_servers: [{ connected: true }, { connected: true }],
    usage: { context_percent: 42, context_used: 84_000, context_max: 200_000, cost_usd: 0.41, compressions: 2 }
  })
  return store
}

function parkedStore(count: number, running: boolean): SessionStore {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.applyInfo({ model: 'm', running, usage: { active_subagents: count } })
  return store
}

function bar(store: SessionStore) {
  return () => (
    <ThemeProvider theme={() => store.state.theme}>
      <StatusBar store={store} />
    </ThemeProvider>
  )
}

describe('StatusBar frames (one left-aligned labeled line)', () => {
  test('WIDE (220) renders every labeled segment in order on ONE line, cwd last', async () => {
    const frame = await captureFrame(bar(seededStore()), { width: 220, height: 4 })
    const rows = frame.split('\n').filter(r => r.trim())
    const row = rows.find(r => r.includes('claude-opus-4-8')) ?? ''
    // ONE line carries everything…
    expect(row).toContain('·high') // effort suffix
    expect(row).toContain('ctx: ') // labeled gauge
    expect(row).toContain('42%')
    expect(row).toContain('· 84k')
    expect(row).toContain('█'.repeat(6)) // 42% of a 14-cell bar = 6 filled
    expect(row).toContain('░')
    expect(row).toContain('cost: $0.41')
    expect(row).toContain('up: ')
    expect(row).toContain('cmp: 2')
    expect(row).toContain('researcher') // profile badge, plain
    expect(row).toContain('mcp: 2')
    expect(row).toContain('/tmp/proj (main)')
    expect(row).toContain('│')
    // …in the v3 order: model → ctx → cost → up → cmp → profile → mcp → cwd
    const order = ['claude-opus-4-8', 'ctx: ', 'cost: ', 'up: ', 'cmp: ', 'researcher', 'mcp: ', '/tmp/proj']
    const positions = order.map(s => row.indexOf(s))
    expect(positions.every(p => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    // …and no other row carries chrome: the bar never restacks to two lines.
    expect(rows.filter(r => r.includes('│')).length).toBe(1)
  })

  test('right-pinned cwd (F10) — the path hugs the right edge of the wide row', async () => {
    const width = 220
    const frame = await captureFrame(bar(seededStore()), { width, height: 4 })
    const row = frame.split('\n').find(r => r.includes('claude-opus-4-8')) ?? ''
    // the cwd is pinned right: the row's content reaches near the right edge
    // (a flex spacer eats the slack), not stopping ~mid-bar as the old
    // left-flowing layout did. Allow a couple cells of padding/rounding.
    expect(row.trimEnd().length).toBeGreaterThan(width - 6)
    // and the meaningful tail (dirname + branch) sits at the very end.
    expect(row.trimEnd().endsWith('(main)')).toBe(true)
  })

  test('MEDIUM (120) keeps one labeled line; the cwd tail-truncates into the leftover budget', async () => {
    const frame = await captureFrame(bar(seededStore()), { width: 120, height: 3 })
    const rows = frame.split('\n').filter(r => r.trim())
    const row = rows.find(r => r.includes('claude-opus-4-8')) ?? ''
    expect(row).toContain('ctx: ')
    expect(row).toContain('█'.repeat(5)) // 42% of a 12-cell bar = 5 filled
    expect(row).toContain('cost: $0.41')
    expect(row).toContain('cmp: 2')
    expect(row).toContain('researcher')
    expect(row).not.toContain('mcp:') // mcp dropped below 126 cols
    expect(row).toContain('(main)') // cwd survives (tail-truncated)
    expect(rows.filter(r => r.includes('│')).length).toBe(1) // still ONE line
  })

  test('narrow (78) drops the tail whole (no cost/up/cmp/profile/mcp) and compacts the gauge', async () => {
    const frame = await captureFrame(bar(seededStore()), { width: 78, height: 3 })
    expect(frame).toContain('claude-opus-4-8') // pinned
    expect(frame).toContain('ctx: ') // pinned, still labeled
    expect(frame).toContain('42%')
    expect(frame).toContain('█') // ctxDetail holds at ≥72
    expect(frame).not.toContain('cost:')
    expect(frame).not.toContain('up:')
    expect(frame).not.toContain('cmp:')
    expect(frame).not.toContain('researcher')
    expect(frame).not.toContain('mcp:')
  })

  test('very narrow (70) collapses the gauge to a bare labeled percent', async () => {
    const frame = await captureFrame(bar(seededStore()), { width: 70, height: 3 })
    expect(frame).toContain('claude-opus-4-8') // pinned
    expect(frame).toContain('ctx: 42%') // pinned (compact, still labeled)
    expect(frame).not.toContain('█') // bar detail dropped
    expect(frame).not.toContain('84k')
    expect(frame).not.toContain('$0.41')
  })

  test('Agents chip uses authoritative usage including zero, with local-row fallback', async () => {
    const store = seededStore()
    store.apply({
      type: 'subagent.start',
      payload: { depth: 0, goal: 'local compatibility row', subagent_id: 'local-1' }
    })
    const probe = await renderProbe(bar(store), { width: 120, height: 3 })
    try {
      expect(probe.frame()).toContain('⛓ 1') // usage absent → normalized local fallback

      store.applyInfo({ usage: { active_subagents: 0 } })
      await probe.settle()
      expect(probe.frame()).not.toContain('⛓') // explicit registry zero wins over the live row

      store.applyInfo({ usage: { active_subagents: 3 } })
      await probe.settle()
      expect(probe.frame()).toContain('⛓ 3') // registry count need not match the local tree
    } finally {
      probe.destroy()
    }
  })

  test.each([
    [80, '↩ resumes when 12 subagents finish'],
    [40, '↩ resumes · 12'],
    [20, '↩ 12'],
    [10, '']
  ])('idle auto-resume hint picks one whole width-aware variant at %i columns', async (width, expected) => {
    const frame = await captureFrame(bar(parkedStore(12, false)), { width, height: 3 })
    const rows = frame.split('\n').filter(row => row.trim())
    expect(rows).toHaveLength(1)
    if (expected) expect(rows[0]).toContain(expected)
    else expect(frame).not.toContain('↩')
  })

  test('idle hint uses actual remaining cells and preserves the minimum cwd tail', async () => {
    const minimal = await captureFrame(bar(parkedStore(12, false)), { width: 70, height: 3 })
    expect(minimal).toContain('↩ resumes when 12 subagents finish')

    const crowded = seededStore()
    crowded.applyInfo({ running: false, usage: { active_subagents: 12 } })
    const frame = await captureFrame(bar(crowded), { width: 70, height: 3 })
    const rows = frame.split('\n').filter(row => row.trim())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('↩ 12')
    expect(rows[0]).not.toContain('↩ resumes')
    expect(rows[0]).toContain('(main)')
  })

  test('auto-resume promise hides while the main turn runs, at registry zero, and for local fallback only', async () => {
    const store = parkedStore(2, false)
    const probe = await renderProbe(bar(store), { width: 80, height: 3 })
    try {
      expect(probe.frame()).toContain('↩ resumes when 2 subagents finish')

      store.applyInfo({ running: true, usage: { active_subagents: 2 } })
      await probe.settle()
      expect(probe.frame()).not.toContain('↩')

      store.applyInfo({ running: false, usage: { active_subagents: 0 } })
      await probe.settle()
      expect(probe.frame()).not.toContain('↩')
    } finally {
      probe.destroy()
    }

    const fallback = seededStore()
    fallback.apply({ type: 'subagent.start', payload: { goal: 'legacy row', subagent_id: 'local-only' } })
    const frame = await captureFrame(bar(fallback), { width: 120, height: 3 })
    expect(frame).toContain('⛓ 1')
    expect(frame).not.toContain('↩')
  })

  test('SpawnHud stays after width-gated segments and never creates a second chrome row', async () => {
    const store = seededStore()
    expect(
      store.applyDelegationStatusResponse({
        active: [],
        max_concurrent_children: 3,
        max_spawn_depth: 3,
        paused: false
      })
    ).toBe(true)
    store.apply({ type: 'subagent.start', payload: { depth: 0, goal: 'root', subagent_id: 'root' } })
    store.apply({
      type: 'subagent.start',
      payload: { depth: 1, goal: 'child a', parent_id: 'root', subagent_id: 'child-a' }
    })
    store.apply({
      type: 'subagent.spawn_requested',
      payload: { depth: 1, goal: 'child b', parent_id: 'root', subagent_id: 'child-b' }
    })

    for (const width of [60, 70, 78, 120, 220]) {
      const frame = await captureFrame(bar(store), { width, height: 3 })
      const rows = frame.split('\n').filter(row => row.trim())
      const chrome = rows.find(row => row.includes('claude-opus-4-8')) ?? ''
      expect(chrome, `width ${String(width)}`).toContain('d2/3')
      expect(chrome, `width ${String(width)}`).toContain('⚡2/3')
      if (width === 220) expect(chrome).toContain('⚡2/3+1')
      expect(rows.filter(row => row.includes('│')).length, `width ${String(width)}`).toBe(1)
    }
  })

  test('paused SpawnHud remains visible with no live tree', async () => {
    const store = seededStore()
    expect(store.applyDelegationPauseResponse({ paused: true })).toBe(true)
    const frame = await captureFrame(bar(store), { width: 120, height: 3 })
    expect(frame).toContain('⏸ paused')
  })

  test('update notice borrows the line and Esc dismisses it back to the normal bar', async () => {
    const store = seededStore()
    store.applyInfo({ update_behind: 3, update_command: 'hermes update' })
    const probe = await renderProbe(bar(store), { width: 120, height: 3, kittyKeyboard: true })
    try {
      expect(probe.frame()).toContain('3 commits behind')
      expect(probe.frame()).toContain('hermes update')
      expect(probe.frame()).not.toContain('$0.41') // the notice replaced the segments
      probe.keys.pressEscape()
      await probe.settle()
      const after = await probe.waitForFrame(f => f.includes('$0.41'))
      expect(after).not.toContain('commits behind')
    } finally {
      probe.destroy()
    }
  })
})
