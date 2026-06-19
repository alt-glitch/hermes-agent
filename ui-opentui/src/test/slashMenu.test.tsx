/**
 * Slash-menu navigation tests (Epic 8). Two layers:
 *
 *   1. `routeMenuKey` — the pure key-routing PRECEDENCE TABLE: arrows/Enter
 *      belong to the dropdown only while it's open AND it's the slash menu
 *      (first char `/`); Tab/Esc keep their menu-wide accept/dismiss; anything
 *      else passes through to history/cursor handling.
 *   2. Headless frames through the real App + Composer with a simulated
 *      keyboard: typing `/` opens the catalog dropdown, Up/Down move the
 *      selection (wrapping), Enter accepts the HIGHLIGHTED command into the
 *      composer (no submit), Esc dismisses with the text intact, Tab still
 *      accepts (regression pin), and with no dropdown the arrows keep prompt
 *      history while Enter submits.
 *
 * The onType wiring mirrors the entry (`planCompletion` → "gateway" →
 * `store.setCompletions`) with a synchronous fake catalog, so frames are
 * deterministic.
 */
import { describe, expect, test } from 'vitest'

import { MENU_MAX, acceptChangesToken, routeMenuKey, type MenuKeyContext } from '../logic/completionMenu.ts'
import { createPromptHistory } from '../logic/history.ts'
import { planCompletion } from '../logic/slash.ts'
import { createSessionStore, type CompletionItem } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

// ── layer 1: the pure precedence table ─────────────────────────────────

const ctx = (over: Partial<MenuKeyContext> = {}): MenuKeyContext => ({
  count: 4,
  selected: 0,
  slashMenu: true,
  ...over
})

describe('routeMenuKey — key-routing precedence table', () => {
  test.each([
    // [case, key, modified, context, expected]
    ['Down moves the selection', 'down', false, ctx(), { kind: 'move', selected: 1 }],
    ['Down wraps bottom → top', 'down', false, ctx({ selected: 3 }), { kind: 'move', selected: 0 }],
    ['Up moves the selection', 'up', false, ctx({ selected: 2 }), { kind: 'move', selected: 1 }],
    ['Up wraps top → bottom', 'up', false, ctx(), { kind: 'move', selected: 3 }],
    ['Enter accepts the highlighted row', 'return', false, ctx({ selected: 2 }), { index: 2, kind: 'accept' }],
    ['Tab accepts the highlighted row', 'tab', false, ctx({ selected: 1 }), { index: 1, kind: 'accept' }],
    ['Esc dismisses', 'escape', false, ctx({ selected: 2 }), { kind: 'dismiss' }],
    // NOT the slash menu (path/@-mention dropdown): arrows + Enter keep their
    // existing meanings (history / cursor / textarea submit) …
    // glitch 2026-06-10: ANY open menu owns plain arrows/Enter (path/arg menus
    // navigate like the slash menu; Esc hands the cursor keys back).
    ['Down on a path menu moves', 'down', false, ctx({ slashMenu: false }), { kind: 'move', selected: 1 }],
    ['Up on a path menu moves (wraps)', 'up', false, ctx({ slashMenu: false }), { kind: 'move', selected: 3 }],
    [
      'Enter on a path menu accepts the highlighted item',
      'return',
      false,
      ctx({ slashMenu: false }),
      { index: 0, kind: 'accept' }
    ],
    // … but Tab/Esc keep working on ANY menu (pre-Epic-8 semantics)
    ['Tab on a path menu still accepts', 'tab', false, ctx({ slashMenu: false }), { index: 0, kind: 'accept' }],
    ['Esc on a path menu still dismisses', 'escape', false, ctx({ slashMenu: false }), { kind: 'dismiss' }],
    // closed menu: everything passes
    ['Down with no menu passes', 'down', false, ctx({ count: 0 }), { kind: 'pass' }],
    ['Enter with no menu passes', 'return', false, ctx({ count: 0 }), { kind: 'pass' }],
    ['Esc with no menu passes', 'escape', false, ctx({ count: 0 }), { kind: 'pass' }],
    // modified arrows/Enter never belong to the menu
    ['Ctrl+Down passes', 'down', true, ctx(), { kind: 'pass' }],
    ['Alt+Enter passes', 'return', true, ctx(), { kind: 'pass' }],
    // unrelated keys pass (printables refine the query via the textarea)
    ['a printable passes', 'a', false, ctx(), { kind: 'pass' }],
    ['Left passes (cursor move)', 'left', false, ctx(), { kind: 'pass' }]
  ])('%s', (_name, key, modified, context, expected) => {
    expect(routeMenuKey(key as string, modified as boolean, context as MenuKeyContext)).toEqual(expected)
  })

  test('a stranded selection clamps into the visible range before moving/accepting', () => {
    expect(routeMenuKey('down', false, ctx({ count: 2, selected: 5 }))).toEqual({ kind: 'move', selected: 0 })
    expect(routeMenuKey('return', false, ctx({ count: 2, selected: 5 }))).toEqual({ index: 1, kind: 'accept' })
  })
})

describe('acceptChangesToken — Enter-accept vs. submit (trailing-space guard)', () => {
  // Mirrors Ink domain/slash.ts completionApply tests: the engine's
  // acceptCompletion writes `before + itemText + ' '`, so the predicate is
  // computed against that exact shape (replace_from = token start).
  test('finishing a partial command name IS a real change (accept)', () => {
    // `/ex` (from=1, replace the `ex` token) → `/exit ` — meaningful.
    expect(acceptChangesToken('/ex', 'exit', 1)).toBe(true)
  })

  test('an already-complete command + trailing-space-only row is NOT a change (submit)', () => {
    // THE bug: `/exit` fully typed, gateway keeps `exit` open → accept would set
    // `/exit ` (only a trailing space) and swallow the Enter. Must submit instead.
    expect(acceptChangesToken('/exit', 'exit', 1)).toBe(false)
  })

  test('a fully-typed argument + trailing-space-only is NOT a change (submit)', () => {
    expect(acceptChangesToken('/cron add', 'add', 6)).toBe(false)
  })

  test('a real argument completion after a space IS a change (accept)', () => {
    // `/cron ad` (from=6) → `/cron add ` — finishes the arg token.
    expect(acceptChangesToken('/cron ad', 'add', 6)).toBe(true)
  })

  test('clamps an out-of-range from instead of throwing', () => {
    // from past the end clamps to length; `/exit` + 'exit' → `/exitexit ` (a change).
    expect(acceptChangesToken('/exit', 'exit', 999)).toBe(true)
  })
})

// ── layer 2: headless frames with a simulated keyboard ─────────────────

/** Fake gateway catalog (what `complete.slash` would return for a `/` prefix). */
const CATALOG: CompletionItem[] = [
  { display: '/clear', meta: 'clear the transcript', text: '/clear' },
  { display: '/copy', meta: 'copy the last response', text: '/copy' },
  { display: '/help', meta: 'list commands', text: '/help' },
  { display: '/model', meta: 'switch model', text: '/model' }
]

interface Harness {
  probe: RenderProbe
  submitted: string[]
  typed: string[]
}

/** Mount the real App with entry-parity onType (planCompletion → fake catalog). */
async function mountComposer(historyEntries: string[] = []): Promise<Harness> {
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
        <App store={store} onSubmit={t => submitted.push(t)} onType={onType} history={history} />
      </ThemeProvider>
    ),
    // kitty keyboard: a SIMULATED lone ESC never parses under legacy input (it
    // sits in the escape-sequence ambiguity window), and the Esc test needs it.
    { height: 24, kittyKeyboard: true, width: 70 }
  )
  return { probe, submitted, typed }
}

describe('slash menu — opens on the first slash, hydrating the full command list', () => {
  test('a bare `/` opens the menu immediately (hydrate on first slash — glitch 2026-06-13)', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/')
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).toContain('/clear')
      expect(frame).toContain('Esc dismiss')
    } finally {
      h.probe.destroy()
    }
  })

  test('`/c` shows the matching candidates + the nav hint', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/c')
      await h.probe.settle()
      const frame = await h.probe.waitForFrame(f => f.includes('/clear'))
      expect(frame).toContain('/copy')
      expect(frame).not.toContain('/help') // filtered out by the `/c` prefix
      expect(frame).toContain('↑/↓ select')
    } finally {
      h.probe.destroy()
    }
  })

  test('`/` mid-prose (not the first char) does NOT open the slash menu', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('say /')
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).not.toContain('/clear')
      expect(frame).not.toContain('Esc dismiss')
      expect(frame).toContain('say /') // the prose stays in the composer
    } finally {
      h.probe.destroy()
    }
  })
})

describe('slash menu — arrow navigation + Enter accept', () => {
  test('ArrowDown moves the selection; Enter accepts the highlighted command (no submit)', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/c') // → /clear, /copy
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('/copy'))
      h.probe.keys.pressArrow('down') // /clear → /copy
      await h.probe.settle()
      h.probe.keys.pressEnter()
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).toContain('/copy') // spliced into the composer …
      expect(frame).not.toContain('Esc dismiss') // … and the menu is gone
      expect(h.submitted).toEqual([]) // Enter ACCEPTED, did not submit
      expect(h.typed.at(-1)).toBe('/copy ') // trailing space → arg-completion re-query ran
    } finally {
      h.probe.destroy()
    }
  })

  test('ArrowUp from the top wraps to the LAST candidate', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/c') // → /clear, /copy
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('/copy'))
      h.probe.keys.pressArrow('up') // wraps 0 → 1 (/copy)
      await h.probe.settle()
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.typed.at(-1)).toBe('/copy ')
      expect(h.submitted).toEqual([])
    } finally {
      h.probe.destroy()
    }
  })

  test('ArrowDown past the bottom wraps to the FIRST candidate', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/c') // → /clear, /copy
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('/copy'))
      for (let i = 0; i < 2; i++) h.probe.keys.pressArrow('down') // 0→1→0
      await h.probe.settle()
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.typed.at(-1)).toBe('/clear ')
      expect(h.submitted).toEqual([])
    } finally {
      h.probe.destroy()
    }
  })
})

describe('slash menu — Esc / Tab / no-dropdown routing', () => {
  test('Esc closes the dropdown and leaves the composer text intact', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/he')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('list commands'))
      h.probe.keys.pressEscape()
      // a lone ESC byte sits in the parser's ambiguity window for a tick — wait
      // for the dismissal to land rather than asserting the very next frame
      const frame = await h.probe.waitForFrame(f => !f.includes('list commands'))
      expect(frame).not.toContain('list commands') // menu row gone
      expect(frame).not.toContain('Esc dismiss') // hint gone
      expect(frame).toContain('/he') // text untouched
      expect(h.submitted).toEqual([])
    } finally {
      h.probe.destroy()
    }
  })

  test('Tab still accepts (regression pin) and Enter then submits the command', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/he')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('list commands'))
      h.probe.keys.pressTab()
      await h.probe.settle()
      expect(h.typed.at(-1)).toBe('/help ') // accepted with the trailing space
      h.probe.keys.pressEnter() // no dropdown now → submit as today
      await h.probe.settle()
      expect(h.submitted).toEqual(['/help'])
    } finally {
      h.probe.destroy()
    }
  })

  test('Enter on an already-complete command SUBMITS even when the menu stays open (no trailing-space swallow)', async () => {
    // Reproduces the real gateway behavior the Ink fix targeted: once the
    // command name is fully typed, the gateway KEEPS the completion row open
    // (returns the same `/help` row so the classic-CLI dropdown stays up). The
    // engine must NOT let that open menu swallow the Enter into `/help ` — the
    // command is complete, so Enter submits. (mountComposer's onType closes the
    // menu on an exact match, which hides the bug, so this harness mirrors the
    // gateway and keeps the row open on an exact match.)
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const submitted: string[] = []
    const onType = (text: string) => {
      const plan = planCompletion(text)
      if (!plan || plan.method !== 'complete.slash') return store.clearCompletions()
      const q = String(plan.params.text).toLowerCase()
      // Gateway-faithful: an EXACT match keeps its row open (drops only the
      // `c.text !== q` guard mountComposer uses), so the dropdown is still up
      // when Enter arrives on the complete command.
      const items = CATALOG.filter(c => c.text.startsWith(q))
      if (items.length) store.setCompletions(items, plan.from)
      else store.clearCompletions()
    }
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} onSubmit={t => submitted.push(t)} onType={onType} history={createPromptHistory({})} />
        </ThemeProvider>
      ),
      { height: 24, kittyKeyboard: true, width: 70 }
    )
    try {
      await probe.keys.typeText('/help')
      await probe.settle()
      // the menu is STILL open on the exact command (the gateway behavior)
      await probe.waitForFrame(f => f.includes('list commands'))
      probe.keys.pressEnter()
      await probe.settle()
      // THE fix: Enter submitted the complete command instead of being eaten.
      expect(submitted).toEqual(['/help'])
    } finally {
      probe.destroy()
    }
  })

  test('with NO dropdown, Up/Down recall prompt history and Enter submits', async () => {
    const h = await mountComposer(['first prompt', 'second prompt'])
    try {
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('second prompt')
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('first prompt')
      h.probe.keys.pressArrow('down')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('second prompt')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.submitted).toEqual(['second prompt'])
    } finally {
      h.probe.destroy()
    }
  })

  test('arrows while the slash menu is open do NOT touch prompt history', async () => {
    const h = await mountComposer(['older prompt'])
    try {
      await h.probe.keys.typeText('/c')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('/copy'))
      h.probe.keys.pressArrow('up') // menu nav (wraps), NOT history
      await h.probe.settle()
      expect(h.probe.frame()).not.toContain('older prompt')
    } finally {
      h.probe.destroy()
    }
  })

  test('the dropdown caps at MENU_MAX rows', () => {
    expect(MENU_MAX).toBe(8) // the view slices candidates to this
  })
})
