/** Native structure/data tests. Forced frames do not prove spontaneous live repaint. */
import { MarkdownRenderable, type Renderable } from '@opentui/core'
import { describe, expect, test } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { agentMessages } from '../view/overlays/agents/messages.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap(child => [child, ...descendants(child)])
}

function fixture() {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.apply({
    type: 'subagent.start',
    payload: { subagent_id: 'a1', goal: 'Inspect the release changelog and report verified changes', depth: 0 }
  })
  store.apply({
    type: 'subagent.tool',
    payload: { subagent_id: 'a1', tool_name: 'terminal', text: 'PRIVATE_TOOL_DIAGNOSTIC' }
  })
  store.openDashboard()
  const node = () => (
    <ThemeProvider theme={() => store.state.theme}>
      <App store={store} />
    </ThemeProvider>
  )
  return { store, node }
}

describe('agents message-first native view', () => {
  test('messages are primary and tool details are available but collapsed', async () => {
    const { store, node } = fixture()
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a1', summary: '**Verified** release report' } })
    const probe = await renderProbe(node, { width: 132, height: 32 })
    try {
      expect(probe.frame()).toContain('Messages')
      expect(probe.frame()).toContain('▸ Tool calls')
      expect(probe.frame()).not.toContain('PRIVATE_TOOL_DIAGNOSTIC')
      const markdown = descendants(probe.renderer.root).filter(item => item instanceof MarkdownRenderable)
      expect(markdown.filter(item => item.content === '**Verified** release report')).toHaveLength(1)
      probe.keys.pressEnter()
      probe.keys.pressKey('t')
      await probe.settle()
      expect(probe.frame()).toContain('PRIVATE_TOOL_DIAGNOSTIC')
    } finally {
      probe.destroy()
    }
  })

  test('mounted reply deltas preserve native identity, isolate siblings and finalize once', async () => {
    const { store, node } = fixture()
    store.apply({
      type: 'subagent.text',
      payload: { subagent_id: 'a1', text: '# Release\n\n| Change | State |\n| --- | --- |\n| Native' }
    })
    const probe = await renderProbe(node, { width: 132, height: 34 })
    try {
      const reply = descendants(probe.renderer.root).find(
        item => item instanceof MarkdownRenderable && item.content.startsWith('# Release')
      )
      expect(reply).toBeInstanceOf(MarkdownRenderable)
      if (!(reply instanceof MarkdownRenderable)) throw new Error('missing native reply')
      expect(reply.streaming).toBe(true)
      store.apply({ type: 'subagent.start', payload: { subagent_id: 'sibling', goal: 'Separate work', depth: 0 } })
      store.apply({ type: 'subagent.text', payload: { subagent_id: 'sibling', text: 'SIBLING_PRIVATE_REPLY' } })
      store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: ' | ready |\n' } })
      await probe.settle()
      expect(descendants(probe.renderer.root)).toContain(reply)
      expect(reply.content).toContain('| Native | ready |')
      const mounted = descendants(probe.renderer.root).filter(item => item instanceof MarkdownRenderable)
      expect(mounted.some(item => item.content === 'SIBLING_PRIVATE_REPLY')).toBe(false)
      const final = reply.content
      store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a1', summary: final } })
      await probe.settle()
      expect(reply.streaming).toBe(false)
      expect(
        descendants(probe.renderer.root).filter(item => item instanceof MarkdownRenderable && item.content === final)
      ).toHaveLength(1)
    } finally {
      probe.destroy()
    }
  })

  test('final dedupe preserves separate equal earlier replies and supports summary-only archives', () => {
    const base = { id: 'a', goal: 'Task', depth: 0, status: 'completed' }
    const final = 'Final result'
    const plan = agentMessages({
      ...base,
      summary: final,
      trace: [
        { kind: 'reply', text: final },
        { kind: 'tool', text: 'check' },
        { kind: 'reply', text: final },
        { kind: 'summary', text: final }
      ]
    })
    expect(plan.replies).toHaveLength(2)
    expect(plan.appendSummary).toBe(false)
    expect(agentMessages({ ...base, summary: final }).appendSummary).toBe(true)
    expect(
      agentMessages({ ...base, summary: 'result', traceTruncated: true, trace: [{ kind: 'reply', text: final }] })
        .appendSummary
    ).toBe(false)
    expect(agentMessages({ ...base, trace: [{ kind: 'summary', text: final }] }).summary).toBe(final)
  })
})
