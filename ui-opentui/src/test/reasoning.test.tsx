/**
 * /reasoning full|clamp — the reasoningFull display flag (store round-trip) +
 * the render effect: a SETTLED reasoning section is collapsed by default (◐
 * Thought header, body folded) but EXPANDED (▼ Thought header) when reasoningFull
 * is on — INDEPENDENTLY of the global /details mode (still `collapsed` here).
 *
 * (The Markdown BODY text never paints in the headless char frame — a known
 * harness limitation, see displayModes.test.tsx — so the expand assertion sticks
 * to the ◐/▼ glyph swap in the Thought header, the same signal that test uses.)
 */
import { describe, expect, test } from 'vitest'

import { REASONING_TAIL_BOUND } from '../logic/reasoningTail.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

type Store = ReturnType<typeof createSessionStore>

async function mountApp(store: Store, width = 80, height = 30): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} />
      </ThemeProvider>
    ),
    { height, width }
  )
}

/** Seed one settled assistant turn carrying a reasoning section. */
function seedReasoningTurn(store: Store) {
  store.apply({ type: 'gateway.ready' })
  store.apply({ type: 'message.start' })
  store.apply({ payload: { text: '**Plan**\n\nthink about the steps' }, type: 'reasoning.delta' })
  store.apply({ payload: { text: 'done' }, type: 'message.delta' })
  store.apply({ type: 'message.complete' })
}

describe('reasoningFull store flag', () => {
  test('defaults false and setReasoningFull round-trips', () => {
    const store = createSessionStore()
    expect(store.state.reasoningFull).toBe(false)
    store.setReasoningFull(true)
    expect(store.state.reasoningFull).toBe(true)
    store.setReasoningFull(false)
    expect(store.state.reasoningFull).toBe(false)
  })
})

describe('/reasoning full — expands all thinking (frame)', () => {
  test('MoA reference blocks follow the subagents override independently of global details', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({
      type: 'moa.reference',
      payload: { count: 2, index: 1, label: 'provider/model-a', text: 'Paris.' }
    })
    store.apply({ type: 'message.complete' })
    store.setDetails('hidden', true)
    store.setDetailSection('subagents', 'collapsed')
    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(value => value.includes('Reference 1/2 — provider/model-a'))
      expect(frame).toContain('Thought: Reference 1/2 — provider/model-a')
      expect(frame).not.toContain('thought hidden')
    } finally {
      probe.destroy()
    }
  })

  test('reasoningFull expands an explicitly collapsed thinking section without changing global details', async () => {
    const store = createSessionStore()
    seedReasoningTurn(store)
    store.setDetailSection('thinking', 'collapsed')
    const probe = await mountApp(store)
    try {
      // Explicit thinking override collapses the Thought header (the built-in default is expanded).
      const collapsed = await probe.waitForFrame(f => f.includes('Thought: Plan'))
      expect(collapsed).toContain('◐ Thought: Plan')
      expect(store.state.details).toBe('collapsed')

      // /reasoning full → the section expands (▼ glyph) WITHOUT touching /details.
      store.setReasoningFull(true)
      const expanded = await probe.waitForFrame(f => f.includes('▼ Thought: Plan'))
      expect(expanded).toContain('▼ Thought: Plan')
      expect(store.state.details).toBe('collapsed')

      // /reasoning clamp → folds back to the ◐ collapsed header.
      store.setReasoningFull(false)
      const back = await probe.waitForFrame(f => f.includes('◐ Thought: Plan'))
      expect(back).toContain('◐ Thought: Plan')
    } finally {
      probe.destroy()
    }
  })
})

describe('long reasoning stream — bounded live render (upstream 64882bc6 port)', () => {
  test('a >24k accumulated stream keeps the head title in the header while the store keeps the full text', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ payload: { text: '**Deep Plan**\n\n' }, type: 'reasoning.delta' })
    const chunk = 'weighing the options over and over again to pick a path\n'
    for (let i = 0; i < 500; i++) store.apply({ payload: { text: chunk }, type: 'reasoning.delta' })
    store.apply({ payload: { text: 'UNIQUE-TAIL-MARKER-7f3a' }, type: 'reasoning.delta' })
    store.apply({ payload: { text: 'done' }, type: 'message.delta' })
    store.apply({ type: 'message.complete' })

    // Store contract intact: the full accumulated text lives in the ordered
    // parts — the tail bound is a VIEW-side window, never a store truncation.
    const parts = store.state.messages.at(-1)?.parts ?? []
    const reasoning = parts.find(p => p.type === 'reasoning')
    expect(reasoning?.text.length).toBeGreaterThan(REASONING_TAIL_BOUND)
    expect(reasoning?.text.startsWith('**Deep Plan**')).toBe(true)
    expect(reasoning?.text.endsWith('UNIQUE-TAIL-MARKER-7f3a')).toBe(true)

    // The title lives at the HEAD of the string — outside the tail window — so
    // this frame assertion regresses if the bound ever slices it away. Collapse
    // the section so the one header row is on-screen (an expanded 24k body
    // scrolls the header out of a 30-row viewport; the markdown body itself
    // never paints headlessly — see displayModes.test.tsx).
    store.setDetailSection('thinking', 'collapsed')
    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('Thought: Deep Plan'))
      expect(frame).toContain('◐ Thought: Deep Plan')
    } finally {
      probe.destroy()
    }
  })

  test('a short titled stream renders the header unchanged (short path untouched)', async () => {
    const store = createSessionStore()
    seedReasoningTurn(store)
    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('Thought: Plan'))
      expect(frame).toContain('Thought: Plan')
    } finally {
      probe.destroy()
    }
  })
})
