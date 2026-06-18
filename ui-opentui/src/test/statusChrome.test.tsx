/**
 * Status chrome v3 — ONE left-aligned labeled line at every width.
 * Layers covered:
 *   1. schema: the SessionInfo wire fields decode (and null/absence is safe)
 *   2. store: applyInfo merges the usage/chrome fields
 *   3. pure logic: statusSegments width table (priority drop order), the
 *      ctxBarCells gauge ladder, ctx/cmp threshold levels + compact formatters
 *   4. frames: the bar renders ONE left-flowing labeled row (`ctx:`/`cost:`/
 *      `up:`/`cmp:`/`mcp:`), drops tail segments whole as the terminal
 *      narrows (never wraps to a second line), and the update notice borrows
 *      the line.
 */
import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { decodeSessionInfoPatch } from '../boundary/schema/SessionInfo.ts'
import { createSessionStore, type SessionStore } from '../logic/store.ts'
import {
  cmpLevel,
  ctxBarCells,
  ctxLevel,
  fmtShortDuration,
  fmtTokens,
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

describe('statusSegments — progressive disclosure table (chrome v3 order)', () => {
  test('full width shows everything', () => {
    expect(statusSegments(220)).toEqual({
      agents: true,
      ctxDetail: true,
      cost: true,
      up: true,
      compressions: true,
      profile: true,
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
      [93, { compressions: false, up: true }], // then cmp
      [87, { up: false, cost: true }], // then uptime
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
