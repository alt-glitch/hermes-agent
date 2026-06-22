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
  test('settled reasoning is collapsed by default, expanded when reasoningFull is on (details stays collapsed)', async () => {
    const store = createSessionStore()
    seedReasoningTurn(store)
    const probe = await mountApp(store)
    try {
      // default: collapsed — the Thought header shows the ◐ folded glyph.
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
