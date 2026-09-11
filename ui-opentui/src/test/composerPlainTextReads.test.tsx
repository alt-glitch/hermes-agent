/**
 * Typing must not copy the whole edit buffer out of native memory more than once
 * per keystroke.
 *
 * `EditBufferRenderable.plainText` (Textarea's base) is `EditBuffer.getText()`: an FFI call that copies
 * up to 1 MiB and decodes a fresh JS string. The composer needs exactly one read
 * per content change (to feed the token analysis and draft persistence). The paste
 * reconcile microtask and the pending-image cursor snap must not pay for a second
 * and third copy when they have nothing to reconcile.
 * Contract: with no pastes and no pending images, <= 1 read per typed character.
 */
import { EditBufferRenderable, type TextareaRenderable } from '@opentui/core'
import { afterEach, describe, expect, test } from 'vitest'

import { BUSY_QUEUE_MAX_EDIT_CHARS } from '../logic/busyQueue.ts'
import { createPromptHistory } from '../logic/history.ts'
import { createPasteStore } from '../logic/pastes.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

const found = Object.getOwnPropertyDescriptor(EditBufferRenderable.prototype, 'plainText')
if (!found?.get) throw new Error('EditBufferRenderable.plainText getter not found — installed @opentui/core changed')
const descriptor: PropertyDescriptor = found

function countPlainTextReads(): { count: () => number; reset: () => void; restore: () => void } {
  let n = 0
  Object.defineProperty(EditBufferRenderable.prototype, 'plainText', {
    ...descriptor,
    get(this: TextareaRenderable) {
      n += 1
      return descriptor.get?.call(this) as string
    }
  })
  return {
    count: () => n,
    reset: () => void (n = 0),
    restore: () => Object.defineProperty(EditBufferRenderable.prototype, 'plainText', descriptor)
  }
}

describe('composer — plainText reads per keystroke', () => {
  let restore: (() => void) | undefined
  afterEach(() => restore?.())

  test('typing with no pastes and no pending images reads the buffer at most once per character', async () => {
    const spy = countPlainTextReads()
    restore = spy.restore
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const pasteStore = createPasteStore()
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            history={createPromptHistory({ initial: [] })}
            onSubmit={() => {}}
            pasteStore={pasteStore}
            store={store}
          />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: false, width: 70 }
    )
    try {
      await probe.settle()
      spy.reset()
      const text = 'the quick brown fox jumps over the lazy dog and keeps typing for a while'
      await probe.keys.typeText(text)
      await probe.settle()
      const reads = spy.count()
      // Unchanged head: 145 reads for 72 chars (one from onContentChange + one from the
      // paste-reconcile microtask per keystroke, plus one settle read). After: ≤ 1 per char.
      expect(reads).toBeLessThanOrEqual(text.length)
      expect(reads).toBeGreaterThan(0)
      expect(probe.frame()).toContain('lazy dog')
    } finally {
      probe.destroy()
    }
  })
})

describe('composer — paste reconcile still releases retained bodies', () => {
  test('deleting the token of an oversized prefill releases the body through the reconcile path', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const pasteStore = createPasteStore()
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            history={createPromptHistory({ initial: [] })}
            onSubmit={() => {}}
            pasteStore={pasteStore}
            store={store}
          />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      store.replaceComposerDraft('β'.repeat(BUSY_QUEUE_MAX_EDIT_CHARS + 1))
      await probe.settle()
      expect(pasteStore.stats().count).toBe(1)
      expect(probe.frame()).toContain('[Pasted text #')
      // Deleting one character breaks the token reference; the store is non-empty,
      // so the reconcile microtask must still read the buffer and release the body.
      probe.keys.pressBackspace()
      await probe.settle()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(pasteStore.stats()).toMatchObject({ bytes: 0, count: 0 })
    } finally {
      probe.destroy()
    }
  })
})
