/**
 * Background-agents tray tests (Epic 2.7). Headless frames through the real
 * App + Composer + AgentsTray with a simulated keyboard:
 *
 *   - visibility: nothing rendered with 0 running agents; a one-line muted
 *     indicator with the count otherwise; completed/failed agents drop out.
 *   - focus-routing table: Down on an EMPTY composer with running agents
 *     focuses/expands the tray; Down with text keeps its meaning; Down with
 *     the slash menu open stays menu navigation (routeMenuKey integration
 *     pin); Down with 0 agents keeps prompt history; Esc from the tray
 *     returns focus to the composer; a printable key from the tray bounces
 *     focus back AND inserts the char (the composer's reclaim rule).
 *   - Enter on a tray row opens the agents dashboard preselected on that row.
 *
 * The onType wiring mirrors slashMenu.test.tsx (planCompletion → fake catalog)
 * so the menu-precedence pin runs against entry-parity completions.
 */
import { describe, expect, test } from 'vitest'

import { createPromptHistory } from '../logic/history.ts'
import { planCompletion } from '../logic/slash.ts'
import { createSessionStore, type CompletionItem, type SessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { isTrayAgent } from '../view/agentsTray.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

const EXPANDED_HINT = 'Enter inspect'

/** Fake gateway catalog (what `complete.slash` would return for a `/` prefix). */
const CATALOG: CompletionItem[] = [
  { display: '/clear', meta: 'clear the transcript', text: '/clear' },
  { display: '/copy', meta: 'copy the last response', text: '/copy' }
]

interface Harness {
  probe: RenderProbe
  store: SessionStore
  submitted: string[]
  typed: string[]
}

/** Mount the real App (entry-parity onType, like slashMenu.test.tsx). */
async function mountApp(historyEntries: string[] = []): Promise<Harness> {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  const submitted: string[] = []
  const typed: string[] = []
  const history = createPromptHistory({ initial: historyEntries })
  const onType = (text: string) => {
    typed.push(text)
    const plan = planCompletion(text)
    if (!plan || plan.method !== 'complete.slash') {
      store.clearCompletions()
      return
    }
    const q = String(plan.params.text).toLowerCase()
    const items = CATALOG.filter(c => c.text.startsWith(q) && c.text !== q)
    if (items.length) store.setCompletions(items, plan.from)
    else store.clearCompletions()
  }
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} onSubmit={t => void submitted.push(t)} onType={onType} history={history} />
      </ThemeProvider>
    ),
    // kitty keyboard: a SIMULATED lone ESC never parses under legacy input, and
    // the Esc-from-tray test needs it.
    { height: 26, kittyKeyboard: true, width: 70 }
  )
  return { probe, store, submitted, typed }
}

const spawn = (store: SessionStore, id: string, goal: string) =>
  store.apply({ type: 'subagent.start', payload: { depth: 0, goal, subagent_id: id } })

const complete = (store: SessionStore, id: string) =>
  store.apply({ type: 'subagent.complete', payload: { subagent_id: id, summary: 'done' } })

describe('agents tray — visibility', () => {
  test('isTrayAgent: running-ish statuses are in; ALL terminal statuses are out', () => {
    for (const status of ['running', 'thinking', 'tool', 'working']) {
      expect(isTrayAgent({ depth: 0, goal: 'g', id: 'x', status })).toBe(true)
    }
    // `complete` is the store fallback; the LIVE gateway sends delegate_tool's
    // payload status verbatim — `completed`/`failed`/`error`/`timeout`/`interrupted`
    // (verified live: the success path emits status="completed").
    for (const status of ['complete', 'completed', 'failed', 'error', 'timeout', 'interrupted']) {
      expect(isTrayAgent({ depth: 0, goal: 'g', id: 'x', status })).toBe(false)
    }
  })

  test('0 running agents → the tray renders nothing', async () => {
    const h = await mountApp()
    try {
      expect(h.probe.frame()).not.toContain('⚡')
    } finally {
      h.probe.destroy()
    }
  })

  test('2 running agents → a ⚡ chip in the status bar (no persistent tray line)', async () => {
    const h = await mountApp()
    try {
      spawn(h.store, 'a1', 'research X')
      spawn(h.store, 'a2', 'compile Y')
      const frame = await h.probe.waitForFrame(f => f.includes('⚡'))
      expect(frame).toContain(`⚡ 2`)
      expect(frame).not.toContain(EXPANDED_HINT) // collapsed until focused
    } finally {
      h.probe.destroy()
    }
  })

  test('completed agents drop out; the tray empties when all finish', async () => {
    const h = await mountApp()
    try {
      spawn(h.store, 'a1', 'research X')
      spawn(h.store, 'a2', 'compile Y')
      await h.probe.waitForFrame(f => f.includes('⚡ 2'))
      complete(h.store, 'a1')
      const one = await h.probe.waitForFrame(f => f.includes('⚡ 1'))
      expect(one).toContain(`⚡ 1`)
      complete(h.store, 'a2')
      const none = await h.probe.waitForFrame(f => !f.includes('⚡'))
      expect(none).not.toContain('⚡')
    } finally {
      h.probe.destroy()
    }
  })
})

describe('agents tray — Down-arrow focus routing', () => {
  test('Down on an EMPTY composer with running agents focuses + expands the tray', async () => {
    const h = await mountApp()
    try {
      spawn(h.store, 'a1', 'research X')
      spawn(h.store, 'a2', 'compile Y')
      await h.probe.waitForFrame(f => f.includes('⚡'))
      h.probe.keys.pressArrow('down')
      const frame = await h.probe.waitForFrame(f => f.includes(EXPANDED_HINT))
      // rows show goal + status, with the first row selected
      expect(frame).toContain('research X')
      expect(frame).toContain('compile Y')
      expect(frame).toContain('● running')
      expect(frame).toMatch(/▸ ● running\s+research X/)
      expect(frame).not.toContain('↓ to inspect') // the old persistent tray hint is gone (folded to the status bar)
    } finally {
      h.probe.destroy()
    }
  })

  test('Down with TEXT in the composer keeps its meaning (no tray focus)', async () => {
    const h = await mountApp()
    try {
      spawn(h.store, 'a1', 'research X')
      await h.probe.waitForFrame(f => f.includes('⚡'))
      await h.probe.keys.typeText('hello')
      await h.probe.settle()
      h.probe.keys.pressArrow('down')
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).toContain('hello') // text untouched
      expect(frame).not.toContain(EXPANDED_HINT)
      expect(frame).toContain('⚡') // still just the indicator
    } finally {
      h.probe.destroy()
    }
  })

  test('Down with the slash menu open stays MENU navigation (routeMenuKey pin)', async () => {
    const h = await mountApp()
    try {
      spawn(h.store, 'a1', 'research X')
      await h.probe.waitForFrame(f => f.includes('⚡'))
      await h.probe.keys.typeText('/c')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('/copy'))
      h.probe.keys.pressArrow('down') // menu: /clear → /copy (NOT the tray)
      await h.probe.settle()
      expect(h.probe.frame()).not.toContain(EXPANDED_HINT)
      h.probe.keys.pressEnter() // accepts the highlighted command
      await h.probe.settle()
      expect(h.typed.at(-1)).toBe('/copy ')
      expect(h.submitted).toEqual([])
    } finally {
      h.probe.destroy()
    }
  })

  test('Down with 0 running agents keeps prompt history as today', async () => {
    const h = await mountApp(['older prompt'])
    try {
      h.probe.keys.pressArrow('up') // recall
      await h.probe.settle()
      expect(h.probe.frame()).toContain('older prompt')
      h.probe.keys.pressArrow('down') // back to the (empty) draft — not a tray focus
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).not.toContain('older prompt')
      expect(frame).not.toContain(EXPANDED_HINT)
    } finally {
      h.probe.destroy()
    }
  })

  test('Esc from the focused tray collapses it and refocuses the composer', async () => {
    const h = await mountApp()
    try {
      spawn(h.store, 'a1', 'research X')
      await h.probe.waitForFrame(f => f.includes('⚡'))
      h.probe.keys.pressArrow('down')
      await h.probe.waitForFrame(f => f.includes(EXPANDED_HINT))
      h.probe.keys.pressEscape()
      const frame = await h.probe.waitForFrame(f => !f.includes(EXPANDED_HINT))
      expect(frame).toContain('⚡') // back to the collapsed line
      await h.probe.keys.typeText('hi') // composer has focus again
      await h.probe.settle()
      expect(h.probe.frame()).toContain('hi')
    } finally {
      h.probe.destroy()
    }
  })

  test('a printable key from the focused tray bounces to the composer AND inserts', async () => {
    const h = await mountApp()
    try {
      spawn(h.store, 'a1', 'research X')
      await h.probe.waitForFrame(f => f.includes('⚡'))
      h.probe.keys.pressArrow('down')
      await h.probe.waitForFrame(f => f.includes(EXPANDED_HINT))
      await h.probe.keys.typeText('x')
      const frame = await h.probe.waitForFrame(f => !f.includes(EXPANDED_HINT))
      expect(frame).toContain('⚡') // tray collapsed (textarea reclaimed focus)
      expect(frame).toContain('x') // …and the char landed in the composer
    } finally {
      h.probe.destroy()
    }
  })
})

describe('agents tray — Enter opens the dashboard preselected', () => {
  test('Down to the second row + Enter → dashboard open on THAT agent', async () => {
    const h = await mountApp()
    try {
      spawn(h.store, 'a1', 'research X')
      spawn(h.store, 'a2', 'compile Y')
      await h.probe.waitForFrame(f => f.includes('⚡'))
      h.probe.keys.pressArrow('down') // focus the tray (row 0)
      await h.probe.waitForFrame(f => f.includes(EXPANDED_HINT))
      h.probe.keys.pressArrow('down') // select row 1 (compile Y)
      await h.probe.settle()
      h.probe.keys.pressEnter()
      const frame = await h.probe.waitForFrame(f => f.includes('⛓ Agents'))
      expect(h.store.state.dashboard).toBe(true)
      expect(h.store.state.dashboardAgent).toBe('a2')
      expect(frame).toMatch(/▸ ● running\s+compile Y/) // master list preselected
      expect(h.submitted).toEqual([]) // Enter opened the dashboard, no submit
    } finally {
      h.probe.destroy()
    }
  })
})
