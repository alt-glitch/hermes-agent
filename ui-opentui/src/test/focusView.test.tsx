/**
 * /focus — focus view (port of upstream d6fa2709de6, reproduced natively in
 * the OpenTUI/Solid engine). Layers covered:
 *   1. decoder: `focusViewFromConfig` reads `display.focus_view` off
 *      `config.get full` (shape-defensive — both boot entry paths feed it).
 *   2. store: the flag starts OFF, round-trips through setFocusView, the
 *      hydrate/revision race guard mirrors compact, and — like every
 *      config-backed launch-level display pref — it deliberately SURVIVES the
 *      session reset paths (the persisted config owns it, not the session).
 *   3. frames: the pinned `◉ focus` status-bar badge renders warn-tinted when
 *      on, disappears when off, stays WHOLE on one physical row at narrow
 *      widths, and the variable-width tail budgets around it instead of the
 *      badge truncating.
 * The slash handler itself (arg parsing + the exact config.set writes) is
 * covered beside its siblings in utilityCommands.test.ts.
 */
import { RGBA } from '@opentui/core'
import { describe, expect, test } from 'vitest'

import { focusViewFromConfig } from '../logic/details.ts'
import { createSessionStore, type SessionStore } from '../logic/store.ts'
import { StatusBar } from '../view/statusBar.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame, renderProbe } from './lib/render.ts'

// ── 1. decoder (config.get full → display.focus_view) ────────────────────

describe('focusViewFromConfig', () => {
  test('reads display.focus_view truthiness', () => {
    expect(focusViewFromConfig({ display: { focus_view: true } })).toBe(true)
    expect(focusViewFromConfig({ display: { focus_view: false } })).toBe(false)
  })

  test('absent key, absent display block, and malformed roots decode to OFF', () => {
    expect(focusViewFromConfig({ display: {} })).toBe(false)
    expect(focusViewFromConfig({})).toBe(false)
    expect(focusViewFromConfig(undefined)).toBe(false)
    expect(focusViewFromConfig('nonsense')).toBe(false)
    expect(focusViewFromConfig({ display: 'nonsense' })).toBe(false)
  })

  test('a truthy non-boolean (a sloppy hand-edited yaml value) still reads as ON', () => {
    expect(focusViewFromConfig({ display: { focus_view: 1 } })).toBe(true)
    expect(focusViewFromConfig({ display: { focus_view: 'on' } })).toBe(true)
  })
})

// ── 2. store flag + hydration race guard + reset-path persistence ─────────

describe('store focusView flag', () => {
  test('starts OFF and round-trips through setFocusView', () => {
    const store = createSessionStore()
    expect(store.state.focusView).toBe(false)
    store.setFocusView(true)
    expect(store.state.focusView).toBe(true)
    store.setFocusView(false)
    expect(store.state.focusView).toBe(false)
  })

  test('boot hydration applies with the captured revision (the entry path)', () => {
    const store = createSessionStore()
    const revision = store.getFocusViewRevision()
    expect(store.hydrateFocusView(true, revision)).toBe(true)
    expect(store.state.focusView).toBe(true)
  })

  test('a user /focus during hydration wins — the stale reply is dropped', () => {
    const store = createSessionStore()
    const revision = store.getFocusViewRevision() // captured before the RPC
    store.setFocusView(true) // user command lands while config.get is in flight
    expect(store.hydrateFocusView(false, revision)).toBe(false)
    expect(store.state.focusView).toBe(true)
  })

  test('deliberately survives BOTH session reset paths (config-backed launch-level pref)', () => {
    const store = createSessionStore()
    store.setFocusView(true)
    store.clearTranscript() // the /clear · /new path
    expect(store.state.focusView).toBe(true)
    store.commitSnapshot([]) // the resume/reconnect path
    expect(store.state.focusView).toBe(true)
    store.detachSession() // the hard session-replacement boundary
    expect(store.state.focusView).toBe(true)
  })
})

// ── 3. frames — the pinned warn badge ─────────────────────────────────────

function focusStore(model = 'anthropic/claude-opus-4-8'): SessionStore {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.applyInfo({
    model,
    cwd: '/tmp/proj',
    branch: 'main',
    usage: { context_percent: 42, context_used: 84_000 }
  })
  store.setFocusView(true)
  return store
}

function bar(store: SessionStore) {
  return () => (
    <ThemeProvider theme={() => store.state.theme}>
      <StatusBar store={store} />
    </ThemeProvider>
  )
}

describe('StatusBar ◉ focus badge', () => {
  test('renders warn-tinted while on and disappears live when /focus off flips the flag', async () => {
    const store = focusStore()
    const probe = await renderProbe(bar(store), { width: 120, height: 3 })
    try {
      expect(probe.frame()).toContain('◉ focus')
      const badge = probe
        .spans()
        .lines.flatMap(line => line.spans)
        .find(span => span.text.includes('◉ focus'))
      expect(badge).toBeDefined()
      expect(badge?.fg.toInts().slice(0, 3)).toEqual(RGBA.fromHex(store.state.theme.color.warn).toInts().slice(0, 3))

      store.setFocusView(false)
      await probe.settle()
      expect(probe.frame()).not.toContain('◉ focus')
    } finally {
      probe.destroy()
    }
  })

  test('stays WHOLE on one physical status row across narrow widths (never a second row)', async () => {
    const store = focusStore('m')
    for (const width of [24, 30, 40, 60, 80, 120]) {
      const frame = await captureFrame(bar(store), { width, height: 3 })
      const rows = frame.split('\n').filter(row => row.trim())
      expect(rows, `width ${String(width)}`).toHaveLength(1)
      expect(rows[0], `width ${String(width)}`).toContain('◉ focus')
    }
  })

  test('the variable-width resume hint budgets around the badge instead of wrapping/truncating it', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.applyInfo({ model: 'm', running: false, usage: { active_subagents: 12 } })

    // Baseline: at 48 cols the idle hint affords its full wording. With the
    // pinned badge on, the SAME width no longer does — the hint (lower
    // priority) degrades to a shorter width-aware variant; the badge stays
    // whole and the bar stays one row.
    const baseline = await captureFrame(bar(store), { width: 48, height: 3 })
    expect(baseline).toContain('↩ resumes when 12 subagents finish')

    store.setFocusView(true)
    const frame = await captureFrame(bar(store), { width: 48, height: 3 })
    const rows = frame.split('\n').filter(row => row.trim())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('◉ focus')
    expect(rows[0]).not.toContain('↩ resumes when 12 subagents finish')
    expect(rows[0]).toContain('↩') // a shorter width-aware variant survives
  })
})
