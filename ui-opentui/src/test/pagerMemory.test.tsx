/** Large pager regressions: `/history` must not allocate one native renderable
 * per explicit line, and closing it must safely remount the realistic windowed
 * transcript it temporarily replaces. */
import { ScrollBoxRenderable, type Renderable } from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { expect, test } from 'vitest'

import { materialize } from '../../scripts/fixture.ts'
import { formatHistory, HISTORY_MAX_MESSAGES, HISTORY_MAX_PAGER_CHARS } from '../logic/slash.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

function descendants(node: Renderable): number {
  let count = 0
  for (const child of node.getChildren()) count += 1 + descendants(child)
  return count
}

function findScrollbox(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node
  for (const child of node.getChildren()) {
    const hit = findScrollbox(child)
    if (hit) return hit
  }
  return undefined
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`)
  return value
}

test('a realistic seeded 3k transcript opens a bounded O(1) history pager and remounts on close', async () => {
  const fixture = materialize(3_000)
  expect(fixture).toHaveLength(3_000)
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.commitSessionSnapshot('pager-memory', fixture, { model: 'fixture-model' }, () => true)
  expect(store.state.messages).toHaveLength(3_000)
  let root: Renderable | undefined

  function GrabRoot() {
    root = useRenderer().root
    return null
  }

  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <GrabRoot />
        <App store={store} />
      </ThemeProvider>
    ),
    { width: 72, height: 20 }
  )

  try {
    const mountedRoot = requireValue(root, 'renderer root')
    for (let pass = 0; pass < 3; pass++) await probe.settle()
    const baseline = descendants(mountedRoot)
    const conversationCount = fixture.filter(message => message.role === 'user' || message.role === 'assistant').length
    const retainedConversationCount = fixture
      .slice(-HISTORY_MAX_MESSAGES)
      .filter(message => message.role === 'user' || message.role === 'assistant').length
    const history = requireValue(formatHistory(store.state.messages, ''), 'formatted history')
    expect(history.length).toBeLessThanOrEqual(HISTORY_MAX_PAGER_CHARS)
    expect(history).toContain(
      `history truncated: showing latest ${retainedConversationCount} of ${conversationCount} messages`
    )

    store.openPager('History', history)
    for (let pass = 0; pass < 3; pass++) await probe.settle()

    const openCount = descendants(mountedRoot)
    expect(openCount).toBeLessThan(baseline)
    expect(openCount).toBeLessThan(40)
    expect(findScrollbox(mountedRoot)?.scrollHeight).toBeGreaterThan(HISTORY_MAX_MESSAGES)
    expect(probe.frame()).toContain('history truncated')

    store.closePager()
    for (let pass = 0; pass < 5; pass++) await probe.settle()
    expect(Math.abs(descendants(mountedRoot) - baseline)).toBeLessThan(20)
  } finally {
    probe.destroy()
  }
}, 20_000)

test('Return pages forward while more pager content remains', async () => {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.openPager('History', Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n'))
  let root: Renderable | undefined

  function GrabRoot() {
    root = useRenderer().root
    return null
  }

  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <GrabRoot />
        <App store={store} />
      </ThemeProvider>
    ),
    { width: 72, height: 14 }
  )

  try {
    const pager = requireValue(findScrollbox(requireValue(root, 'renderer root')), 'pager scrollbox')
    expect(pager.scrollTop).toBe(0)
    probe.keys.pressEnter()
    await probe.settle()
    expect(store.state.pager).toBeDefined()
    expect(pager.scrollTop).toBeGreaterThan(0)
  } finally {
    probe.destroy()
  }
})

test('Return closes a pager that is already at the bottom', async () => {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.openPager('History', Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n'))
  let root: Renderable | undefined

  function GrabRoot() {
    root = useRenderer().root
    return null
  }

  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <GrabRoot />
        <App store={store} />
      </ThemeProvider>
    ),
    { width: 72, height: 14 }
  )

  try {
    const pager = requireValue(findScrollbox(requireValue(root, 'renderer root')), 'pager scrollbox')
    // Use the pager's own End-key route so the same closure/ref that handles
    // Return performs the bottom jump (not an out-of-band test mutation).
    probe.keys.pressKey('END')
    await probe.settle()
    expect(pager.scrollTop).toBeGreaterThanOrEqual(Math.max(0, pager.scrollHeight - pager.viewport.height))
    probe.keys.pressEnter()
    await probe.settle()
    expect(store.state.pager).toBeUndefined()
  } finally {
    probe.destroy()
  }
})
