/**
 * StatusLine timer-lifecycle invariant (skins-spec §5b gate): the animated busy
 * indicator's interval MUST be ARMED only while info.running and CLEARED when it
 * flips false / on unmount — never a permanent timer (which would fight the
 * windowing poll + defeat idle-GC). Asserted by spying setInterval/clearInterval
 * around the store's running flag and checking the armed/cleared balance.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { StatusLine } from '../view/statusLine.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

describe('StatusLine — spinner timer lifecycle (no permanent timer)', () => {
  let probe: RenderProbe | undefined
  afterEach(() => {
    probe?.destroy()
    probe = undefined
    vi.restoreAllMocks()
  })

  test('interval armed only while info.running; cleared when it flips false', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const store = createSessionStore()

    probe = await renderProbe(() => (
      <ThemeProvider theme={() => store.state.theme}>
        <StatusLine store={store} />
      </ThemeProvider>
    ))

    const armedAtIdle = setSpy.mock.calls.length // idle: no spinner interval

    store.apply({ type: 'message.start' })
    await probe.settle()
    const armedRunning = setSpy.mock.calls.length
    expect(armedRunning).toBeGreaterThan(armedAtIdle) // a timer was armed on running

    const clearedBefore = clearSpy.mock.calls.length
    store.apply({ type: 'message.complete', payload: { text: 'done' } })
    await probe.settle()
    // flipping running false disposes the prior effect-run → clearInterval fires
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearedBefore)
  })

  test('idle compaction arms the interval and freezes the verb on "compacting"; compacted disarms', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const store = createSessionStore()

    probe = await renderProbe(() => (
      <ThemeProvider theme={() => store.state.theme}>
        <StatusLine store={store} />
      </ThemeProvider>
    ))

    const armedAtIdle = setSpy.mock.calls.length

    // Idle compaction: no turn is running, yet the spinner must be visible.
    store.apply({ type: 'status.update', payload: { kind: 'compacting', text: 'Compacting context (idle)…' } })
    await probe.settle()
    expect(store.state.info.running).not.toBe(true)
    expect(setSpy.mock.calls.length).toBeGreaterThan(armedAtIdle) // timer armed while idle-compacting
    expect(probe.frame()).toContain('compacting') // the frozen verb…
    expect(probe.frame()).not.toContain('Compacting context') // …not the raw lifecycle text

    // Later transient traffic must not unfreeze the verb.
    store.apply({ type: 'thinking.delta', payload: { text: 'pondering deeply' } })
    await probe.settle()
    expect(probe.frame()).toContain('compacting')
    expect(probe.frame()).not.toContain('pondering deeply')

    // A hint still occludes the spinner while the latch is set.
    store.setHint('Ctrl+C again to quit')
    await probe.settle()
    expect(probe.frame()).toContain('Ctrl+C again to quit')
    expect(probe.frame()).not.toContain('compacting')
    store.setHint(undefined)
    await probe.settle()
    expect(probe.frame()).toContain('compacting')

    const clearedBefore = clearSpy.mock.calls.length
    store.apply({ type: 'status.update', payload: { kind: 'compacted', text: '✓ context compacted' } })
    await probe.settle()
    // dropping the latch disposes the effect-run → clearInterval fires
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearedBefore)
    expect(probe.frame()).not.toContain('compacting')
  })

  test('unmount mid-compaction clears the interval (cleanup/disarm)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const store = createSessionStore()

    probe = await renderProbe(() => (
      <ThemeProvider theme={() => store.state.theme}>
        <StatusLine store={store} />
      </ThemeProvider>
    ))

    store.apply({ type: 'status.update', payload: { kind: 'compacting', text: 'Compacting context (idle)…' } })
    await probe.settle()

    const clearedBefore = clearSpy.mock.calls.length
    probe.destroy()
    probe = undefined
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearedBefore)
  })
})
