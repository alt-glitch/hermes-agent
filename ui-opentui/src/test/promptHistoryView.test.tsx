/**
 * Composer/keymap-level tests for the Esc+Esc session prompt viewer (Epic 5):
 * headless frames through the real App + Composer with a simulated keyboard.
 *
 *   - Esc+Esc on an EMPTY composer (session has prompts) opens the viewer,
 *     newest first with the ▶ pointer; a single Esc opens nothing.
 *   - Esc+Esc with text in the composer does nothing.
 *   - Esc+Esc on an empty session does nothing (no empty modal).
 *   - An Esc that dismissed the completion dropdown does NOT arm the
 *     double-press (the pre-existing Esc semantics compose, never regress).
 *   - Enter → confirm step (BOTH options on the latest entry; Rollback ONLY on
 *     an older one) → Esc backs out to the list → Esc closes (composer back).
 *   - Confirming dispatches /undo · /rollback through the App's submit path.
 *
 * The onType wiring mirrors the entry (`planCompletion` → fake catalog →
 * `store.setCompletions`), same as slashMenu.test.tsx, so frames are
 * deterministic. kittyKeyboard: a simulated lone ESC only parses there.
 */
import { describe, expect, test } from 'vitest'

import { ROLLBACK_LABEL, UNDO_LABEL } from '../logic/promptHistory.ts'
import { planCompletion } from '../logic/slash.ts'
import { createSessionStore, type CompletionItem, type SessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

/** Fake gateway catalog (what `complete.slash` would return for a `/` prefix). */
const CATALOG: CompletionItem[] = [
  { display: '/clear', meta: 'clear the transcript', text: '/clear' },
  { display: '/help', meta: 'list commands', text: '/help' }
]

interface Harness {
  probe: RenderProbe
  store: SessionStore
  submitted: string[]
}

/** Mount the real App; `prompts` seeds this session's user turns (+ replies). */
async function mount(prompts: string[] = []): Promise<Harness> {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  for (const p of prompts) {
    store.pushUser(p)
    store.apply({ type: 'message.start' })
    store.apply({ payload: { text: `reply to ${p}` }, type: 'message.delta' })
    store.apply({ type: 'message.complete' })
  }
  const submitted: string[] = []
  const onType = (text: string) => {
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
        <App store={store} onSubmit={t => void submitted.push(t)} onType={onType} />
      </ThemeProvider>
    ),
    { height: 30, kittyKeyboard: true, width: 80 }
  )
  return { probe, store, submitted }
}

/** Esc twice (within the 800ms window — real time in-test is milliseconds). */
async function doubleEsc(h: Harness): Promise<void> {
  h.probe.keys.pressEscape()
  await h.probe.settle()
  h.probe.keys.pressEscape()
  await h.probe.settle()
}

/** Let a deferClose (setTimeout 0) land, then settle a frame. */
async function settleClose(h: Harness): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1))
  await h.probe.settle()
}

describe('Esc+Esc — opening the viewer', () => {
  test('double Esc on an empty composer opens the viewer, newest first with ▶', async () => {
    const h = await mount(['first prompt', 'second prompt', 'third prompt'])
    try {
      await doubleEsc(h)
      const frame = await h.probe.waitForFrame(f => f.includes('⟲ Rewind'))
      expect(h.store.state.promptHistory).toBe(true)
      // newest first: the latest prompt carries the pointer + the (latest) tag
      expect(frame).toContain('▶ third prompt')
      expect(frame).toContain('(latest)')
      expect(frame).toContain('second prompt')
      expect(frame).toContain('first prompt')
    } finally {
      h.probe.destroy()
    }
  })

  test('a single Esc opens nothing', async () => {
    const h = await mount(['a prompt'])
    try {
      h.probe.keys.pressEscape()
      await h.probe.settle()
      expect(h.store.state.promptHistory).toBe(false)
      expect(h.probe.frame()).not.toContain('⟲ Rewind')
    } finally {
      h.probe.destroy()
    }
  })

  test('Esc+Esc with text in the composer does nothing', async () => {
    const h = await mount(['a prompt'])
    try {
      await h.probe.keys.typeText('draft text')
      await h.probe.settle()
      await doubleEsc(h)
      expect(h.store.state.promptHistory).toBe(false)
      expect(h.probe.frame()).toContain('draft text') // composer untouched
    } finally {
      h.probe.destroy()
    }
  })

  test('Esc+Esc on an empty session does nothing (no empty modal)', async () => {
    const h = await mount([])
    try {
      await doubleEsc(h)
      expect(h.store.state.promptHistory).toBe(false)
      expect(h.probe.frame()).not.toContain('⟲ Rewind')
    } finally {
      h.probe.destroy()
    }
  })

  test('an Esc that dismissed the completion dropdown does NOT arm the double-press', async () => {
    const h = await mount(['a prompt'])
    try {
      await h.probe.keys.typeText('/c')
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('/clear')) // dropdown open
      h.probe.keys.pressEscape() // consumed: dismisses the dropdown
      await h.probe.settle()
      expect(h.probe.frame()).not.toContain('/clear')
      h.probe.keys.pressEscape() // quick second Esc — must NOT open the viewer
      await h.probe.settle()
      expect(h.store.state.promptHistory).toBe(false)
      expect(h.probe.frame()).not.toContain('⟲ Rewind')
    } finally {
      h.probe.destroy()
    }
  })
})

describe('viewer — confirm step and dispatch', () => {
  test('Enter on the LATEST entry shows BOTH options; Esc backs out; Esc closes', async () => {
    const h = await mount(['first prompt', 'second prompt'])
    try {
      await doubleEsc(h)
      await h.probe.waitForFrame(f => f.includes('⟲ Rewind'))
      h.probe.keys.pressEnter() // latest entry → confirm
      await h.probe.settle()
      const confirm = h.probe.frame()
      expect(confirm).toContain(UNDO_LABEL)
      expect(confirm).toContain(ROLLBACK_LABEL)
      h.probe.keys.pressEscape() // back to the list, NOT closed
      await h.probe.settle()
      expect(h.store.state.promptHistory).toBe(true)
      expect(h.probe.frame()).toContain('▶ second prompt')
      h.probe.keys.pressEscape() // now closes
      await settleClose(h)
      expect(h.store.state.promptHistory).toBe(false)
      expect(h.probe.frame()).not.toContain('⟲ Rewind')
      expect(h.submitted).toEqual([]) // nothing was dispatched
    } finally {
      h.probe.destroy()
    }
  })

  test('an OLDER entry hides Undo — Rollback only', async () => {
    const h = await mount(['first prompt', 'second prompt'])
    try {
      await doubleEsc(h)
      await h.probe.waitForFrame(f => f.includes('⟲ Rewind'))
      h.probe.keys.pressArrow('down') // newest → older (first prompt)
      await h.probe.settle()
      expect(h.probe.frame()).toContain('▶ first prompt')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      const confirm = h.probe.frame()
      expect(confirm).toContain(ROLLBACK_LABEL)
      expect(confirm).not.toContain(UNDO_LABEL)
    } finally {
      h.probe.destroy()
    }
  })

  test('confirming Undo on the latest entry dispatches /undo through the submit path', async () => {
    const h = await mount(['only prompt'])
    try {
      await doubleEsc(h)
      await h.probe.waitForFrame(f => f.includes('⟲ Rewind'))
      h.probe.keys.pressEnter() // confirm step (Undo highlighted first)
      await h.probe.settle()
      h.probe.keys.pressEnter() // confirm Undo
      await settleClose(h)
      expect(h.submitted).toEqual(['/undo'])
      expect(h.store.state.promptHistory).toBe(false)
    } finally {
      h.probe.destroy()
    }
  })

  test('confirming Rollback dispatches /rollback', async () => {
    const h = await mount(['first prompt', 'second prompt'])
    try {
      await doubleEsc(h)
      await h.probe.waitForFrame(f => f.includes('⟲ Rewind'))
      h.probe.keys.pressArrow('down') // older entry → Rollback is the only option
      await h.probe.settle()
      h.probe.keys.pressEnter()
      await h.probe.settle()
      h.probe.keys.pressEnter()
      await settleClose(h)
      expect(h.submitted).toEqual(['/rollback'])
      expect(h.store.state.promptHistory).toBe(false)
    } finally {
      h.probe.destroy()
    }
  })
})
