/**
 * Display-mode frame tests (Epic 3: /compact + /details store flags → render).
 * Headless frames through the real App tree (store → Transcript →
 * DisplayProvider → messageLine/toolPart/reasoningPart):
 *   - details collapsed (default) vs expanded vs hidden on tool + reasoning rows,
 *     including that flipping hidden back RESTORES the rows (nothing dropped),
 *   - compact collapses the blank line between messages (frame line-distance).
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

/** Seed one settled assistant turn: reasoning + a multi-line tool + answer text. */
function seedDetailedTurn(store: Store) {
  store.apply({ type: 'gateway.ready' })
  store.apply({ type: 'message.start' })
  store.apply({ payload: { text: '**Plan**\n\nthink about the steps' }, type: 'reasoning.delta' })
  store.apply({ payload: { context: 'ls -la', name: 'terminal', tool_id: 't1' }, type: 'tool.start' })
  store.apply({
    payload: {
      args: { command: 'ls -la' },
      duration_s: 0.3,
      name: 'terminal',
      result_text: 'alpha.txt\nbeta.txt\ngamma.txt',
      tool_id: 't1'
    },
    type: 'tool.complete'
  })
  store.apply({ payload: { text: 'done listing' }, type: 'message.delta' })
  store.apply({ type: 'message.complete' })
}

describe('/details — global detail mode drives default expansion (frame)', () => {
  test('collapsed (default) → headers only; expanded → tool body + reasoning preview open', async () => {
    const store = createSessionStore()
    seedDetailedTurn(store)
    store.setDetails('collapsed', true)
    const probe = await mountApp(store)
    try {
      // default: collapsed — tool body lines stay hidden, Thought folded.
      // (Markdown BODY text never paints in the headless char frame — a known
      // harness limitation, see render.test.tsx — so assertions stick to the
      // plain-text renderables: tool output lines + the ◐/▼ headers.)
      const collapsed = await probe.waitForFrame(f => f.includes('terminal'))
      expect(collapsed).toContain('◐ Thought: Plan')
      expect(collapsed).not.toContain('beta.txt')

      // /details expanded → tool body + reasoning preview default-open (no clicks)
      store.setDetails('expanded', true)
      const expanded = await probe.waitForFrame(f => f.includes('beta.txt'))
      expect(expanded).toContain('alpha.txt')
      expect(expanded).toContain('▼ Thought: Plan')

      // back to collapsed → bodies fold again
      store.setDetails('collapsed', true)
      const back = await probe.waitForFrame(f => !f.includes('beta.txt'))
      expect(back).toContain('terminal')
      expect(back).toContain('◐ Thought: Plan')
    } finally {
      probe.destroy()
    }
  })

  test('hidden → one muted run line replaces the tool+reasoning rows; flipping back restores', async () => {
    const store = createSessionStore()
    seedDetailedTurn(store)
    store.setDetails('collapsed', true)
    const probe = await mountApp(store)
    try {
      await probe.waitForFrame(f => f.includes('terminal'))
      store.setDetails('hidden', true)
      // reasoning + tool fold into ONE honest run line
      const hidden = await probe.waitForFrame(f => f.includes('hidden'))
      expect(hidden).toContain('⚡ 1 tool · 1 thought hidden — /details collapsed to show')
      expect(hidden).not.toContain('terminal')
      expect(hidden).not.toContain('Thought: Plan')
      // the parts are still in the store (folding is render-only — recoverable)
      expect((store.state.messages.at(-1)!.parts ?? []).map(p => p.type)).toEqual(['reasoning', 'tool', 'text'])

      // restore — flipping the mode back brings the rows straight back
      store.setDetails('collapsed', true)
      const restored = await probe.waitForFrame(f => f.includes('terminal'))
      expect(restored).toContain('◐ Thought: Plan')
      expect(restored).not.toContain('hidden — /details')
    } finally {
      probe.destroy()
    }
  })
  test('per-section override hides tools without hiding reasoning, then reset restores the inherited mode', async () => {
    const store = createSessionStore()
    seedDetailedTurn(store)
    store.setDetails('collapsed', true)
    const probe = await mountApp(store)
    try {
      await probe.waitForFrame(frame => frame.includes('terminal'))
      store.setDetailSection('tools', 'hidden')
      const toolsHidden = await probe.waitForFrame(frame => frame.includes('1 tool hidden'))
      expect(toolsHidden).toContain('◐ Thought: Plan')
      expect(toolsHidden).not.toContain('terminal')

      store.setDetailSection('tools', null)
      const restored = await probe.waitForFrame(frame => frame.includes('terminal'))
      expect(restored).not.toContain('1 tool hidden')
    } finally {
      probe.destroy()
    }
  })
  test('activity defaults hidden and an explicit override reveals notification cards', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushNotification({ id: 'activity-1', kind: 'task.done', level: 'info', text: 'background build finished' })
    const probe = await mountApp(store)
    try {
      await probe.settle()
      expect(probe.frame()).not.toContain('background build finished')
      store.setDetailSection('activity', 'collapsed')
      const visible = await probe.waitForFrame(frame => frame.includes('background build finished'))
      expect(visible).toContain('background build finished')
      store.setDetailSection('activity', 'hidden')
      const hidden = await probe.waitForFrame(frame => !frame.includes('background build finished'))
      expect(hidden).not.toContain('background build finished')
    } finally {
      probe.destroy()
    }
  })
})

describe('/compact — transcript spacing (frame line-count)', () => {
  test('compact on collapses the blank line between messages; off restores it', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushUser('alpha-line')
    store.pushUser('beta-line')
    const probe = await mountApp(store)
    try {
      const spaced = await probe.waitForFrame(f => f.includes('beta-line'))
      const rows = spaced.split('\n')
      const a = rows.findIndex(r => r.includes('alpha-line'))
      const b = rows.findIndex(r => r.includes('beta-line'))
      expect(a).toBeGreaterThanOrEqual(0)
      // user turns are set off by MORE space than the part gap (design pass:
      // turn boundary > part gap): top 2 + bottom 1 around each prompt, plus
      // the prompt's own `⧉ copy` footer line (chrome v3 chip placement).
      expect(b - a).toBe(5)

      store.setCompact(true)
      await probe.settle()
      const dense = probe.frame().split('\n')
      const a2 = dense.findIndex(r => r.includes('alpha-line'))
      const b2 = dense.findIndex(r => r.includes('beta-line'))
      expect(b2 - a2).toBe(1) // adjacent rows — densified (copy-chip chrome shed too)

      store.setCompact(false)
      await probe.settle()
      const again = probe.frame().split('\n')
      const a3 = again.findIndex(r => r.includes('alpha-line'))
      const b3 = again.findIndex(r => r.includes('beta-line'))
      expect(b3 - a3).toBe(5)
    } finally {
      probe.destroy()
    }
  })
})
