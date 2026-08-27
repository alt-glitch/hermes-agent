/**
 * Skill highlighting + one-edit autocorrect — composer-level tests (Epic 6).
 * Headless frames through the real App + Composer with the entry-parity onType
 * (planCompletion → fake gateway catalog → store.setCompletions), mirroring
 * slashMenu.test.tsx:
 *
 *   - `/comit` at start → the gateway prefix menu is empty, so the one-edit
 *     suggestion rides the SAME dropdown ("did you mean"); Enter accepts it and
 *     splices `/commit ` (no submit) — never auto-applied.
 *   - Esc dismisses the suggestion for that exact text (it must not re-open).
 *   - anti-jank: mid-prose typing (`use /comit here`, `see the a/b path`) never
 *     opens a menu and never autocorrects (pins the existing behavior too).
 *   - `/help` exact at start → the token is painted with the theme accent
 *     (native editBuffer highlight), asserted via styled spans.
 *
 * The learned-names catalog is module-level in the composer (it survives
 * remounts), so each test resets it.
 */
import { RGBA } from '@opentui/core'
import { beforeEach, describe, expect, test } from 'vitest'

import { createPromptHistory } from '../logic/history.ts'
import { planCompletion } from '../logic/slash.ts'
import { createSessionStore, type CompletionItem, type SessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { refreshLearnedNames, resetLearnedNames, seedLearnedNames } from '../view/composer.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

/** Fake gateway catalog (what `complete.slash` returns for a `/` prefix). */
const CATALOG: CompletionItem[] = [
  { display: '/clear', meta: 'clear the transcript', text: '/clear' },
  { display: '/commit', meta: 'commit changes', text: '/commit' },
  { display: '/copy', meta: 'copy the last response', text: '/copy' },
  { display: '/help', meta: 'list commands', text: '/help' },
  { display: '/model', meta: 'switch model', text: '/model' }
]

interface Harness {
  probe: RenderProbe
  store: SessionStore
  submitted: string[]
  typed: string[]
}

/** Mount the real App with entry-parity onType (planCompletion → fake catalog). */
async function mountComposer(): Promise<Harness> {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  const submitted: string[] = []
  const typed: string[] = []
  const history = createPromptHistory({ initial: [] })
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
    { height: 24, kittyKeyboard: true, width: 70 }
  )
  return { probe, store, submitted, typed }
}

beforeEach(() => resetLearnedNames())

describe('one-edit autocorrect rides the completion dropdown', () => {
  test('`/comit` at start → the suggestion row appears; Enter accepts → `/commit `', async () => {
    const h = await mountComposer()
    try {
      // type in two bursts (the mock coalesces a single typeText into one
      // content change): the `/c` prefix batch teaches the catalog, then the
      // menu closes (`comit` matches nothing) and the one-edit suggestion shows.
      await h.probe.keys.typeText('/c')
      await h.probe.settle()
      await h.probe.keys.typeText('omit')
      await h.probe.settle()
      const frame = await h.probe.waitForFrame(f => f.includes('did you mean'))
      expect(frame).toContain('/commit')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.typed.at(-1)).toBe('/commit ') // spliced from just past the `/`
      expect(h.submitted).toEqual([]) // accepted, never submitted/auto-applied
      expect(h.probe.frame()).not.toContain('did you mean')
    } finally {
      h.probe.destroy()
    }
  })

  test('Tab also accepts the suggestion row', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/c')
      await h.probe.settle()
      await h.probe.keys.typeText('omit')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('did you mean'))
      h.probe.keys.pressTab()
      await h.probe.settle()
      expect(h.typed.at(-1)).toBe('/commit ')
      expect(h.submitted).toEqual([])
    } finally {
      h.probe.destroy()
    }
  })

  test('Esc dismisses the suggestion and it stays dismissed for the same text', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/c')
      await h.probe.settle()
      await h.probe.keys.typeText('omit')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('did you mean'))
      h.probe.keys.pressEscape()
      const frame = await h.probe.waitForFrame(f => !f.includes('did you mean'))
      expect(frame).toContain('/comit') // text untouched — never auto-applied
      await h.probe.settle()
      expect(h.probe.frame()).not.toContain('did you mean') // does not re-open
    } finally {
      h.probe.destroy()
    }
  })

  test('`/xyzzy` (nothing within one edit) → no menu at all', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/xyzzy')
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).not.toContain('did you mean')
      expect(frame).not.toContain('Esc dismiss')
    } finally {
      h.probe.destroy()
    }
  })
})

describe('anti-jank: mid-prose never completes, never autocorrects', () => {
  test('`use /comit here` → no menu, no suggestion, text intact', async () => {
    const h = await mountComposer()
    try {
      // learn the catalog first (a prior slash interaction), then go mid-prose
      await h.probe.keys.typeText('/c')
      await h.probe.settle()
      for (let i = 0; i < 2; i++) h.probe.keys.pressBackspace()
      await h.probe.settle()
      await h.probe.keys.typeText('use /comit here')
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).toContain('use /comit here') // prose untouched
      expect(frame).not.toContain('did you mean')
      expect(frame).not.toContain('Esc dismiss') // no dropdown of any kind
      expect(h.submitted).toEqual([])
    } finally {
      h.probe.destroy()
    }
  })

  test('`see the a/b path` → nothing (paths are never tokens)', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('see the a/b path')
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).toContain('see the a/b path')
      expect(frame).not.toContain('did you mean')
      expect(frame).not.toContain('Esc dismiss')
    } finally {
      h.probe.destroy()
    }
  })
})

describe('composer reference highlight (native editBuffer ranges)', () => {
  /** Find a styled span whose text contains `needle`. */
  const findSpan = (h: Harness, needle: string) => {
    for (const line of h.probe.spans().lines) {
      for (const span of line.spans) {
        if (span.text.includes(needle)) return span
      }
    }
    return undefined
  }

  test('`/help` at start paints the token with the theme accent', async () => {
    const h = await mountComposer()
    try {
      // `/h` first so the prefix batch teaches the catalog (the mock coalesces
      // a single typeText into one content change), then complete the name.
      await h.probe.keys.typeText('/h')
      await h.probe.settle()
      await h.probe.keys.typeText('elp')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('/help'))
      const span = findSpan(h, '/help')
      expect(span).toBeDefined()
      const accent = RGBA.fromHex(h.store.state.theme.color.accent).toInts()
      const [r, g, b] = span!.fg.toInts()
      expect([r, g, b]).toEqual(accent.slice(0, 3))
    } finally {
      h.probe.destroy()
    }
  })

  test('mid-prose exact token gets highlight-only (accent), with NO menu', async () => {
    const h = await mountComposer()
    try {
      // learn the catalog, then clear back to empty
      await h.probe.keys.typeText('/h')
      await h.probe.settle()
      for (let i = 0; i < 2; i++) h.probe.keys.pressBackspace()
      await h.probe.settle()
      await h.probe.keys.typeText('use /help here')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('use /help here'))
      expect(h.probe.frame()).not.toContain('Esc dismiss') // no menu
      const span = findSpan(h, '/help')
      expect(span).toBeDefined()
      const accent = RGBA.fromHex(h.store.state.theme.color.accent).toInts()
      expect(span!.fg.toInts().slice(0, 3)).toEqual(accent.slice(0, 3))
    } finally {
      h.probe.destroy()
    }
  })

  test('a half-typed or unknown slash reference still tracks the caret in accent', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/xyzzy')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('/xyzzy'))
      const span = findSpan(h, '/xyzzy')
      expect(span).toBeDefined()
      const accent = RGBA.fromHex(h.store.state.theme.color.accent).toInts()
      expect(span!.fg.toInts().slice(0, 3)).toEqual(accent.slice(0, 3))
    } finally {
      h.probe.destroy()
    }
  })

  test('@refs and OpenTUI paste tokens paint through the native textarea', async () => {
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('inspect @file:src/a.ts [Pasted text #2 +3 lines]')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('[Pasted text #2 +3 lines]'))
      const accent = RGBA.fromHex(h.store.state.theme.color.accent).toInts()
      for (const needle of ['@file:src/a.ts', '[Pasted text #2 +3 lines]']) {
        const span = findSpan(h, needle)
        expect(span).toBeDefined()
        expect(span!.fg.toInts().slice(0, 3)).toEqual(accent.slice(0, 3))
      }
    } finally {
      h.probe.destroy()
    }
  })

  test('a seeded command supports cold autocorrect without prior prefix teaching', async () => {
    seedLearnedNames([{ text: '/handoff' }, { text: 'review' }])
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/handof')
      await h.probe.settle()
      const frame = await h.probe.waitForFrame(f => f.includes('did you mean'))
      expect(frame).toContain('/handoff')
    } finally {
      h.probe.destroy()
    }
  })

  test('a live catalog refresh removes deleted skills', async () => {
    seedLearnedNames([{ text: '/removed-skill' }])
    refreshLearnedNames([{ text: '/current-skill' }, { text: '/queue' }], ['removed-skill'])
    const h = await mountComposer()
    try {
      await h.probe.keys.typeText('/removed-skil')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('/removed-skil'))
      expect(h.probe.frame()).not.toContain('did you mean')
    } finally {
      h.probe.destroy()
    }
  })

  test('a live catalog refresh preserves a dynamically learned alias', async () => {
    seedLearnedNames([{ text: '/learning' }])
    refreshLearnedNames([{ text: '/queue' }], ['removed-skill'])
    const alias = await mountComposer()
    try {
      await alias.probe.keys.typeText('/learnin')
      await alias.probe.settle()
      const frame = await alias.probe.waitForFrame(f => f.includes('did you mean'))
      expect(frame).toContain('/learning')
    } finally {
      alias.probe.destroy()
    }
  })

  test('a live catalog refresh preserves a dynamically learned plugin command', async () => {
    seedLearnedNames([{ text: '/plugin-command' }])
    refreshLearnedNames([{ text: '/queue' }], ['removed-skill'])
    const plugin = await mountComposer()
    try {
      await plugin.probe.keys.typeText('/plugin-comman')
      await plugin.probe.settle()
      const frame = await plugin.probe.waitForFrame(f => f.includes('did you mean'))
      expect(frame).toContain('/plugin-command')
    } finally {
      plugin.probe.destroy()
    }
  })
})
