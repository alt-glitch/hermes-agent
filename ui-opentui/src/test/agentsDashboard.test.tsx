/**
 * Agents dashboard (P2 de-crowd) — the master list is ONE line per subagent
 * (long goals truncate, no multi-line prompt dump) and the detail pane renders
 * the TYPED trace by kind (⚡ tool / · progress / ✓ summary).
 */
import { describe, expect, test } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame } from './lib/render.ts'

const LONG_GOAL =
  'Poll the current UTC time 10 times with a 3-second sleep between each poll, run date -u and record each result, then report all ten timestamps as a timing exercise'

function dash() {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.apply({
    type: 'subagent.start',
    payload: { subagent_id: 'a1', goal: LONG_GOAL, model: 'anthropic/claude-opus-4-8', depth: 0 }
  })
  store.apply({ type: 'subagent.tool', payload: { subagent_id: 'a1', tool_name: 'terminal', text: 'date -u' } })
  store.apply({ type: 'subagent.progress', payload: { subagent_id: 'a1', text: 'poll 4 of 10 recorded' } })
  store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a1', summary: 'all ten timestamps collected' } })
  store.openDashboard()
  return () => (
    <ThemeProvider theme={() => store.state.theme}>
      <App store={store} />
    </ThemeProvider>
  )
}

describe('agents dashboard de-crowd (P2)', () => {
  test('a long goal is truncated to one line in the master list (no full-prompt wall)', async () => {
    const frame = await captureFrame(dash(), { until: 'Agents', width: 116, height: 30 })
    // The master row truncates to one line — the head shows with an ellipsis.
    // (The detail pane below still shows the full goal; that's the inspect half.)
    expect(frame).toContain('Poll the current UTC time')
    expect(frame).toContain('…') // ellipsis proves the master row is one-line, not a wrapped wall
  })

  test('the detail pane renders the typed trace by kind (tool ⚡, summary ✓)', async () => {
    const frame = await captureFrame(dash(), { until: 'Agents', width: 116, height: 30 })
    expect(frame).toContain('⚡') // tool entry glyph
    expect(frame).toContain('terminal — date -u') // tool entry text
    expect(frame).toContain('✓') // summary entry glyph
    expect(frame).toContain('all ten timestamps collected') // summary text (detail, not master)
    expect(frame).toContain('poll 4 of 10 recorded') // progress entry
  })

  test('a streamed subagent reply renders as a coalesced ❯ reply line (subagent.text)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({
      type: 'subagent.start',
      payload: { subagent_id: 'a1', goal: 'summarize the changelog', model: 'anthropic/claude-opus-4-8', depth: 0 }
    })
    // per-token reply mirror — three frames the server emits one token at a time
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: 'The release ' } })
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: 'ships two ' } })
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: 'features.' } })
    store.openDashboard()
    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'Agents', width: 116, height: 30 }
    )
    expect(frame).toContain('❯') // reply entry glyph (terminal-safe single-width, not a color emoji)
    // the three per-token frames COALESCED into one line, not three '❯' rows
    expect(frame).toContain('The release ships two features.')
    expect(frame.split('❯').length - 1).toBe(1) // exactly one reply glyph in the frame
  })
})
