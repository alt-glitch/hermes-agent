/**
 * Model picker → reasoning-effort stage hand-off through the REAL App overlay
 * slot (upstream 2c0bec33f9c6 ported natively). The stage-1 pick opens
 * stage 2 synchronously in the same `picker` slot, and the deferred close of
 * stage 1 must not take stage 2 with it. Two seams carry that:
 *   - `store.openPicker` REPLACES the picker object (a merge would keep stage 1's
 *     identity), and `store.closePicker(expected)` only closes its own stage;
 *   - App's `<Match keyed>` remounts the Picker for the new object, so stage 2
 *     starts with a fresh query/selection instead of stage 1's typed filter.
 */
import { describe, expect, test } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

describe('model picker → effort stage (App overlay slot)', () => {
  test('picking a model swaps the slot to the effort ladder; Enter on it performs the one switch', async () => {
    const store = createSessionStore()
    store.adoptFreshSession('sid-1')
    const switched: string[] = []
    const openEffort = (model: string) =>
      store.openPicker({
        initialTab: 'all',
        items: [
          { label: 'high', value: 'high' },
          { label: 'Keep current effort', value: '' }
        ],
        onPick: effort => switched.push(effort ? `${model} --reasoning ${effort}` : model),
        title: `Reasoning effort for ${model}`
      })
    store.openPicker({
      initialTab: 'all',
      items: [
        { group: 'Anthropic', label: 'claude-opus-4.6', value: 'claude-opus-4.6 --provider anthropic' },
        { group: 'Anthropic', label: 'claude-sonnet-4.6', value: 'claude-sonnet-4.6 --provider anthropic' }
      ],
      onPick: openEffort,
      title: 'Switch model'
    })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 100 }
    )
    try {
      await probe.waitForFrame(f => f.includes('Switch model'))
      // Narrow stage 1 with a typed query, then pick: stage 2 must not inherit "opus".
      await probe.keys.typeText('opus')
      await probe.settle()
      probe.keys.pressEnter()
      // the deferred stage-1 close fires on the next tick — stage 2 survives it
      await new Promise(r => setTimeout(r, 5))
      const frame = await probe.waitForFrame(f => f.includes('Reasoning effort for claude-opus-4.6'))
      expect(frame).not.toContain('Switch model')
      expect(frame).toContain('high')
      expect(frame).toContain('Keep current effort')
      expect(switched).toEqual([])
      expect(store.state.picker?.title).toBe('Reasoning effort for claude-opus-4.6 --provider anthropic')
      // fresh mount: the first ladder row is selected, not a stale "opus" filter
      probe.keys.pressEnter()
      await new Promise(r => setTimeout(r, 5))
      await probe.settle()
      expect(switched).toEqual(['claude-opus-4.6 --provider anthropic --reasoning high'])
      expect(store.state.picker).toBeUndefined()
    } finally {
      probe.destroy()
    }
  })
})
