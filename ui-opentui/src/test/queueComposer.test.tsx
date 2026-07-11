import { describe, expect, test, vi } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { BUSY_QUEUE_MAX_EDIT_CHARS } from '../logic/busyQueue.ts'
import { createPasteStore, type PasteStore } from '../logic/pastes.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

const countDescendants = (node: { getChildren(): unknown[] }): number => {
  let count = 0
  for (const child of node.getChildren()) {
    count += 1
    if (child && typeof child === 'object' && 'getChildren' in child) {
      count += countDescendants(child as { getChildren(): unknown[] })
    }
  }
  return count
}

async function mountQueue(items: string[], pasteStore?: PasteStore) {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  for (const item of items) store.enqueuePrompt(item)
  const sent = vi.fn<(index: number, text: string) => boolean>((index, text) => {
    if (!store.replaceQueuedPrompt(index, text)) return false
    store.removeQueuedPrompt(index)
    return true
  })
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App
          store={store}
          onSubmitQueued={sent}
          onSendQueuedIndex={index => sent(index, store.state.queuedPrompts[index] ?? '')}
          {...(pasteStore ? { pasteStore } : {})}
        />
      </ThemeProvider>
    ),
    { height: 30, kittyKeyboard: true, width: 70 }
  )
  return { probe, sent, store }
}

describe('queued-message composer UX', () => {
  test('a normal submit does not masquerade as queue-edit completion and auto-drain a new /queue row', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const editChanges: Array<number | undefined> = []
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            store={store}
            onSubmit={() => {
              store.enqueuePrompt('stay queued')
              return true
            }}
            onQueueEditChange={index => editChanges.push(index)}
          />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      await probe.keys.typeText('/queue stay queued')
      probe.keys.pressEnter()
      await probe.settle()
      expect(store.state.queuedPrompts).toEqual(['stay queued'])
      expect(editChanges).toEqual([])
      expect(probe.frame()).toContain('queued (1)')
    } finally {
      probe.destroy()
    }
  })

  test('a rejected local queue command can restore its full command after submit clears', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            store={store}
            onSubmit={text => {
              queueMicrotask(() => store.replaceComposerDraft(text))
              return true
            }}
          />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      await probe.keys.typeText('/queue important')
      probe.keys.pressEnter()
      await new Promise<void>(resolve => queueMicrotask(() => resolve()))
      await probe.settle()
      expect(store.state.composerDraft).toBe('/queue important')
      expect(probe.frame()).toContain('/queue important')
    } finally {
      probe.destroy()
    }
  })

  test('double empty Enter fires once on the second press', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const force = vi.fn()
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} onDoubleEmptySubmit={force} />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      probe.keys.pressEnter()
      await probe.settle()
      expect(force).not.toHaveBeenCalled()
      probe.keys.pressEnter()
      await probe.settle()
      expect(force).toHaveBeenCalledTimes(1)
    } finally {
      probe.destroy()
    }
  })

  test('mounts a fixed three-row window and keeps the edited row visible', async () => {
    const h = await mountQueue(['one', 'two', 'three', 'four', 'five'])
    try {
      const frame = h.probe.frame()
      expect(frame).toContain('queued (5)')
      expect(frame).toContain('1. one')
      expect(frame).toContain('2. two')
      expect(frame).toContain('3. three')
      expect(frame).not.toContain('4. four')
      expect(frame).toContain('…and 2 more')

      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.store.state.queueEditIndex).toBe(0)
      expect(h.probe.frame()).toContain('editing 1 · Ctrl+X delete · Esc cancel')

      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.store.state.queueEditIndex).toBe(1)
      expect(h.probe.frame()).toContain('editing 2')
    } finally {
      h.probe.destroy()
    }
  })

  test('Ctrl+X deletes, Esc cancels, and Enter sends the edited body', async () => {
    const h = await mountQueue(['alpha', 'beta', 'gamma'])
    try {
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      h.probe.keys.pressKey('x', { ctrl: true })
      await h.probe.settle()
      expect(h.store.state.queuedPrompts).toEqual(['beta', 'gamma'])
      expect(h.store.state.queueEditIndex).toBeUndefined()

      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      h.probe.keys.pressEscape()
      await h.probe.settle()
      expect(h.store.state.queueEditIndex).toBeUndefined()
      expect(h.probe.frame()).not.toContain('editing 1')

      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      await h.probe.keys.typeText(' edited')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.sent).toHaveBeenCalledWith(0, 'beta edited')
      expect(h.store.state.queuedPrompts).toEqual(['gamma'])
    } finally {
      h.probe.destroy()
    }
  })

  test('Ctrl+K keeps the stock textarea delete-to-line-end behavior and never dequeues', async () => {
    const h = await mountQueue(['retain me'])
    try {
      await h.probe.keys.typeText('abcdef')
      h.probe.keys.pressArrow('left')
      h.probe.keys.pressArrow('left')
      h.probe.keys.pressKey('k', { ctrl: true })
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('abcd')
      expect(h.store.state.queuedPrompts).toEqual(['retain me'])
      expect(h.sent).not.toHaveBeenCalled()
    } finally {
      h.probe.destroy()
    }
  })

  test('one Esc cancels a slash-like queue edit even when completions are open', async () => {
    const h = await mountQueue(['/help'])
    try {
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.store.state.queueEditIndex).toBe(0)
      h.store.setCompletions([{ display: '/help', meta: 'command', text: '/help' }])
      await h.probe.settle()
      expect(h.probe.frame()).toContain('Esc cancel')
      h.probe.keys.pressEscape()
      await h.probe.settle()
      expect(h.store.state.queueEditIndex).toBeUndefined()
      expect(h.store.state.completions).toBeUndefined()
      expect(h.probe.frame()).not.toContain('editing 1')
    } finally {
      h.probe.destroy()
    }
  })

  test('Esc and Ctrl+X release large paste bodies abandoned by queue editing', async () => {
    const pasteStore = createPasteStore()
    const h = await mountQueue(['alpha', 'beta'], pasteStore)
    const body = 'α'.repeat(1024 * 1024)
    try {
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      await h.probe.keys.pasteBracketedText(body)
      await h.probe.settle()
      expect(pasteStore.stats()).toMatchObject({ bytes: 2 * 1024 * 1024, count: 1 })

      h.probe.keys.pressEscape()
      await h.probe.settle()
      expect(pasteStore.stats()).toMatchObject({ bytes: 0, count: 0 })
      expect(h.store.state.queuedPrompts).toEqual(['alpha', 'beta'])

      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      await h.probe.keys.pasteBracketedText(body)
      await h.probe.settle()
      expect(pasteStore.stats().count).toBe(1)

      h.probe.keys.pressKey('x', { ctrl: true })
      await h.probe.settle()
      expect(pasteStore.stats()).toMatchObject({ bytes: 0, count: 0 })
      expect(h.store.state.queuedPrompts).toEqual(['beta'])
    } finally {
      h.probe.destroy()
    }
  })

  test('oversized rows are selected without entering the native textarea and Enter sends directly', async () => {
    const body = 'α'.repeat(BUSY_QUEUE_MAX_EDIT_CHARS + 1)
    const h = await mountQueue([body])
    try {
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.store.state.queueEditIndex).toBe(0)
      expect(h.store.state.composerDraft).toBe('')
      expect(h.probe.frame()).toContain('too large to edit')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.sent).toHaveBeenCalledWith(0, body)
      expect(h.store.state.queuedPrompts).toEqual([])
    } finally {
      h.probe.destroy()
    }
  })

  test('100 queued rows retain a constant native-renderable window', async () => {
    const few = await mountQueue(Array.from({ length: 5 }, (_, index) => `few-${index}`))
    const fewCount = countDescendants(few.probe.renderer.root)
    few.probe.destroy()

    const many = await mountQueue(Array.from({ length: 100 }, (_, index) => `many-${index}`))
    try {
      const manyCount = countDescendants(many.probe.renderer.root)
      expect(manyCount).toBeLessThanOrEqual(fewCount + 2)
      expect(many.probe.frame()).toContain('queued (100)')
      expect(many.probe.frame()).toContain('…and 97 more')
      expect(many.probe.frame()).not.toContain('many-99')
    } finally {
      many.probe.destroy()
    }
  })
})
