/**
 * Terminal chrome + theme parity (lane `chrome`):
 *   1. split tab (OSC 1) / window (OSC 2) titles with ⚠/⏳/✓ markers, model + cwd (Ink f1a91ad416)
 *   2. skin-owned terminal default fg/bg via OSC 10/11, OSC 110/111 restore, ansi256→hex
 *      (Ink 727f6704a7, 1f652214df, 0b1ee22b9e)
 *   3. terminal background probe → light/dark polarity through core's themeMode/THEME_MODE,
 *      with the #000000 distrust rule, env pins and env fallback retained, re-evaluated live
 *   4. gateway `reaction` decoded → brief ♥ flash in the status bar (Ink fbefb5c075)
 */
import { Option, Schema } from 'effect'
import { createRoot } from 'solid-js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import { installTerminalChrome, type TerminalChromeSeam } from '../boundary/termChrome.ts'
import { installThemeProbe, parseColorReplies } from '../boundary/themeProbe.ts'
import { SERVER_REQUEST_PROMPTS } from '../boundary/gateway/serverRequests.ts'
import { createSessionStore } from '../logic/store.ts'
import {
  defaultColorSlot,
  terminalDefaultsFor,
  type TerminalTitles,
  terminalTitlesFor,
  titleMarker,
  titleSequences
} from '../logic/termChrome.ts'
import {
  DARK_THEME,
  detectLightMode,
  LIGHT_THEME,
  polarityFromForeground,
  resolveProbedPolarity,
  setProbedPolarity,
  type TerminalPolarity,
  themeToneHex
} from '../logic/theme.ts'
import { GOOD_VIBES_FLASH_MS, StatusBar } from '../view/statusBar.tsx'
import { TerminalChrome } from '../view/terminalChrome.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

const ESC = '\u001b'
const BEL = '\u0007'
const decode = Schema.decodeUnknownOption(GatewayEventSchema)

const HOST_KEYS = [
  'HERMES_TUI_LIGHT',
  'HERMES_TUI_THEME',
  'HERMES_TUI_BACKGROUND',
  'COLORFGBG',
  'TERM_PROGRAM',
  'COLORTERM'
]
const stubHostEnv = (overrides: Record<string, string> = {}) => {
  for (const key of HOST_KEYS) vi.stubEnv(key, overrides[key] ?? '')
}

beforeEach(() => {
  stubHostEnv()
  setProbedPolarity(null)
})
afterEach(() => {
  setProbedPolarity(null)
  vi.unstubAllEnvs()
})

/** Fake renderer covering the chrome + probe seams. */
function fakeRenderer() {
  const writes: string[] = []
  const nativeTitles: string[] = []
  const listeners = new Map<string, Array<(arg?: unknown) => void>>()
  const inputHandlers: Array<(sequence: string) => boolean> = []
  let destroyCb: (() => void) | undefined
  const renderer = {
    isDestroyed: false,
    themeMode: null as TerminalPolarity | null,
    setTerminalTitle: (t: string) => void nativeTitles.push(t),
    writeOut: (chunk: string) => void writes.push(chunk),
    triggerNotification: () => true,
    on: (event: string, cb: (arg?: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb])
    },
    off: (event: string, cb: (arg?: unknown) => void) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter(l => l !== cb)
      )
    },
    once: (event: string, cb: () => void) => {
      if (event === 'destroy') destroyCb = cb
    },
    waitForThemeMode: () => Promise.resolve(renderer.themeMode),
    prependInputHandler: (h: (sequence: string) => boolean) => void inputHandlers.unshift(h),
    removeInputHandler: (h: (sequence: string) => boolean) => {
      const i = inputHandlers.indexOf(h)
      if (i >= 0) inputHandlers.splice(i, 1)
    }
  }
  return {
    renderer,
    writes,
    nativeTitles,
    inputHandlers,
    /** Simulate core: feed the raw reply through handlers, then set mode + emit THEME_MODE. */
    answer: (sequence: string, mode: TerminalPolarity) => {
      for (const h of inputHandlers) h(sequence)
      const changed = renderer.themeMode !== mode
      renderer.themeMode = mode
      if (changed) for (const l of listeners.get('theme_mode') ?? []) l(mode)
    },
    destroy: () => {
      renderer.isDestroyed = true
      destroyCb?.()
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    asCli: () => renderer as any
  }
}

// ── 1. titles ───────────────────────────────────────────────────────────

describe('tab/window title split (OSC 1 / OSC 2)', () => {
  test('marker: ⚠ blocked on a gateway prompt, ⏳ running, ✓ idle; client confirm is not blocking', () => {
    expect(titleMarker('approval', true)).toBe('⚠')
    expect(titleMarker('clarify', false)).toBe('⚠')
    expect(titleMarker('sudo', false)).toBe('⚠')
    expect(titleMarker('secret', false)).toBe('⚠')
    expect(titleMarker('vaultUnlock', false)).toBe('⚠')
    expect(titleMarker('confirm', true)).toBe('⏳')
    expect(titleMarker(undefined, true)).toBe('⏳')
    expect(titleMarker(undefined, false)).toBe('✓')
    expect(titleMarker(undefined, undefined)).toBe('✓')
  })

  test('tab = marker + session; window = marker + session · model · cwd (provider prefix and HOME elided)', () => {
    const titles = terminalTitlesFor(
      { marker: '⏳', sessionTitle: 'fix the flaky tests', model: 'anthropic/claude-opus', cwd: '/home/u/src/app' },
      '/home/u'
    )
    expect(titles).toEqual({
      tab: '⏳ fix the flaky tests',
      window: '⏳ fix the flaky tests · claude-opus · ~/src/app'
    })
  })

  test('untitled session still marks; generic brand before the model is known', () => {
    expect(terminalTitlesFor({ marker: '✓', model: 'm', cwd: '/x' }, '/home/u')).toEqual({
      tab: '✓',
      window: '✓ m · /x'
    })
    expect(terminalTitlesFor({ marker: '⏳', sessionTitle: 'a' })).toEqual({ window: 'Hermes' })
  })

  test('long names and cwds are capped; control chars cannot splice an escape', () => {
    const t = terminalTitlesFor(
      { marker: '✓', sessionTitle: `${'n'.repeat(60)}${ESC}]0;x${BEL}`, model: 'm', cwd: '/a/' + 'd'.repeat(80) },
      '/home/u'
    )
    expect(t.tab?.length).toBeLessThanOrEqual(2 + 28)
    expect(t.window).toMatch(/· …d{23}$/)
    // eslint-disable-next-line no-control-regex
    expect(`${t.tab}${t.window}`).not.toMatch(/[\u0000-\u001f]/)
  })

  test('sequences: split pair → OSC 1 + OSC 2; single → OSC 0', () => {
    expect(titleSequences({ tab: 'T', window: 'W' })).toBe(`${ESC}]1;T${BEL}${ESC}]2;W${BEL}`)
    expect(titleSequences({ window: 'Hermes' })).toBe(`${ESC}]0;Hermes${BEL}`)
  })

  test('boundary writes OSC 1/2 through writeOut (not the OSC 0-only native call), de-duplicated', () => {
    const fake = fakeRenderer()
    const seam = installTerminalChrome(fake.asCli(), { isTTY: true }, 'linux')
    fake.writes.length = 0
    seam.setTitles({ tab: '✓ a', window: '✓ a · m' })
    seam.setTitles({ tab: '✓ a', window: '✓ a · m' })
    expect(fake.writes).toEqual([`${ESC}]1;✓ a${BEL}${ESC}]2;✓ a · m${BEL}`])
    expect(fake.nativeTitles).toEqual([])
  })

  test('win32 keeps the native title call with the window string', () => {
    const fake = fakeRenderer()
    const seam = installTerminalChrome(fake.asCli(), { isTTY: true }, 'win32')
    seam.setTitles({ tab: '✓ a', window: '✓ a · m' })
    expect(fake.nativeTitles).toEqual(['✓ a · m'])
  })

  test('wiring: the marker follows the turn and blocking prompts live', () => {
    const store = createSessionStore()
    const titles: TerminalTitles[] = []
    const seam: TerminalChromeSeam = {
      bell: () => {},
      notify: () => {},
      setDefaultColors: () => {},
      setTitles: t => void titles.push(t)
    }
    const dispose = createRoot(d => {
      TerminalChrome({ chrome: seam, store, themeProbe: () => () => {} })
      return d
    })
    try {
      store.apply({ type: 'session.info', payload: { model: 'openai/gpt-x', cwd: '/w', title: 'moon' } })
      expect(titles.at(-1)).toEqual({ tab: '✓ moon', window: '✓ moon · gpt-x · /w' })
      store.apply({ type: 'session.info', payload: { running: true } })
      expect(titles.at(-1)?.tab).toBe('⏳ moon')
      store.openPrompt(
        SERVER_REQUEST_PROMPTS['clarify'].open('r1', {
          questions: [{ choices: null, qid: 'q0', question: 'which?' }],
          session_id: 's'
        })
      )
      expect(titles.at(-1)?.tab).toBe('⚠ moon')
      store.clearPrompt()
      expect(titles.at(-1)?.tab).toBe('⏳ moon')
      store.apply({ type: 'session.info', payload: { running: false } })
      expect(titles.at(-1)?.tab).toBe('✓ moon')
    } finally {
      dispose()
    }
  })
})

// ── 2. terminal default colors ──────────────────────────────────────────

describe('skin-owned terminal default fg/bg (OSC 10/11)', () => {
  test('themeToneHex resolves ansi256 through the xterm cube/ramp; hex passes; junk → ""', () => {
    expect(themeToneHex('ansi256(238)')).toBe('#444444')
    expect(themeToneHex('ansi256(196)')).toBe('#ff0000')
    expect(themeToneHex('#AbCdEf')).toBe('#abcdef')
    expect(themeToneHex('ansi256(300)')).toBe('')
    expect(themeToneHex('transparent')).toBe('')
  })

  test('a paintable canvas owns both defaults; no canvas owns neither', () => {
    expect(terminalDefaultsFor({ color: { bg: '#f6f9fd', text: 'ansi256(238)' } }, themeToneHex)).toEqual({
      bg: '#f6f9fd',
      fg: '#444444'
    })
    expect(terminalDefaultsFor({ color: { bg: 'transparent', text: '#ffffff' } }, themeToneHex)).toEqual({
      bg: '',
      fg: ''
    })
  })

  test('slot: paints, de-duplicates, restores only what it painted', () => {
    const slot = defaultColorSlot(11)
    expect(slot.set('')).toBe('') // never painted → untouched terminal
    expect(slot.restoreSeq()).toBe('')
    expect(slot.set('#112233')).toBe(`${ESC}]11;#112233${BEL}`)
    expect(slot.set('#112233')).toBe('')
    expect(slot.restoreSeq()).toBe(`${ESC}]111${BEL}`)
    expect(slot.set('')).toBe(`${ESC}]111${BEL}`)
    expect(slot.set('')).toBe('')
  })

  test('boundary: paint on skin, OSC 110/111 on skin change; inert off a TTY', () => {
    const fake = fakeRenderer()
    const seam = installTerminalChrome(fake.asCli(), { isTTY: true }, 'linux')
    fake.writes.length = 0
    seam.setDefaultColors({ fg: '#444444', bg: '#f6f9fd' })
    expect(fake.writes).toEqual([`${ESC}]10;#444444${BEL}${ESC}]11;#f6f9fd${BEL}`])
    seam.setDefaultColors({ fg: '', bg: '' })
    expect(fake.writes.at(-1)).toBe(`${ESC}]110${BEL}${ESC}]111${BEL}`)
    const notTty = fakeRenderer()
    const quiet = installTerminalChrome(notTty.asCli(), { isTTY: false }, 'linux')
    notTty.writes.length = 0
    quiet.setDefaultColors({ fg: '#444444', bg: '#f6f9fd' })
    expect(notTty.writes).toEqual([])
  })

  test('boundary: exit restore carries OSC 110 + 111 only when painted', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const painted = fakeRenderer()
      installTerminalChrome(painted.asCli(), { isTTY: true }, 'linux').setDefaultColors({
        fg: '#010101',
        bg: '#020202'
      })
      painted.destroy()
      expect(spy.mock.calls.at(-1)?.[0]).toBe(`${ESC}]110${BEL}${ESC}]111${BEL}${ESC}[23;0t`)

      const clean = fakeRenderer()
      installTerminalChrome(clean.asCli(), { isTTY: true }, 'linux')
      clean.destroy()
      expect(spy.mock.calls.at(-1)?.[0]).toBe(`${ESC}[23;0t`)
    } finally {
      spy.mockRestore()
    }
  })

  test('wiring: skin.changed with a background paints; reverting to a canvas-less skin restores', () => {
    const store = createSessionStore()
    const colors: Array<{ fg: string; bg: string }> = []
    const seam: TerminalChromeSeam = {
      bell: () => {},
      notify: () => {},
      setDefaultColors: c => void colors.push({ ...c }),
      setTitles: () => {}
    }
    const dispose = createRoot(d => {
      TerminalChrome({ chrome: seam, store, themeProbe: () => () => {} })
      return d
    })
    try {
      expect(colors.at(-1)).toEqual({ fg: '', bg: '' })
      store.apply({ type: 'skin.changed', payload: { colors: { background: '#fafafa', ui_text: '#222222' } } })
      expect(colors.at(-1)).toEqual({ fg: '#222222', bg: '#fafafa' })
      store.apply({ type: 'skin.changed', payload: { colors: {} } })
      expect(colors.at(-1)).toEqual({ fg: '', bg: '' })
    } finally {
      dispose()
    }
  })
})

// ── 3. polarity probe ───────────────────────────────────────────────────

describe('terminal background probe → light/dark polarity', () => {
  test('precedence: env pins > live probe > env fallback', () => {
    expect(detectLightMode(process.env, new Set(), 'light')).toBe(true)
    expect(detectLightMode({ HERMES_TUI_THEME: 'dark' }, new Set(), 'light')).toBe(false)
    expect(detectLightMode({ HERMES_TUI_LIGHT: '1' }, new Set(), 'dark')).toBe(true)
    // probe outranks the weaker env hints
    expect(detectLightMode({ HERMES_TUI_BACKGROUND: '#ffffff', COLORFGBG: '0;15' }, new Set(), 'dark')).toBe(false)
    // no probe answer → env fallback retained
    expect(detectLightMode({ COLORFGBG: '0;15' }, new Set(), null)).toBe(true)
    expect(detectLightMode({}, new Set(), null)).toBe(false)
  })

  test('#000000 background is distrusted; the OSC 10 foreground decides', () => {
    expect(resolveProbedPolarity('dark', { background: '#000000' })).toBeNull()
    expect(resolveProbedPolarity('dark', { background: '#000000', foreground: '#1a1a1a' })).toBe('light')
    expect(resolveProbedPolarity('dark', { background: '#000000', foreground: '#e0e0e0' })).toBe('dark')
    expect(resolveProbedPolarity('dark', { background: '#1e1e1e' })).toBe('dark')
    expect(resolveProbedPolarity('light', { background: '#fdf6e3' })).toBe('light')
    expect(polarityFromForeground('#ffffff')).toBeNull()
    expect(polarityFromForeground('#808080')).toBeNull()
  })

  test('parses rgb: and #hex replies, BEL or ST terminated', () => {
    expect(parseColorReplies(`${ESC}]11;rgb:0000/0000/0000${ESC}\\${ESC}]10;rgb:ffff/ffff/ffff${BEL}`)).toEqual({
      background: '#000000',
      foreground: '#ffffff'
    })
    expect(parseColorReplies(`${ESC}]11;#FDF6E3${BEL}`)).toEqual({ background: '#fdf6e3' })
    expect(parseColorReplies('plain input')).toEqual({})
  })

  test('boundary: reports core THEME_MODE changes live; observer never consumes input; disposes', async () => {
    const fake = fakeRenderer()
    const seen: Array<TerminalPolarity | null> = []
    const dispose = installThemeProbe(fake.asCli(), m => void seen.push(m))
    expect(fake.inputHandlers).toHaveLength(1)
    expect(fake.inputHandlers[0]?.(`${ESC}]11;#ffffff${BEL}`)).toBe(false)

    fake.answer(`${ESC}]10;#202020${BEL}${ESC}]11;#fdf6e3${BEL}`, 'light')
    await Promise.resolve()
    expect(seen).toEqual(['light'])
    // a later DSR 997 flip re-queries; core emits THEME_MODE again
    fake.answer(`${ESC}]10;#eeeeee${BEL}${ESC}]11;#1e1e1e${BEL}`, 'dark')
    await Promise.resolve()
    expect(seen).toEqual(['light', 'dark'])

    dispose()
    expect(fake.inputHandlers).toHaveLength(0)
  })

  test('boundary: core says dark for an unset #000000 canvas, the light foreground wins', async () => {
    const fake = fakeRenderer()
    const seen: Array<TerminalPolarity | null> = []
    installThemeProbe(fake.asCli(), m => void seen.push(m))
    fake.answer(`${ESC}]10;rgb:1a1a/1a1a/1a1a${BEL}${ESC}]11;rgb:0000/0000/0000${BEL}`, 'dark')
    await Promise.resolve()
    expect(seen).toEqual(['light'])
  })

  test('boundary: a renderer without the API stays silent (env fallback keeps deciding)', () => {
    const seen: unknown[] = []
    const bare = { on: () => {}, once: () => {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = installThemeProbe(bare as any, m => void seen.push(m))
    expect(seen).toEqual([])
    dispose()
  })

  test('wiring: a probe answer re-derives the skinless theme live, and back', () => {
    const store = createSessionStore()
    let report: ((mode: TerminalPolarity | null) => void) | undefined
    const seam: TerminalChromeSeam = {
      bell: () => {},
      notify: () => {},
      setDefaultColors: () => {},
      setTitles: () => {}
    }
    const dispose = createRoot(d => {
      TerminalChrome({
        chrome: seam,
        store,
        themeProbe: cb => {
          report = cb
          return () => {}
        }
      })
      return d
    })
    try {
      store.apply({ type: 'skin.changed', payload: { colors: { ui_accent: '#123456' } } })
      expect(store.state.theme.color.statusBg).toBe(DARK_THEME.color.statusBg)
      report?.('light')
      expect(store.state.theme.color.statusBg).toBe(LIGHT_THEME.color.statusBg)
      expect(store.state.theme.color.accent).toBe('#123456') // same skin, new pole
      report?.(null) // probe went untrusted → env fallback (dark here)
      expect(store.state.theme.color.statusBg).toBe(DARK_THEME.color.statusBg)
    } finally {
      dispose()
    }
  })

  test('wiring: an env pin outranks the probe', () => {
    stubHostEnv({ HERMES_TUI_THEME: 'dark' })
    const store = createSessionStore()
    let report: ((mode: TerminalPolarity | null) => void) | undefined
    const seam: TerminalChromeSeam = {
      bell: () => {},
      notify: () => {},
      setDefaultColors: () => {},
      setTitles: () => {}
    }
    const dispose = createRoot(d => {
      TerminalChrome({
        chrome: seam,
        store,
        themeProbe: cb => {
          report = cb
          return () => {}
        }
      })
      return d
    })
    try {
      report?.('light')
      expect(store.state.theme.color.statusBg).toBe(DARK_THEME.color.statusBg)
    } finally {
      dispose()
    }
  })
})

// ── 4. reaction ♥ flash ─────────────────────────────────────────────────

describe('gateway reaction → status-bar ♥ flash', () => {
  test('decodes `reaction` (kind optional, unknown keys kept)', () => {
    const event = decode({ type: 'reaction', session_id: 's1', payload: { kind: 'heart', extra: 1 } })
    expect(Option.isSome(event)).toBe(true)
    expect(Option.getOrUndefined(event)).toEqual({
      type: 'reaction',
      session_id: 's1',
      payload: { kind: 'heart', extra: 1 }
    })
    expect(Option.isSome(decode({ type: 'reaction' }))).toBe(true)
  })

  test('each reaction bumps the store beat', () => {
    const store = createSessionStore()
    expect(store.state.goodVibesTick).toBe(0)
    store.apply({ type: 'reaction', payload: { kind: 'heart' } })
    store.apply({ type: 'reaction' })
    expect(store.state.goodVibesTick).toBe(2)
  })

  test('the status bar shows ♥ briefly, then clears', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.applyInfo({ model: 'm', cwd: '/tmp/p' })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <StatusBar store={store} />
        </ThemeProvider>
      ),
      { width: 80, height: 3 }
    )
    try {
      expect(probe.frame()).not.toContain('♥')
      store.apply({ type: 'reaction', payload: { kind: 'heart' } })
      await probe.settle()
      expect(probe.frame()).toContain('♥')
      await new Promise(resolve => setTimeout(resolve, GOOD_VIBES_FLASH_MS + 100))
      await probe.settle()
      expect(probe.frame()).not.toContain('♥')
    } finally {
      probe.destroy()
    }
  })
})

describe('skins never mutate the shared default theme', () => {
  test('a skinned store leaves DEFAULT/DARK themes intact for the next store', () => {
    const before = JSON.stringify(DARK_THEME)
    const store = createSessionStore()
    store.apply({ type: 'skin.changed', payload: { colors: { background: '#fafafa' }, branding: { agent_name: 'Z' } } })
    expect(JSON.stringify(DARK_THEME)).toBe(before)
    expect(createSessionStore().state.theme.brand.name).not.toBe('Z')
  })
})
