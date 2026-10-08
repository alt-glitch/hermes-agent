/**
 * Lane modelfx parity: reasoning_effort_wire clamp label, MCP lazy status,
 * completion popover two-column grid, home catalog shimmer, and the /model
 * effort step chaining through the native picker overlay.
 */
import { describe, expect, test } from 'vitest'

import { completionNameWidth } from '../logic/completionMenu.ts'
import { mcpServerNote } from '../logic/mcpStatus.ts'
import { createPromptHistory } from '../logic/history.ts'
import { shimmerSegments } from '../logic/shimmer.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { effortSuffix, StatusBar } from '../view/statusBar.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

describe('reasoning_effort_wire → effort→wire (Ink 171a1777b5)', () => {
  test('a clamped effort reads ultra→max; verbatim or unstamped wire makes no claim', () => {
    expect(effortSuffix('ultra', false, 'max')).toBe(' ·ultra→max')
    expect(effortSuffix('high', false, 'high')).toBe(' ·high')
    expect(effortSuffix('ultra', false, '')).toBe(' ·ultra')
    expect(effortSuffix('ultra', true)).toBe(' ·ultra·fast')
  })

  test('session.info decodes the wire level; a new effort without a stamp clears the old clamp', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.applyInfo({ model: 'anthropic/claude-opus-4-8', reasoning_effort: 'ultra', reasoning_effort_wire: 'max' })
    expect(store.state.info.effort).toBe('ultra')
    expect(store.state.info.effortWire).toBe('max')
    store.applyInfo({ reasoning_effort: 'high' })
    expect(store.state.info.effortWire).toBe('')
    // malformed wire value: the whole patch is rejected, prior state intact
    store.applyInfo({ reasoning_effort: 'low', reasoning_effort_wire: 7 })
    expect(store.state.info.effort).toBe('high')
  })

  test('the status bar renders ultra→max', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.applyInfo({ model: 'anthropic/claude-opus-4-8', reasoning_effort: 'ultra', reasoning_effort_wire: 'max' })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <StatusBar store={store} />
        </ThemeProvider>
      ),
      { width: 160, height: 3 }
    )
    try {
      expect(probe.frame()).toContain('claude-opus-4-8 ·ultra→max')
    } finally {
      probe.destroy()
    }
  })
})

describe('MCP lazy status (Ink abdb402701)', () => {
  test('lazy servers count as available and keep their cached tool count', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.applyInfo({
      mcp_servers: [
        { name: 'railway', connected: true, status: 'connected', tools: 4, transport: 'stdio' },
        { name: 'beeper', connected: false, status: 'lazy', tools: 3, transport: 'stdio' },
        { name: 'broken', connected: false, status: 'failed', tools: 0, transport: 'http' },
        { connected: true } // nameless: dropped from per-server status, still counted
      ]
    })
    expect(store.state.info.mcpServers).toBe(3)
    expect(store.state.info.mcpServerStatus?.map(s => [s.name, s.status, s.tools])).toEqual([
      ['railway', 'connected', 4],
      ['beeper', 'lazy', 3],
      ['broken', 'failed', 0]
    ])
    expect(mcpServerNote(store.state.info.mcpServerStatus?.[1])).toEqual({ lazy: true, tools: '3 tools' })
    expect(mcpServerNote(store.state.info.mcpServerStatus?.[2])).toBeUndefined()
  })

  test('the home MCP section shows `N tools (lazy)` for a lazy server', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.setCatalog({ tools: { total: 2, toolsets: [{ name: 'core', count: 2 }] }, mcp: { servers: ['beeper'] } })
    store.applyInfo({ mcp_servers: [{ name: 'beeper', connected: false, status: 'lazy', tools: 1 }] })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { width: 80, height: 30 }
    )
    try {
      // MCP section starts collapsed: expand it by clicking its header row.
      const rows = probe.frame().split('\n')
      const y = rows.findIndex(r => r.includes('MCP Servers (1)'))
      expect(y).toBeGreaterThan(-1)
      await probe.click((rows[y] ?? '').indexOf('MCP') + 1, y)
      const frame = await probe.waitForFrame(f => f.includes('(lazy)'))
      expect(frame).toMatch(/beeper 1 tool \(lazy\)/)
    } finally {
      probe.destroy()
    }
  })
})

describe('completion popover two-column grid (Ink ce8c2c97aa)', () => {
  test('the name track is the widest visible display + a 2-cell gutter', () => {
    expect(
      completionNameWidth([
        { display: '/copy', text: '/copy' },
        { display: '/compact', text: '/compact' }
      ])
    ).toBe(10)
    expect(completionNameWidth([{ display: '', text: 'abc' }])).toBe(5)
  })

  test('descriptions align in their own column in the neutral statusFg tone', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} history={createPromptHistory({})} />
        </ThemeProvider>
      ),
      { width: 70, height: 24, kittyKeyboard: true }
    )
    try {
      store.setCompletions(
        [
          { display: '/copy', meta: 'copy the last response', text: '/copy' },
          { display: '/compact', meta: 'compress context', text: '/compact' }
        ],
        0
      )
      await probe.settle()
      const rows = probe.frame().split('\n')
      const copy = rows.find(r => r.includes('/copy') && r.includes('copy the last response')) ?? ''
      const compact = rows.find(r => r.includes('/compact') && r.includes('compress context')) ?? ''
      expect(copy.indexOf('copy the last response')).toBe(compact.indexOf('compress context'))
      expect(copy.indexOf('copy the last response') - copy.indexOf('/copy')).toBe(10)
      const metaSpan = probe
        .spans()
        .lines.flatMap(line => line.spans)
        .find(span => span.text.includes('compress context'))
      expect(metaSpan?.fg.toInts().slice(0, 3)).toEqual(hexInts(store.state.theme.color.statusFg))
    } finally {
      probe.destroy()
    }
  })
})

function hexInts(hex: string): number[] {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
}

describe('home catalog shimmer (Ink 0ada7837e4)', () => {
  test('band math enters off-left, sweeps, and wraps', () => {
    expect(shimmerSegments(10, 0)).toEqual([10, 0, 0])
    expect(shimmerSegments(10, 7)).toEqual([0, 7, 3])
    expect(shimmerSegments(10, 12)).toEqual([5, 5, 0])
    expect(shimmerSegments(10, 17)).toEqual([10, 0, 0])
  })

  test('a pending catalog shows skeleton rows and `… tools · … skills`, never zeros', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { width: 80, height: 30 }
    )
    try {
      let frame = probe.frame()
      expect(frame).toContain('… tools · … skills')
      expect(frame).toContain('▁▁▁')
      expect(frame).not.toContain('0 tools')
      store.setCatalog({
        tools: { total: 0, toolsets: [] },
        skills: { total: 0 },
        readiness: { status: 'pending', retry_after_ms: 1000 }
      })
      await probe.settle()
      frame = probe.frame()
      expect(frame).toContain('… tools · … skills')
      expect(frame).toContain('Available Skills (…)')
      expect(frame).toContain('▁▁▁')
      store.setCatalog({ tools: { total: 42, toolsets: [{ name: 'core', count: 12 }] }, skills: { total: 7 } })
      await probe.settle()
      frame = probe.frame()
      expect(frame).toContain('42 tools · 7 skills')
      expect(frame).not.toContain('▁▁▁')
    } finally {
      probe.destroy()
    }
  })
})

describe('/model effort step through the native picker overlay', () => {
  test('a pick that opens a follow-up picker is not closed by the deferred close', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const levels: string[] = []
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { width: 80, height: 30, kittyKeyboard: true }
    )
    try {
      store.openPicker({
        items: [{ label: 'claude-opus-4.6', value: 'claude-opus-4.6 --provider anthropic' }],
        onPick: () =>
          store.openPicker({
            items: [
              { label: 'high', value: 'high' },
              { label: 'Keep current effort', value: '' }
            ],
            onPick: value => void levels.push(value),
            title: 'Reasoning effort for claude-opus-4.6'
          }),
        title: 'Switch model'
      })
      await probe.settle()
      probe.keys.pressEnter()
      await probe.waitForFrame(f => f.includes('Reasoning effort for claude-opus-4.6'))
      await new Promise(r => setTimeout(r, 10))
      await probe.settle()
      expect(store.state.picker?.title).toBe('Reasoning effort for claude-opus-4.6')
      probe.keys.pressEnter()
      await new Promise(r => setTimeout(r, 10))
      await probe.settle()
      expect(levels).toEqual(['high'])
      expect(store.state.picker).toBeUndefined()
    } finally {
      probe.destroy()
    }
  })
})
