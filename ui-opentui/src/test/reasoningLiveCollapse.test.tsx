/**
 * Per-reasoning-phase collapse (upstream 2b0b4a219195 adaptation). Under the
 * DEFAULT display mode only the currently-LIVE reasoning part stays expanded:
 * the moment a later tool/text part begins in the same streaming turn, the
 * earlier reasoning part folds to its `◐ Thought` header. `/details expanded`
 * and `/reasoning full` still force settled reasoning open; a settled or
 * historical turn renders collapsed.
 *
 * (The Markdown BODY never paints in the headless char frame — the known
 * harness limitation, see displayModes.test.tsx — so all expansion assertions
 * ride the ▼/◐ glyph + Thinking/Thought label swap in the header, which are
 * plain <text>/<span> chrome and DO paint.)
 */
import { describe, expect, test } from 'vitest'

import { createSessionStore, type Part } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { isLiveReasoningPart } from '../view/messageLine.tsx'
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

describe('isLiveReasoningPart (pure)', () => {
  const parts: Part[] = [
    { id: 'r1', text: 'first thoughts', type: 'reasoning' },
    { id: 't1', name: 'terminal', state: 'running', type: 'tool' },
    { id: 'r2', text: 'second thoughts', type: 'reasoning' }
  ]

  test('only the LAST part of a streaming turn is live', () => {
    expect(isLiveReasoningPart(parts, 'r2', true)).toBe(true)
    expect(isLiveReasoningPart(parts, 'r1', true)).toBe(false)
    expect(isLiveReasoningPart(parts, 't1', true)).toBe(false)
  })

  test('nothing is live once the turn settles (or never streamed)', () => {
    expect(isLiveReasoningPart(parts, 'r2', false)).toBe(false)
    expect(isLiveReasoningPart(parts, 'r2', undefined)).toBe(false)
  })

  test('empty/absent parts are never live', () => {
    expect(isLiveReasoningPart([], 'r1', true)).toBe(false)
    expect(isLiveReasoningPart(undefined, 'r1', true)).toBe(false)
  })
})

describe('default mode — live reasoning open, folds when the phase ends (frame)', () => {
  test('streaming reasoning is expanded; a tool.start folds it immediately mid-turn', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ payload: { text: '**Plan A**\n\nthinking hard about it' }, type: 'reasoning.delta' })
    const probe = await mountApp(store)
    try {
      // live phase → expanded header, present-tense label.
      const live = await probe.waitForFrame(f => f.includes('Thinking: Plan A'))
      expect(live).toContain('▼ Thinking: Plan A')

      // the reasoning phase ends the moment a tool part begins — the earlier
      // reasoning part folds NOW, while the turn is still streaming.
      store.apply({ payload: { context: 'ls', name: 'terminal', tool_id: 't1' }, type: 'tool.start' })
      const folded = await probe.waitForFrame(f => f.includes('◐ Thought: Plan A'))
      expect(folded).toContain('◐ Thought: Plan A')
      expect(folded).not.toContain('▼ Thinking: Plan A')
      expect(store.state.messages.at(-1)?.streaming).toBe(true)
    } finally {
      probe.destroy()
    }
  })

  test('a second reasoning phase goes live while the first stays folded', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ payload: { text: '**Plan A**\n\nfirst pass' }, type: 'reasoning.delta' })
    store.apply({ payload: { context: 'ls', name: 'terminal', tool_id: 't1' }, type: 'tool.start' })
    store.apply({
      payload: { args: { command: 'ls' }, name: 'terminal', result_text: 'ok', tool_id: 't1' },
      type: 'tool.complete'
    })
    store.apply({ payload: { text: '**Plan B**\n\nsecond pass' }, type: 'reasoning.delta' })
    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('Thinking: Plan B'))
      expect(frame).toContain('◐ Thought: Plan A') // sealed earlier phase
      expect(frame).toContain('▼ Thinking: Plan B') // the one live phase
    } finally {
      probe.destroy()
    }
  })

  test('final answer text folds the live reasoning; the settled turn stays collapsed by default', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ payload: { text: '**Plan A**\n\nthinking' }, type: 'reasoning.delta' })
    const probe = await mountApp(store)
    try {
      await probe.waitForFrame(f => f.includes('▼ Thinking: Plan A'))
      // the answer beginning ends the reasoning phase mid-turn…
      store.apply({ payload: { text: 'The answer.' }, type: 'message.delta' })
      const folded = await probe.waitForFrame(f => f.includes('◐ Thought: Plan A'))
      expect(folded).toContain('◐ Thought: Plan A')
      // …and settling keeps it collapsed (historical turns render the same way).
      store.apply({ type: 'message.complete' })
      const settled = await probe.waitForFrame(f => f.includes('◐ Thought: Plan A'))
      expect(settled).toContain('◐ Thought: Plan A')
    } finally {
      probe.destroy()
    }
  })

  test('/details expanded and /reasoning full still expand SETTLED reasoning', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ payload: { text: '**Plan A**\n\nthinking' }, type: 'reasoning.delta' })
    store.apply({ payload: { text: 'done' }, type: 'message.delta' })
    store.apply({ type: 'message.complete' })
    const probe = await mountApp(store)
    try {
      const collapsed = await probe.waitForFrame(f => f.includes('◐ Thought: Plan A'))
      expect(collapsed).toContain('◐ Thought: Plan A')

      store.setDetails('expanded', true)
      const expanded = await probe.waitForFrame(f => f.includes('▼ Thought: Plan A'))
      expect(expanded).toContain('▼ Thought: Plan A')

      store.setDetails('collapsed', true)
      await probe.waitForFrame(f => f.includes('◐ Thought: Plan A'))

      store.setReasoningFull(true)
      const full = await probe.waitForFrame(f => f.includes('▼ Thought: Plan A'))
      expect(full).toContain('▼ Thought: Plan A')
    } finally {
      probe.destroy()
    }
  })
})
