/**
 * Composer input tests — shift+enter newline (kitty), the Alt+Enter universal
 * fallback, the visible-height cap with internal scroll, and big-buffer line
 * navigation (item: composer input improvements).
 *
 * Protocol reality, pinned here:
 *   - kitty keyboard protocol (ghostty/kitty/wezterm): Shift+Enter arrives as a
 *     distinct `return + shift` event → newline; plain Enter still submits.
 *   - LEGACY input: Shift+Enter is byte-identical to Enter (both CR), so it
 *     submits — the mock keyboard reproduces this faithfully (the shift
 *     modifier can't be encoded on a bare CR). Alt+Enter (ESC-prefixed CR)
 *     works everywhere and inserts the newline instead.
 *
 * Height cap: the textarea auto-grows to COMPOSER_MAX_ROWS (8) then scrolls
 * INTERNALLY — the viewport follows the cursor, and Up/Down in a multi-line
 * buffer are line navigation, never history recall.
 */
import { describe, expect, test } from 'vitest'

import { COMPOSER_MAX_ROWS, envComposerRows } from '../logic/env.ts'
import { createPromptHistory } from '../logic/history.ts'
import { createPasteStore } from '../logic/pastes.ts'
import { BUSY_QUEUE_MAX_CHARS, BUSY_QUEUE_MAX_EDIT_CHARS } from '../logic/busyQueue.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

interface Harness {
  history: ReturnType<typeof createPromptHistory>
  probe: RenderProbe
  store: ReturnType<typeof createSessionStore>
  submitted: string[]
}

async function mountComposer(opts?: { kitty?: boolean; history?: string[] }): Promise<Harness> {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  const submitted: string[] = []
  const history = createPromptHistory({ initial: opts?.history ?? [] })
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} onSubmit={t => void submitted.push(t)} history={history} />
      </ThemeProvider>
    ),
    { height: 30, kittyKeyboard: opts?.kitty ?? false, width: 70 }
  )
  return { history, probe, store, submitted }
}

async function pressDoubleEsc(h: Harness): Promise<void> {
  h.probe.keys.pressEscape()
  await h.probe.settle()
  h.probe.keys.pressEscape()
  await h.probe.settle()
}

describe('readline line editing parity', () => {
  test('Super+Backspace kills to the current line start', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('one')
      h.probe.keys.pressEnter({ shift: true })
      await h.probe.keys.typeText('two')
      h.probe.keys.pressBackspace({ super: true })
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('one\n')
    } finally {
      h.probe.destroy()
    }
  })

  test('Super+Delete kills to line end and joins the next line at EOL', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('one')
      h.probe.keys.pressEnter({ shift: true })
      await h.probe.keys.typeText('two')
      h.probe.keys.pressKey('HOME')
      h.probe.keys.pressKey('DELETE', { super: true })
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('one\n')

      await h.probe.keys.typeText('two')
      h.probe.keys.pressKey('HOME')
      h.probe.keys.pressKey('HOME')
      h.probe.keys.pressKey('DELETE', { super: true })
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('onetwo')
    } finally {
      h.probe.destroy()
    }
  })

  test('Ctrl+K joins the next line at EOL while Ctrl+U stays current-line scoped', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('one')
      h.probe.keys.pressEnter({ shift: true })
      await h.probe.keys.typeText('two')
      h.probe.keys.pressKey('HOME')
      h.probe.keys.pressKey('HOME')
      h.probe.keys.pressKey('k', { ctrl: true })
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('onetwo')

      h.probe.keys.pressKey('u', { ctrl: true })
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('two')
    } finally {
      h.probe.destroy()
    }
  })

  test('Ctrl+K on an earlier unequal-length line only joins at that line EOL', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('abcdef')
      h.probe.keys.pressEnter({ shift: true })
      await h.probe.keys.typeText('xy')
      h.probe.keys.pressKey('HOME')
      h.probe.keys.pressKey('HOME')
      for (let i = 0; i < 4; i++) h.probe.keys.pressArrow('left')
      h.probe.keys.pressKey('k', { ctrl: true })
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('ab\nxy')

      h.probe.keys.pressKey('k', { ctrl: true })
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('abxy')
    } finally {
      h.probe.destroy()
    }
  })

  test('Ctrl+Backspace and Option+Backspace remain delete-word', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('alpha beta')
      h.probe.keys.pressBackspace({ ctrl: true })
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('alpha ')

      await h.probe.keys.typeText('gamma')
      h.probe.keys.pressBackspace({ meta: true })
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('alpha ')
    } finally {
      h.probe.destroy()
    }
  })
})

describe('double Escape draft discard', () => {
  test('discards a non-empty draft, records it first, and Up recalls it', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('recover this draft')
      await pressDoubleEsc(h)
      expect(h.store.state.composerDraft).toBe('')
      expect(h.history.entries()).toEqual(['recover this draft'])

      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('recover this draft')
    } finally {
      h.probe.destroy()
    }
  })

  test('still discards while a turn is streaming', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      h.store.apply({ type: 'message.start' })
      await h.probe.keys.typeText('mid-stream draft')
      await pressDoubleEsc(h)
      expect(h.store.state.info.running).toBe(true)
      expect(h.store.state.composerDraft).toBe('')
      expect(h.history.entries()).toEqual(['mid-stream draft'])
    } finally {
      h.probe.destroy()
    }
  })

  test('an EOL Ctrl+K between Esc presses disarms draft discard', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('one')
      h.probe.keys.pressEnter({ shift: true })
      await h.probe.keys.typeText('two')
      h.probe.keys.pressArrow('up')
      h.probe.keys.pressEscape()
      h.probe.keys.pressKey('k', { ctrl: true })
      h.probe.keys.pressEscape()
      await h.probe.settle()

      expect(h.store.state.composerDraft).toBe('onetwo')
      expect(h.history.entries()).toEqual([])
    } finally {
      h.probe.destroy()
    }
  })

  test('a kitty repeat Escape is ignored instead of becoming the second press', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('keep until a real second press')
      h.probe.keys.pressEscape()
      h.probe.renderer.stdin.emit('data', Buffer.from('\x1b[27;1:2u'))
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('keep until a real second press')

      h.probe.keys.pressEscape()
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('')
      expect(h.history.entries()).toEqual(['keep until a real second press'])
    } finally {
      h.probe.destroy()
    }
  })

  test('keeps empty-buffer double Escape opening the prompt-history viewer', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      h.store.pushUser('session prompt')
      await pressDoubleEsc(h)
      expect(h.store.state.promptHistory).toBe(true)
    } finally {
      h.probe.destroy()
    }
  })
})

/** Row index of the first frame line containing `text` (-1 when absent). */
function rowOf(frame: string, text: string): number {
  return frame.split('\n').findIndex(l => l.includes(text))
}

describe('shift+enter — kitty protocol inserts a newline', () => {
  test('kitty: Shift+Enter → newline (no submit); Enter then submits the multi-line text', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('alpha')
      h.probe.keys.pressEnter({ shift: true })
      await h.probe.settle()
      await h.probe.keys.typeText('beta')
      await h.probe.settle()
      expect(h.submitted).toEqual([]) // newline, NOT a submit
      const frame = h.probe.frame()
      expect(rowOf(frame, 'alpha')).toBeGreaterThanOrEqual(0)
      expect(rowOf(frame, 'beta')).toBe(rowOf(frame, 'alpha') + 1) // separate composer rows
      h.probe.keys.pressEnter() // plain Enter still submits
      await h.probe.settle()
      expect(h.submitted).toEqual(['alpha\nbeta'])
    } finally {
      h.probe.destroy()
    }
  })

  test('kitty: plain Enter submits (pin — shift handling must not eat Enter)', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('hello kitty')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.submitted).toEqual(['hello kitty'])
    } finally {
      h.probe.destroy()
    }
  })

  test('legacy: Shift+Enter is indistinguishable from Enter → submits (honest pin)', async () => {
    const h = await mountComposer({ kitty: false })
    try {
      await h.probe.keys.typeText('hello legacy')
      // legacy CR carries no shift bit — the mock emits the same bare \r
      h.probe.keys.pressEnter({ shift: true })
      await h.probe.settle()
      expect(h.submitted).toEqual(['hello legacy'])
    } finally {
      h.probe.destroy()
    }
  })

  test('legacy: Alt+Enter (ESC-prefixed CR) inserts the newline — the universal fallback', async () => {
    const h = await mountComposer({ kitty: false })
    try {
      await h.probe.keys.typeText('one')
      h.probe.keys.pressEnter({ meta: true })
      await h.probe.settle()
      await h.probe.keys.typeText('two')
      await h.probe.settle()
      expect(h.submitted).toEqual([]) // Alt+Enter = newline, not the stock submit
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.submitted).toEqual(['one\ntwo'])
    } finally {
      h.probe.destroy()
    }
  })
})

describe('ctrl/cmd+enter — atomic CSI u modified Enter inserts a newline (Ink terminal-setup parity)', () => {
  // The exact bytes boundary/terminalSetup.ts binds to ctrl+enter / cmd+enter in
  // VS Code-family terminals. The IDE sends them verbatim via sendSequence, so
  // these tests feed the raw wire bytes through the stdin parser rather than a
  // synthetic key event: modifier 5 = ctrl, 9 = super (Cmd), on codepoint 13.
  const CSI_U_CTRL_ENTER = '\x1b[13;5u'
  const CSI_U_SUPER_ENTER = '\x1b[13;9u'

  // VS Code's terminal does not negotiate the kitty protocol; the CSI u bytes
  // arrive on a legacy-mode session. The parser accepts them either way (the
  // production renderer config keeps CSI u parsing on), pinned here in BOTH modes.
  for (const kitty of [false, true]) {
    const label = kitty ? 'kitty' : 'legacy'

    test(`${label}: CSI-u Ctrl+Enter → newline; plain Enter then submits the multi-line text`, async () => {
      const h = await mountComposer({ kitty })
      try {
        await h.probe.keys.typeText('one')
        h.probe.renderer.stdin.emit('data', Buffer.from(CSI_U_CTRL_ENTER))
        await h.probe.settle()
        await h.probe.keys.typeText('two')
        await h.probe.settle()
        expect(h.submitted).toEqual([]) // Ctrl+Enter = newline, never a submit
        h.probe.keys.pressEnter()
        await h.probe.settle()
        expect(h.submitted).toEqual(['one\ntwo'])
      } finally {
        h.probe.destroy()
      }
    })

    test(`${label}: CSI-u Cmd+Enter → newline; plain Enter then submits the multi-line text`, async () => {
      const h = await mountComposer({ kitty })
      try {
        await h.probe.keys.typeText('one')
        h.probe.renderer.stdin.emit('data', Buffer.from(CSI_U_SUPER_ENTER))
        await h.probe.settle()
        await h.probe.keys.typeText('two')
        await h.probe.settle()
        expect(h.submitted).toEqual([]) // Cmd+Enter = newline, never a submit
        h.probe.keys.pressEnter()
        await h.probe.settle()
        expect(h.submitted).toEqual(['one\ntwo'])
      } finally {
        h.probe.destroy()
      }
    })
  }

  test('kitty: natively-reported Ctrl+Enter inserts a newline too', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('one')
      h.probe.keys.pressEnter({ ctrl: true })
      await h.probe.settle()
      await h.probe.keys.typeText('two')
      await h.probe.settle()
      expect(h.submitted).toEqual([])
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.submitted).toEqual(['one\ntwo'])
    } finally {
      h.probe.destroy()
    }
  })
})

describe('external draft clear', () => {
  test('clears the mounted uncontrolled textarea as well as persisted state', async () => {
    const h = await mountComposer({ history: ['older prompt', 'newest prompt'], kitty: true })
    try {
      await h.probe.keys.typeText('discard me')
      await h.probe.settle()
      expect(h.store.state.composerDraft).toBe('discard me')
      expect(h.probe.frame()).toContain('discard me')

      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('newest prompt')

      h.store.clearComposerDraft()
      await h.probe.settle()

      expect(h.store.state.composerDraft).toBe('')
      expect(h.probe.frame()).not.toContain('discard me')

      // The clear also resets history navigation. Without that reset the next
      // Up would continue from the recalled cursor and show "older prompt".
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('newest prompt')
      expect(h.probe.frame()).not.toContain('older prompt')
    } finally {
      h.probe.destroy()
    }
  })

  test('server prefill replaces the mounted textarea and rejected submit keeps it editable', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const submitted: string[] = []
    let accept = false
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            store={store}
            onSubmit={text => {
              submitted.push(text)
              return accept
            }}
          />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      store.replaceComposerDraft('edit this prompt')
      await probe.settle()
      expect(probe.frame()).toContain('edit this prompt')

      probe.keys.pressEnter()
      await probe.settle()
      expect(submitted).toEqual(['edit this prompt'])
      expect(probe.frame()).toContain('edit this prompt')
      expect(store.state.composerDraft).toBe('edit this prompt')

      accept = true
      probe.keys.pressEnter()
      await probe.settle()
      expect(submitted).toEqual(['edit this prompt', 'edit this prompt'])
      expect(probe.frame()).not.toContain('edit this prompt')
      expect(store.state.composerDraft).toBe('')
    } finally {
      probe.destroy()
    }
  })

  test('oversized server prefill stays recoverable behind a bounded paste token', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const pasteStore = createPasteStore()
    const submitted: string[] = []
    const body = 'α'.repeat(BUSY_QUEUE_MAX_EDIT_CHARS + 1)
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} pasteStore={pasteStore} onSubmit={text => void submitted.push(text)} />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      store.replaceComposerDraft(body)
      await probe.settle()
      expect(store.state.composerDraft).toMatch(/^\[Pasted text #/)
      expect(pasteStore.stats().count).toBe(1)
      expect(probe.frame()).toContain('[Pasted text #')
      expect(probe.frame()).not.toContain('α'.repeat(200))
      probe.keys.pressEnter()
      await probe.settle()
      expect(submitted).toEqual([body])
      expect(pasteStore.stats()).toMatchObject({ bytes: 0, count: 0 })
    } finally {
      probe.destroy()
    }
  })

  test('session clear then same-draft restore preserves the paste body exactly once', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const pasteStore = createPasteStore()
    const submitted: string[] = []
    const body = 'α'.repeat(BUSY_QUEUE_MAX_EDIT_CHARS + 1)
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} pasteStore={pasteStore} onSubmit={text => void submitted.push(text)} />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      store.replaceComposerDraft(body)
      await probe.settle()
      const retainedDraft = store.state.composerDraft
      expect(retainedDraft).toMatch(/^\[Pasted text #/)
      expect(pasteStore.stats().count).toBe(1)

      // Production transitions capture the draft, reset session-owned state
      // (which imperatively clears the textarea), then restore that exact token.
      store.detachSession()
      store.replaceComposerDraft(retainedDraft)
      await probe.settle()

      expect(store.state.composerDraft).toBe(retainedDraft)
      expect(pasteStore.stats().count).toBe(1)
      expect(pasteStore.expand(retainedDraft)).toBe(body)
      probe.keys.pressEnter()
      await probe.settle()
      expect(submitted).toEqual([body])
      expect(pasteStore.stats()).toMatchObject({ bytes: 0, count: 0 })
    } finally {
      probe.destroy()
    }
  })

  test('manually deleting a large-paste token releases its retained body', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const pasteStore = createPasteStore()
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} pasteStore={pasteStore} />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      await probe.keys.pasteBracketedText('α'.repeat(1024 * 1024))
      await probe.settle()
      expect(store.state.composerDraft).toMatch(/^\[Pasted text #/)
      expect(pasteStore.stats()).toMatchObject({ bytes: 2 * 1024 * 1024, count: 1 })

      for (let index = 0; index < store.state.composerDraft.length; index += 1) {
        probe.keys.pressBackspace()
      }
      await probe.settle()
      await Promise.resolve()
      expect(store.state.composerDraft).toBe('')
      expect(pasteStore.stats()).toMatchObject({ bytes: 0, count: 0 })
    } finally {
      probe.destroy()
    }
  })

  test('a paste over the retained-memory ceiling is consumed, reported, and never floods the textarea', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const pasteStore = createPasteStore({ maxRetainedBytes: 1024 * 1024 })
    const limits: number[] = []
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} pasteStore={pasteStore} onPasteLimitExceeded={maxBytes => limits.push(maxBytes)} />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      await probe.keys.pasteBracketedText('α'.repeat(1024 * 1024))
      await probe.settle()
      expect(limits).toEqual([1024 * 1024])
      expect(store.state.composerDraft).toBe('')
      expect(pasteStore.stats()).toMatchObject({ bytes: 0, count: 0 })
      expect(probe.frame()).not.toContain('α'.repeat(100))
    } finally {
      probe.destroy()
    }
  })

  test('programmatic replacement prunes the old body and rejects over-limit bodies without replacing the draft', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const pasteStore = createPasteStore({ maxRetainedBytes: 48 * 1024 })
    const limits: number[] = []
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} pasteStore={pasteStore} onPasteLimitExceeded={maxBytes => limits.push(maxBytes)} />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      const first = 'a'.repeat(BUSY_QUEUE_MAX_EDIT_CHARS + 1)
      store.replaceComposerDraft(first)
      await probe.settle()
      const firstToken = store.state.composerDraft
      expect(pasteStore.stats().count).toBe(1)

      const second = 'b'.repeat(BUSY_QUEUE_MAX_EDIT_CHARS + 2)
      store.replaceComposerDraft(second)
      await probe.settle()
      const secondToken = store.state.composerDraft
      expect(secondToken).not.toBe(firstToken)
      expect(pasteStore.stats().count).toBe(1)
      expect(pasteStore.expand(firstToken)).toBe(firstToken)
      expect(pasteStore.expand(secondToken)).toBe(second)

      const rejected = 'c'.repeat(25 * 1024)
      store.replaceComposerDraft(rejected)
      await probe.settle()
      expect(limits).toEqual([48 * 1024])
      expect(store.state.composerDraft).toBe(secondToken)
      expect(pasteStore.stats().count).toBe(1)
      expect(pasteStore.expand(secondToken)).toBe(second)

      store.replaceComposerDraft('small replacement')
      await probe.settle()
      expect(pasteStore.stats()).toMatchObject({ bytes: 0, count: 0 })
    } finally {
      probe.destroy()
    }
  })

  test('duplicated paste tokens cannot expand beyond the prompt ceiling', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const pasteStore = createPasteStore()
    const submitted: string[] = []
    const limits: number[] = []
    const body = 'α'.repeat(Math.floor(BUSY_QUEUE_MAX_CHARS / 2) + 1)
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            store={store}
            pasteStore={pasteStore}
            onSubmit={text => void submitted.push(text)}
            onPasteLimitExceeded={maxBytes => limits.push(maxBytes)}
          />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      const token = pasteStore.add(body)
      if (!token) throw new Error('paste fixture unexpectedly exceeded the store ceiling')
      const draft = `${token} ${token} ${token}`
      store.replaceComposerDraft(draft)
      await probe.settle()
      probe.keys.pressEnter()
      await probe.settle()

      expect(submitted).toEqual([])
      expect(limits).toEqual([BUSY_QUEUE_MAX_CHARS * 2])
      expect(store.state.composerDraft).toBe(draft)
      expect(pasteStore.stats().count).toBe(1)
    } finally {
      probe.destroy()
    }
  })
})

describe('clipboard image attachments', () => {
  test('Ctrl+V inserts usable clipboard text without creating an image token', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const hotkeys: boolean[] = []
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            store={store}
            onImagePaste={hotkey => {
              hotkeys.push(hotkey === true)
              return Promise.resolve('clipboard text')
            }}
          />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      probe.keys.pressKey('v', { ctrl: true })
      await probe.settle()
      expect(hotkeys).toEqual([true])
      expect(store.state.composerDraft).toBe('clipboard text')
      expect(store.state.pendingImages).toEqual([])
    } finally {
      probe.destroy()
    }
  })

  test('Ctrl+V attaches once and renders an inline composer token', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    let pasteCalls = 0
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            store={store}
            onImagePaste={() => {
              pasteCalls += 1
              store.addPendingImage({
                height: 492,
                name: 'clip.png',
                path: '/tmp/clip.png',
                token_estimate: 340,
                width: 1660
              })
            }}
          />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      probe.keys.pressKey('v', { ctrl: true })
      await probe.settle()
      expect(pasteCalls).toBe(1)
      expect(store.state.composerDraft).toContain('[Image #1]')
      expect(probe.frame()).toContain('[Image #1]')
      expect(probe.frame()).not.toContain('image attached')
    } finally {
      probe.destroy()
    }
  })

  test('deleting an inline token detaches the exact queued image', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const detached: string[] = []
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            store={store}
            onImageDetach={path => {
              detached.push(path)
              store.removePendingImage(path)
            }}
          />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      store.addPendingImage({ path: '/tmp/remove-me.png' })
      await probe.settle()
      expect(probe.frame()).toContain('[Image #1]')
      probe.keys.pressKey('BACKSPACE')
      await probe.settle()
      expect(detached).toEqual(['/tmp/remove-me.png'])
      expect(store.state.pendingImages).toEqual([])
      expect(probe.frame()).not.toContain('[Image #1]')
    } finally {
      probe.destroy()
    }
  })

  test('accepted image-only submit clears the token but retains ownership until admission', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const submitted: string[] = []
    const detached: string[] = []
    let accept = false
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            store={store}
            onImageDetach={path => void detached.push(path)}
            onSubmit={text => {
              submitted.push(text)
              return accept
            }}
          />
        </ThemeProvider>
      ),
      { height: 30, kittyKeyboard: true, width: 70 }
    )
    try {
      store.addPendingImage({ path: '/tmp/submit.png' })
      await probe.settle()
      probe.keys.pressEnter()
      await probe.settle()
      expect(submitted).toEqual(['[Image #1]'])
      expect(store.state.pendingImages).toHaveLength(1)
      expect(probe.frame()).toContain('[Image #1]')

      accept = true
      probe.keys.pressEnter()
      await probe.settle()
      expect(submitted).toEqual(['[Image #1]', '[Image #1]'])
      expect(store.state.pendingImages).toHaveLength(1)
      expect(probe.frame()).not.toContain('[Image #1]')
      expect(detached).toEqual([])

      // The entry clears this slice only after the correlated message.start.
      store.clearPendingImages()
      expect(store.state.pendingImages).toEqual([])
    } finally {
      probe.destroy()
    }
  })
})

describe('height cap + internal scroll (Ink parity: 8 rows)', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `q${String(i + 1).padStart(2, '0')}`)

  async function typeTallBuffer(h: Harness): Promise<void> {
    for (let i = 0; i < lines.length; i++) {
      await h.probe.keys.typeText(lines[i]!)
      if (i < lines.length - 1) h.probe.keys.pressEnter({ shift: true })
    }
    await h.probe.settle()
  }

  test('a 20-line buffer renders at most COMPOSER_MAX_ROWS rows, scrolled to the cursor', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await typeTallBuffer(h)
      const frame = h.probe.frame()
      const visible = lines.filter(l => frame.includes(l))
      expect(visible.length).toBeLessThanOrEqual(COMPOSER_MAX_ROWS)
      expect(frame).toContain('q20') // the cursor line (bottom) is in view …
      expect(frame).not.toContain('q01') // … the top scrolled out internally
      expect(frame).toContain('line 20/20') // the quiet position indicator
      expect(h.submitted).toEqual([]) // nothing submitted while composing
    } finally {
      h.probe.destroy()
    }
  })

  test('Up walks the cursor through the lines and the viewport follows', async () => {
    const h = await mountComposer({ history: ['previous prompt'], kitty: true })
    try {
      await typeTallBuffer(h)
      for (let i = 0; i < lines.length - 1; i++) h.probe.keys.pressArrow('up')
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).toContain('q01') // viewport followed the cursor to the top
      expect(frame).not.toContain('q20') // the bottom scrolled out
      expect(frame).toContain('line 1/20')
      // multi-line buffer: Up at the top is NOT a history recall
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.probe.frame()).not.toContain('previous prompt')
      // … and Down walks back down instead of recalling newer history
      for (let i = 0; i < lines.length - 1; i++) h.probe.keys.pressArrow('down')
      await h.probe.settle()
      const back = h.probe.frame()
      expect(back).toContain('q20')
      expect(back).not.toContain('previous prompt')
    } finally {
      h.probe.destroy()
    }
  })

  test('single-line buffers keep the existing history recall on Up (regression pin)', async () => {
    const h = await mountComposer({ history: ['previous prompt'], kitty: true })
    try {
      await h.probe.keys.typeText('draft')
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('previous prompt')
    } finally {
      h.probe.destroy()
    }
  })

  test('no indicator while the buffer fits the visible cap', async () => {
    const h = await mountComposer({ kitty: true })
    try {
      await h.probe.keys.typeText('short')
      h.probe.keys.pressEnter({ shift: true })
      await h.probe.keys.typeText('buffer')
      await h.probe.settle()
      expect(h.probe.frame()).not.toContain('line 2/2')
    } finally {
      h.probe.destroy()
    }
  })
})

describe('envComposerRows — the TUI-only override (not config.yaml)', () => {
  test.each([
    [undefined, COMPOSER_MAX_ROWS],
    ['', COMPOSER_MAX_ROWS],
    ['12', 12],
    ['4', 4],
    ['0', COMPOSER_MAX_ROWS], // zero rows is nonsense — fall back
    ['tall', COMPOSER_MAX_ROWS] // garbage — fall back
  ])('%j → %d', (value, expected) => {
    expect(envComposerRows(value as string | undefined)).toBe(expected)
  })

  test('the default cap is the Ink-parity 8', () => {
    expect(COMPOSER_MAX_ROWS).toBe(8)
  })
})
