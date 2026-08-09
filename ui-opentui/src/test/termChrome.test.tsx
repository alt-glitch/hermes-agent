/**
 * Terminal chrome: OSC 0/2 window title + native desktop notifications
 * (renderer.triggerNotification). Layers:
 *   1. pure: title shaping, OSC sanitization, the prompt-kind copy, the env
 *      kill-switch (logic/termChrome.ts).
 *   2. boundary: installTerminalChrome over a fake renderer — notify routes to
 *      the native triggerNotification(message, title) with focus suppression.
 *   3. wiring: <TerminalChrome> with an injected fake seam over a real
 *      store — the title tracks session.info, prompts and turn-completion
 *      edges notify exactly once, initial state stays silent.
 */
import { createRoot } from 'solid-js'
import { describe, expect, test } from 'vitest'

import { installTerminalChrome, type TerminalChromeSeam } from '../boundary/termChrome.ts'
import { createSessionStore } from '../logic/store.ts'
import {
  notifyEnabled,
  promptNotification,
  sanitizeOscText,
  TURN_COMPLETE_NOTIFICATION,
  windowTitleFor
} from '../logic/termChrome.ts'
import { TerminalChrome } from '../view/terminalChrome.tsx'

const ESC = '\u001b'
const BEL = '\u0007'

describe('windowTitleFor — title shaping', () => {
  test('generic until the session is titled', () => {
    expect(windowTitleFor(undefined)).toBe('Hermes Agent')
    expect(windowTitleFor('')).toBe('Hermes Agent')
    expect(windowTitleFor('   ')).toBe('Hermes Agent')
  })

  test('session title gets the — Hermes suffix', () => {
    expect(windowTitleFor('fix the flaky tests')).toBe('fix the flaky tests — Hermes')
  })

  test('long titles are capped', () => {
    const long = 'x'.repeat(200)
    expect(windowTitleFor(long).length).toBeLessThanOrEqual(80 + ' — Hermes'.length)
    expect(windowTitleFor(long)).toContain('…')
  })
})

describe('sanitizeOscText — escape-splice safety', () => {
  test('control chars (incl. ESC/BEL) can never splice a sequence', () => {
    expect(sanitizeOscText(`evil${ESC}]0;pwned${BEL}title`)).toBe('evil ]0;pwned title')
  })

  test('whitespace collapses; ends trimmed', () => {
    expect(sanitizeOscText('  a\n\tb  ')).toBe('a b')
  })
})

describe('installTerminalChrome — native triggerNotification transport', () => {
  /** A minimal fake renderer matching the RendererSeam the boundary casts to.
   *  Records triggerNotification calls and lets a test fire focus/blur. */
  function fakeRenderer() {
    const calls: Array<{ message: string; title: string | undefined }> = []
    let focusCb: (() => void) | undefined
    let blurCb: (() => void) | undefined
    const renderer = {
      isDestroyed: false,
      setTerminalTitle: () => {},
      writeOut: () => {},
      triggerNotification: (message: string, title?: string) => {
        calls.push({ message, title })
        return true
      },
      on: (event: 'focus' | 'blur', cb: () => void) => {
        if (event === 'focus') focusCb = cb
        else blurCb = cb
      },
      once: () => {}
    }
    // installTerminalChrome takes a CliRenderer; the boundary only touches the
    // shape above, so the cast is safe for this seam test.
    return {
      calls,
      fireBlur: () => blurCb?.(),
      fireFocus: () => focusCb?.(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      seam: installTerminalChrome(renderer as any)
    }
  }

  test('notify calls native triggerNotification(message=body, title=heading)', () => {
    const { calls, seam } = fakeRenderer()
    seam.notify({ title: 'Hermes', body: 'finished — awaiting your input' })
    expect(calls).toEqual([{ message: 'finished — awaiting your input', title: 'Hermes' }])
  })

  test('body-less notification uses the title as the message', () => {
    const { calls, seam } = fakeRenderer()
    seam.notify({ title: 'Hermes' })
    expect(calls).toEqual([{ message: 'Hermes', title: 'Hermes' }])
  })

  test('an empty title fires nothing', () => {
    const { calls, seam } = fakeRenderer()
    seam.notify({ title: '   ' })
    expect(calls).toEqual([])
  })

  test('control chars in the body are sanitized before the native call', () => {
    const { calls, seam } = fakeRenderer()
    seam.notify({ title: 'Hermes', body: `evil${ESC}]0;pwned${BEL}done` })
    expect(calls).toHaveLength(1)
    expect(calls.at(0)?.message).toBe('evil ]0;pwned done')
  })

  test('focus suppression: silent once the terminal reports focus, resumes on blur', () => {
    const { calls, fireBlur, fireFocus, seam } = fakeRenderer()
    fireFocus() // terminal is focused → suppress
    seam.notify({ title: 'Hermes', body: 'a' })
    expect(calls).toHaveLength(0)
    fireBlur() // unfocused → notify again
    seam.notify({ title: 'Hermes', body: 'b' })
    expect(calls).toEqual([{ message: 'b', title: 'Hermes' }])
  })
})

describe('promptNotification + env gate', () => {
  test('every known prompt kind has copy; unknown kinds fall back', () => {
    for (const kind of ['clarify', 'approval', 'sudo', 'secret', 'confirm', 'someday-new']) {
      const n = promptNotification(kind)
      expect(n.title).toBe('Hermes')
      expect(n.body).toBeTruthy()
    }
    expect(promptNotification('someday-new').body).toBe('is waiting for your input')
  })

  test('HERMES_TUI_NOTIFY=0/false/off disables; default on', () => {
    expect(notifyEnabled({})).toBe(true)
    expect(notifyEnabled({ HERMES_TUI_NOTIFY: '1' })).toBe(true)
    expect(notifyEnabled({ HERMES_TUI_NOTIFY: '0' })).toBe(false)
    expect(notifyEnabled({ HERMES_TUI_NOTIFY: 'false' })).toBe(false)
    expect(notifyEnabled({ HERMES_TUI_NOTIFY: 'off' })).toBe(false)
  })
})

describe('<TerminalChrome> wiring — store edges drive the seam', () => {
  function mount() {
    const store = createSessionStore()
    const titles: Array<string | undefined> = []
    const notifications: string[] = []
    const seam: TerminalChromeSeam = {
      setTitle: t => titles.push(t),
      notify: n => notifications.push(n.body ?? n.title)
    }
    const dispose = createRoot(d => {
      TerminalChrome({ chrome: seam, store })
      return d
    })
    return { dispose, notifications, store, titles }
  }

  test('sets the generic title immediately, then tracks session.info title', () => {
    const { dispose, store, titles } = mount()
    try {
      expect(titles).toEqual([undefined]) // boot → windowTitleFor(undefined) inside the seam
      store.apply({ type: 'session.info', payload: { title: 'rename the moon' } })
      expect(titles).toEqual([undefined, 'rename the moon'])
    } finally {
      dispose()
    }
  })

  test('a live session.title push retitles the window chrome without restart', () => {
    const { dispose, store, titles } = mount()
    try {
      store.apply({
        type: 'session.title',
        session_id: 'live-1',
        payload: { session_id: 'db-key-9', title: 'name it the moment it starts' }
      })
      expect(titles).toEqual([undefined, 'name it the moment it starts'])
      // a blank push is inert — the window keeps the landed title.
      store.apply({ type: 'session.title', session_id: 'live-1', payload: { title: '  ' } })
      expect(titles).toEqual([undefined, 'name it the moment it starts'])
    } finally {
      dispose()
    }
  })

  test('a blocking prompt notifies once; initial state is silent', () => {
    const { dispose, notifications, store } = mount()
    try {
      expect(notifications).toEqual([])
      store.apply({
        type: 'clarify.request',
        payload: { choices: null, question: 'which one?', request_id: 'r1' }
      })
      expect(notifications).toEqual(['needs an answer to continue'])
      // clearing the prompt does not notify again
      store.clearPrompt()
      expect(notifications).toEqual(['needs an answer to continue'])
    } finally {
      dispose()
    }
  })

  test('turn completion (running true→false) notifies; boot idle does not', () => {
    const { dispose, notifications, store } = mount()
    try {
      store.apply({ type: 'message.start' })
      expect(notifications).toEqual([])
      store.apply({ type: 'message.complete', payload: { text: 'done' } })
      expect(notifications).toEqual([TURN_COMPLETE_NOTIFICATION.body])
    } finally {
      dispose()
    }
  })
})
