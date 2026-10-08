/**
 * Slash-command parity lane: /fast ultrafast, session-scoped catalog /
 * completion / reload RPCs, the live /theme pin + display.tui_theme hydrate,
 * and /theme-info diagnostics (Ink bdde674296, 9b0ca895b3, cd05498e2c,
 * 6982c61b8c, c543c691fc).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { dispatchSlash, planCompletion, type SlashContext } from '../logic/slash.ts'
import { createSessionStore } from '../logic/store.ts'
import { DARK_THEME, LIGHT_THEME, lightModeSource, type Theme } from '../logic/theme.ts'
import { createThemePin, themePin, tuiThemeFromConfig } from '../logic/themePin.ts'
import { scriptedRpc } from './lib/scriptedRpc.ts'

type Responder = (method: string, params: Record<string, unknown>) => Promise<unknown>

interface Probe {
  readonly ctx: SlashContext
  readonly calls: Array<{ method: string; params: Record<string, unknown> }>
  readonly system: string[]
  readonly reapplied: { value: number }
}

/** A minimal SlashContext: the members these commands use are real; every
 *  other capability is an inert no-op (they are never reached here). */
function makeCtx(respond: Responder, extra: Partial<SlashContext> = {}, sid: string | null = 'sid-1'): Probe {
  const calls: Probe['calls'] = []
  const system: string[] = []
  const reapplied = { value: 0 }
  const base: Partial<SlashContext> = {
    request: scriptedRpc((method, params) => {
      calls.push({ method, params: { ...params } })
      return respond(method, { ...params })
    }),
    sessionId: () => sid ?? undefined,
    sessionOwnerId: () => sid ?? undefined,
    pushSystem: text => void system.push(text),
    commandCatalog: () => undefined,
    refreshCommandCatalog: () => {},
    openPager: () => {},
    helpHeader: () => 'Commands',
    reapplyTheme: () => {
      reapplied.value += 1
    },
    ...extra
  }
  const ctx = new Proxy(base, {
    get: (target, key: string) => (key in target ? target[key as keyof SlashContext] : () => undefined)
  }) as SlashContext
  return { calls, ctx, reapplied, system }
}

const PREV_THEME = process.env.HERMES_TUI_THEME
const PREV_LIGHT = process.env.HERMES_TUI_LIGHT
const PREV_BG = process.env.HERMES_TUI_BACKGROUND

beforeEach(() => {
  delete process.env.HERMES_TUI_THEME
  delete process.env.HERMES_TUI_LIGHT
  delete process.env.HERMES_TUI_BACKGROUND
})

afterEach(() => {
  // Drop any config-owned pin a test left on the process-wide singleton.
  themePin.apply('auto')
  for (const [key, value] of [
    ['HERMES_TUI_THEME', PREV_THEME],
    ['HERMES_TUI_LIGHT', PREV_LIGHT],
    ['HERMES_TUI_BACKGROUND', PREV_BG]
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('/fast ultrafast tier', () => {
  test('accepts ultrafast, writes it through config.set and echoes the tier', async () => {
    const p = makeCtx(async (_method, params) => ({ value: params.value ?? 'ultrafast' }))
    await dispatchSlash('/fast ultrafast', p.ctx)
    await dispatchSlash('/fast status', p.ctx)
    expect(p.calls).toEqual([
      { method: 'config.set', params: { key: 'fast', session_id: 'sid-1', value: 'ultrafast' } },
      { method: 'config.get', params: { key: 'fast', session_id: 'sid-1' } }
    ])
    expect(p.system).toEqual(['fast mode: ultrafast', 'fast mode: ultrafast'])
  })

  test('usage lists ultrafast; unknown gateway values still read as normal', async () => {
    const usage = makeCtx(async () => ({}))
    await dispatchSlash('/fast warp', usage.ctx)
    expect(usage.calls).toEqual([])
    expect(usage.system).toEqual(['usage: /fast [normal|fast|ultrafast|auto|cold|status|on|off|toggle]'])

    const odd = makeCtx(async () => ({ value: 'priority' }))
    await dispatchSlash('/fast', odd.ctx)
    expect(odd.system).toEqual(['fast mode: normal'])
  })
})

describe('session_id on commands.catalog / complete.slash / skills.reload', () => {
  test('complete.slash names the asking session; session-less plans stay unscoped', () => {
    expect(planCompletion('/mod', 4, 'sid-9')).toEqual({
      from: 0,
      method: 'complete.slash',
      params: { session_id: 'sid-9', text: '/mod' }
    })
    expect(planCompletion('run /cle', 8, 'sid-9')?.params).toEqual({ session_id: 'sid-9', text: '/cle' })
    expect(planCompletion('/mod', 4)?.params).toEqual({ text: '/mod' })
    // complete.path is not a skills surface: never scoped.
    expect(planCompletion('@src', 4, 'sid-9')?.params).not.toHaveProperty('session_id')
  })

  test('/reload-skills and the /help catalog fetch carry session_id only when a session exists', async () => {
    const respond: Responder = async method =>
      method === 'skills.reload' ? { output: 'ok', result: { added: [], removed: [] } } : { pairs: [] }
    const live = makeCtx(respond)
    await dispatchSlash('/reload-skills', live.ctx)
    await dispatchSlash('/help', live.ctx)
    expect(live.calls).toEqual([
      { method: 'skills.reload', params: { session_id: 'sid-1' } },
      { method: 'commands.catalog', params: { session_id: 'sid-1' } },
      { method: 'commands.catalog', params: { session_id: 'sid-1' } }
    ])

    const detached = makeCtx(respond, {}, null)
    await dispatchSlash('/reload-skills', detached.ctx)
    expect(detached.calls).toEqual([
      { method: 'skills.reload', params: {} },
      { method: 'commands.catalog', params: {} }
    ])
  })

  test('a session switch drops the previous session catalog so it is refetched per session', () => {
    const store = createSessionStore()
    store.setCommandCatalog({ pairs: [['/repo-a-skill', 'project skill']] })
    store.adoptFreshSession('sid-2')
    expect(store.state.commandCatalog).toBeUndefined()
  })
})

describe('/theme pin applied live + display.tui_theme hydrate', () => {
  test('pin: light/dark set HERMES_TUI_THEME; auto clears only a config-owned pin', () => {
    const env: Record<string, string | undefined> = {}
    const pin = createThemePin(env)
    expect(pin.apply('light')).toBe(true)
    expect(env.HERMES_TUI_THEME).toBe('light')
    expect(pin.owner()).toBe('config')
    expect(pin.apply('light')).toBe(false)
    expect(pin.apply('auto')).toBe(true)
    expect(env.HERMES_TUI_THEME).toBeUndefined()

    const shell: Record<string, string | undefined> = { HERMES_TUI_THEME: 'dark' }
    const shellPin = createThemePin(shell)
    expect(shellPin.owner()).toBe('shell')
    expect(shellPin.apply('auto')).toBe(false)
    expect(shell.HERMES_TUI_THEME).toBe('dark')
    // An agreeing config pin still takes ownership, so auto can clear it later.
    expect(shellPin.apply('dark')).toBe(false)
    expect(shellPin.apply('auto')).toBe(true)
    expect(shell.HERMES_TUI_THEME).toBeUndefined()
  })

  test('a hydrate captured before a /theme write is dropped (no stale revert)', () => {
    const env: Record<string, string | undefined> = {}
    const pin = createThemePin(env)
    const captured = pin.revision()
    pin.apply('light')
    expect(pin.hydrate('dark', captured)).toBe(false)
    expect(env.HERMES_TUI_THEME).toBe('light')
    expect(pin.hydrate('dark', pin.revision())).toBe(true)
    expect(env.HERMES_TUI_THEME).toBe('dark')
  })

  test('tuiThemeFromConfig reads display.tui_theme defensively', () => {
    expect(tuiThemeFromConfig({ display: { tui_theme: 'light' } })).toBe('light')
    expect(tuiThemeFromConfig({ display: { tui_theme: 3 } })).toBeUndefined()
    expect(tuiThemeFromConfig({ display: null })).toBeUndefined()
    expect(tuiThemeFromConfig({})).toBeUndefined()
  })

  test('store.reapplyTheme re-derives the default and the current skin for the new polarity', () => {
    const store = createSessionStore()
    process.env.HERMES_TUI_THEME = 'light'
    store.reapplyTheme()
    expect(store.state.theme.color.text).toBe(LIGHT_THEME.color.text)

    store.apply({ type: 'skin.changed', payload: { branding: { agent_name: 'Aurora' } } })
    process.env.HERMES_TUI_THEME = 'dark'
    store.reapplyTheme()
    expect(store.state.theme.brand.name).toBe('Aurora')
    expect(store.state.theme.color.text).toBe(DARK_THEME.color.text)
  })

  test('/theme light re-themes only after config.set confirms', async () => {
    const p = makeCtx(async (_method, params) => ({ value: params.value }))
    await dispatchSlash('/theme light', p.ctx)
    expect(process.env.HERMES_TUI_THEME).toBe('light')
    expect(p.reapplied.value).toBe(1)
    expect(p.system).toEqual(['theme → light'])

    await dispatchSlash('/theme auto', p.ctx)
    expect(process.env.HERMES_TUI_THEME).toBeUndefined()
    expect(p.reapplied.value).toBe(2)

    const failing = makeCtx(async () => {
      throw new Error('read-only config')
    })
    await dispatchSlash('/theme dark', failing.ctx)
    expect(process.env.HERMES_TUI_THEME).toBeUndefined()
    expect(failing.reapplied.value).toBe(0)
    expect(failing.system).toEqual(['/theme: read-only config'])
  })
})

describe('/theme-info diagnostics', () => {
  test('reports the probe answer, polarity source and a palette summary', async () => {
    process.env.HERMES_TUI_BACKGROUND = '#ffffff'
    const theme: Theme = LIGHT_THEME
    const p = makeCtx(async () => ({}), { terminalThemeMode: () => 'light', theme: () => theme })
    await dispatchSlash('/theme-info', p.ctx)
    expect(p.calls).toEqual([])
    const out = p.system.join('\n')
    expect(out).toMatch(/terminal probe\s+light/)
    expect(out).toMatch(/HERMES_TUI_BACKGROUND\s+#ffffff/)
    expect(out).toMatch(/detected mode\s+light/)
    expect(out).toMatch(/polarity source\s+HERMES_TUI_BACKGROUND/)
    expect(out).toContain(`selectionBg`)
    expect(out).toContain(LIGHT_THEME.color.statusBg)
  })

  test('without a probe it says so and names the config pin as the source', async () => {
    const p = makeCtx(async (_method, params) => ({ value: params.value }), { terminalThemeMode: () => null })
    await dispatchSlash('/theme dark', p.ctx)
    await dispatchSlash('/theme-info', p.ctx)
    const out = p.system.at(-1) ?? ''
    expect(out).toMatch(/terminal probe\s+no reply/)
    expect(out).toMatch(/HERMES_TUI_THEME\s+dark \(config pin\)/)
    expect(out).toMatch(/polarity source\s+HERMES_TUI_THEME/)
  })

  test('lightModeSource follows detectLightMode precedence', () => {
    expect(lightModeSource({ HERMES_TUI_LIGHT: '1', HERMES_TUI_THEME: 'dark' })).toBe('HERMES_TUI_LIGHT')
    expect(lightModeSource({ COLORFGBG: '0;15' })).toBe('COLORFGBG')
    expect(lightModeSource({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('TERM_PROGRAM')
    expect(lightModeSource({})).toBe('default')
  })
})
