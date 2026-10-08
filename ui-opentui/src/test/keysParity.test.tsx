/**
 * Input/keybinding parity with Ink (lane: keys).
 *
 *  1. Esc Esc on an empty composer interrupts a running turn (Ink e49e359823);
 *     idle it still opens the prompt-history viewer.
 *  2. Ctrl+R is an alias for the F7 live-agent dock toggle (Ink 65ad5296ea).
 *  3. Ctrl+D exits only from an empty composer, and literal Ctrl+D works on
 *     macOS too (Ink b787fb9128).
 *  4. Composer Ctrl+X cuts a keyboard selection transactionally; Ctrl+C copies
 *     a Shift+arrow textarea selection before clear/interrupt (Ink be250390db,
 *     24af6685b0).
 *  5. Agents dashboard Enter on a LIVE agent opens the live tail (Ink 3863d13440).
 */
import { TextareaRenderable, type KeyEvent, type Renderable } from '@opentui/core'
import { describe, expect, test, vi } from 'vitest'

import { handleCtrlCKey } from '../boundary/renderer.ts'
import { createPromptHistory } from '../logic/history.ts'
import {
  composerHasDraft,
  emptyDoubleEscAction,
  isAgentsDockToggleKey,
  isExitHotkey,
  openTuiHotkeys,
  shouldExitOnHotkey
} from '../logic/hotkeys.ts'
import { createSessionStore } from '../logic/store.ts'
import { parseVoiceRecordKey } from '../logic/voiceKey.ts'
import { App } from '../view/App.tsx'
import { AgentsDashboard } from '../view/overlays/agentsDashboard.tsx'
import type { DashboardAgent } from '../view/overlays/agents/model.ts'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap(child => [child, ...descendants(child)])
}

function textarea(root: Renderable): TextareaRenderable {
  const found = descendants(root).find((item): item is TextareaRenderable => item instanceof TextareaRenderable)
  if (!found) throw new Error('composer textarea not mounted')
  return found
}

async function mountApp(opts: {
  busy?: boolean
  onInterruptTurn?: () => void
  onCut?: (t: string) => Promise<boolean>
}) {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.setSessionId('sid-1')
  // one prior prompt so the idle Esc Esc viewer has something to open
  store.pushUser('earlier prompt')
  store.apply({ type: 'message.start' })
  store.apply({ type: 'message.complete' })
  store.applyInfo({ running: false }) // server-confirmed idle settles the turn
  if (opts.busy) store.applyInfo({ running: true })
  const history = createPromptHistory({ initial: [] })
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} history={history} onInterruptTurn={opts.onInterruptTurn} onCutSelection={opts.onCut} />
      </ThemeProvider>
    ),
    { height: 30, kittyKeyboard: true, width: 80 }
  )
  return { history, probe, store }
}

async function doubleEsc(probe: Awaited<ReturnType<typeof renderProbe>>): Promise<void> {
  probe.keys.pressEscape()
  await probe.settle()
  probe.keys.pressEscape()
  await probe.settle()
}

const key = (name: string, mods: Partial<{ ctrl: boolean; meta: boolean; super: boolean; shift: boolean }> = {}) => ({
  ctrl: false,
  meta: false,
  name,
  ...mods
})

describe('1 · Esc Esc interrupts a running turn from an empty composer', () => {
  test('pure precedence: busy+session interrupts, idle keeps prompt history', () => {
    expect(emptyDoubleEscAction(true, true)).toBe('interrupt')
    expect(emptyDoubleEscAction(false, true)).toBe('prompt-history')
    expect(emptyDoubleEscAction(true, false)).toBe('prompt-history')
  })

  test('busy turn: Esc Esc calls the interrupt path and does not open prompt history', async () => {
    const interrupt = vi.fn()
    const h = await mountApp({ busy: true, onInterruptTurn: interrupt })
    try {
      await doubleEsc(h.probe)
      expect(interrupt).toHaveBeenCalledOnce()
      expect(h.store.state.promptHistory).toBe(false)
    } finally {
      h.probe.destroy()
    }
  })

  test('idle: Esc Esc still opens prompt history and never interrupts', async () => {
    const interrupt = vi.fn()
    const h = await mountApp({ onInterruptTurn: interrupt })
    try {
      await doubleEsc(h.probe)
      expect(interrupt).not.toHaveBeenCalled()
      expect(h.store.state.promptHistory).toBe(true)
    } finally {
      h.probe.destroy()
    }
  })

  test('busy with a draft: Esc Esc discards the draft (recallable) instead of interrupting', async () => {
    const interrupt = vi.fn()
    const h = await mountApp({ busy: true, onInterruptTurn: interrupt })
    try {
      await h.probe.keys.typeText('half typed')
      await h.probe.settle()
      await doubleEsc(h.probe)
      expect(interrupt).not.toHaveBeenCalled()
      expect(textarea(h.probe.renderer.root).plainText).toBe('')
    } finally {
      h.probe.destroy()
    }
  })
})

describe('2 · Ctrl+R aliases the F7 dock toggle', () => {
  test('Ctrl+R and bare F7 toggle; modified variants do not', () => {
    expect(isAgentsDockToggleKey({ ...key('r', { ctrl: true }), shift: false })).toBe(true)
    expect(isAgentsDockToggleKey({ ...key('R', { ctrl: true }), shift: false })).toBe(true)
    expect(isAgentsDockToggleKey({ ...key('f7'), shift: false })).toBe(true)
    expect(isAgentsDockToggleKey({ ...key('r'), shift: false })).toBe(false)
    expect(isAgentsDockToggleKey({ ...key('r', { ctrl: true, meta: true }), shift: false })).toBe(false)
    expect(isAgentsDockToggleKey({ ...key('r', { ctrl: true }), shift: true })).toBe(false)
    expect(isAgentsDockToggleKey({ ...key('r', { ctrl: true }), eventType: 'release' })).toBe(false)
  })

  test('help copy advertises Ctrl+R / F7 and voice cannot claim ctrl+r', () => {
    expect(openTuiHotkeys('linux')).toContainEqual(['Ctrl+R / F7', 'collapse / restore live-agent dock'])
    expect(parseVoiceRecordKey('ctrl+r').raw).not.toBe('ctrl+r')
  })
})

describe('3 · Ctrl+D exits only from an empty composer, on macOS too', () => {
  const empty = {
    backgroundPanel: false,
    billing: undefined,
    composerDraft: '',
    dashboard: false,
    pager: undefined,
    pendingImages: [] as unknown[],
    picker: undefined,
    prompt: undefined,
    promptHistory: false,
    sessionPicker: undefined
  }

  test('literal Ctrl+D is an exit chord on macOS as well as Cmd+D', () => {
    expect(isExitHotkey(key('d', { ctrl: true }), 'darwin')).toBe(true)
    expect(isExitHotkey(key('d', { meta: true }), 'darwin')).toBe(true)
    expect(isExitHotkey(key('d', { ctrl: true }), 'linux')).toBe(true)
    expect(isExitHotkey(key('d', { ctrl: true, meta: true }), 'darwin')).toBe(true) // Cmd path
    expect(isExitHotkey(key('d', { meta: true }), 'linux')).toBe(false)
  })

  test('a draft or an attachment blocks the exit', () => {
    const ctrlD = key('d', { ctrl: true })
    expect(shouldExitOnHotkey(ctrlD, empty, 'linux')).toBe(true)
    expect(shouldExitOnHotkey(ctrlD, empty, 'darwin')).toBe(true)
    expect(shouldExitOnHotkey(ctrlD, { ...empty, composerDraft: 'unsent' }, 'linux')).toBe(false)
    expect(shouldExitOnHotkey(ctrlD, { ...empty, pendingImages: [{ path: '/tmp/a.png' }] }, 'darwin')).toBe(false)
    expect(shouldExitOnHotkey(ctrlD, { ...empty, dashboard: true }, 'linux')).toBe(false)
    expect(composerHasDraft({ composerDraft: '', pendingImages: [] })).toBe(false)
  })
})

describe('4 · keyboard selection copy (Ctrl+C) and transactional cut (Ctrl+X)', () => {
  async function selectTail(probe: Awaited<ReturnType<typeof renderProbe>>, chars: number): Promise<void> {
    for (let index = 0; index < chars; index++) probe.keys.pressArrow('left', { shift: true })
    await probe.settle()
  }

  test('Ctrl+X removes the selection only after the clipboard write succeeds', async () => {
    let resolveWrite: (ok: boolean) => void = () => {}
    const cut = vi.fn((_text: string) => new Promise<boolean>(resolve => (resolveWrite = resolve)))
    const h = await mountApp({ onCut: cut })
    try {
      await h.probe.keys.typeText('hello world')
      await h.probe.settle()
      await selectTail(h.probe, 5)
      h.probe.keys.pressKey('x', { ctrl: true })
      await h.probe.settle()
      expect(cut).toHaveBeenCalledWith('world')
      // write still pending → text intact
      expect(textarea(h.probe.renderer.root).plainText).toBe('hello world')
      resolveWrite(true)
      await vi.waitFor(() => expect(textarea(h.probe.renderer.root).plainText).toBe('hello '))
    } finally {
      h.probe.destroy()
    }
  })

  test('a failed clipboard write keeps the selected text (headless/SSH)', async () => {
    const cut = vi.fn(async () => false)
    const h = await mountApp({ onCut: cut })
    try {
      await h.probe.keys.typeText('keep me')
      await h.probe.settle()
      await selectTail(h.probe, 2)
      h.probe.keys.pressKey('x', { ctrl: true })
      await h.probe.settle()
      await Promise.resolve()
      await h.probe.settle()
      expect(cut).toHaveBeenCalledWith('me')
      expect(textarea(h.probe.renderer.root).plainText).toBe('keep me')
    } finally {
      h.probe.destroy()
    }
  })

  test('Ctrl+C copies a Shift+arrow selection instead of clearing the draft', async () => {
    const h = await mountApp({})
    const copied: string[] = []
    const onCtrlC = vi.fn()
    const listener = (event: KeyEvent) =>
      handleCtrlCKey(h.probe.renderer, { onCopySelection: text => void copied.push(text), onCtrlC }, event)
    h.probe.renderer.keyInput.on('keypress', listener)
    try {
      await h.probe.keys.typeText('draft text')
      await h.probe.settle()
      await selectTail(h.probe, 4)
      h.probe.keys.pressKey('c', { ctrl: true })
      await h.probe.settle()
      expect(copied).toEqual(['text'])
      expect(onCtrlC).not.toHaveBeenCalled()
      expect(textarea(h.probe.renderer.root).plainText).toBe('draft text')

      // No selection → falls through to the clear/interrupt machine.
      h.probe.keys.pressArrow('right')
      await h.probe.settle()
      h.probe.keys.pressKey('c', { ctrl: true })
      await h.probe.settle()
      expect(onCtrlC).toHaveBeenCalledOnce()
    } finally {
      h.probe.renderer.keyInput.off('keypress', listener)
      h.probe.destroy()
    }
  })
})

describe('5 · agents dashboard Enter opens the live tail for a live agent', () => {
  const live: DashboardAgent = { depth: 0, goal: 'Live child', id: 'live', index: 0, parentId: null, status: 'running' }
  const done: DashboardAgent = { ...live, goal: 'Finished child', id: 'done', status: 'completed', summary: 'DONE' }

  test('Enter on a running agent loads the live tail; hint says Enter/t tail', async () => {
    const loadTail = vi.fn(async () => ({ available: true, text: 'LIVE_TAIL_TEXT', truncated: false }))
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <AgentsDashboard subagents={[live]} onClose={() => {}} onLoadTail={loadTail} />
        </ThemeProvider>
      ),
      { height: 24, kittyKeyboard: true, width: 132 }
    )
    try {
      expect(probe.frame()).toContain('Enter/t tail · d detail')
      expect(probe.frame()).not.toContain('Enter inspect')
      probe.keys.pressEnter()
      await probe.settle()
      expect(loadTail).toHaveBeenCalledWith('live')
      expect(await probe.waitForFrame(frame => frame.includes('LIVE_TAIL_TEXT'))).toContain('Live transcript')
    } finally {
      probe.destroy()
    }
  })

  test('Enter on a finished agent still opens detail', async () => {
    const loadTail = vi.fn(async () => ({ available: true, text: 'NOPE', truncated: false }))
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <AgentsDashboard subagents={[done]} onClose={() => {}} onLoadTail={loadTail} />
        </ThemeProvider>
      ),
      { height: 24, kittyKeyboard: true, width: 132 }
    )
    try {
      expect(probe.frame()).toContain('Enter inspect · t tail')
      probe.keys.pressEnter()
      await probe.settle()
      expect(loadTail).not.toHaveBeenCalled()
      expect(probe.frame()).not.toContain('Live transcript')
    } finally {
      probe.destroy()
    }
  })
})
