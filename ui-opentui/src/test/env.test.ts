import { describe, expect, test } from 'vitest'

import {
  dashboardTuiMode,
  envFlag,
  envOutputLines,
  envOutputUnlimited,
  envToggle,
  heapdumpOnStart,
  launchCwd,
  noConfirmDestructive,
  resolveMouseEnabled,
  scrollSpeedMultiplier,
  startupImage,
  startupPrompt
} from '../logic/env.ts'

describe('dashboardTuiMode (hosted PTY contract)', () => {
  test('reads only HERMES_TUI_DASHBOARD with the shared boolean grammar', () => {
    expect(dashboardTuiMode({})).toBe(false)
    expect(dashboardTuiMode({ HERMES_TUI_DASHBOARD: '1' })).toBe(true)
    expect(dashboardTuiMode({ HERMES_TUI_DASHBOARD: ' yes ' })).toBe(true)
    expect(dashboardTuiMode({ HERMES_TUI_DASHBOARD: 'off' })).toBe(false)
    expect(dashboardTuiMode({ HERMES_TUI_INLINE: '1' })).toBe(false)
  })
})

describe('envFlag', () => {
  test('recognizes truthy values regardless of case/whitespace', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', ' on ']) {
      expect(envFlag(v, false)).toBe(true)
    }
  })

  test('recognizes falsy values regardless of case/whitespace', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'No', ' off ']) {
      expect(envFlag(v, true)).toBe(false)
    }
  })

  test('returns fallback when unset', () => {
    expect(envFlag(undefined, true)).toBe(true)
    expect(envFlag(undefined, false)).toBe(false)
    expect(envFlag('', true)).toBe(true)
    expect(envFlag('   ', false)).toBe(false)
  })

  test('returns fallback for unrecognized garbage', () => {
    expect(envFlag('maybe', true)).toBe(true)
    expect(envFlag('maybe', false)).toBe(false)
    expect(envFlag('2', true)).toBe(true)
    expect(envFlag('enabled', false)).toBe(false)
  })
})

describe('envOutputLines (HERMES_TUI_TOOL_OUTPUT_LINES)', () => {
  test('unset → Infinity (UNLIMITED by default — the env var RESTORES a cap)', () => {
    expect(envOutputLines(undefined)).toBe(Number.POSITIVE_INFINITY)
    expect(envOutputLines('')).toBe(Number.POSITIVE_INFINITY)
    expect(envOutputLines('   ')).toBe(Number.POSITIVE_INFINITY)
  })

  test('a positive integer → that cap (whitespace-tolerant)', () => {
    expect(envOutputLines('50')).toBe(50)
    expect(envOutputLines(' 50 ')).toBe(50)
    expect(envOutputLines('1')).toBe(1)
    expect(envOutputLines('200')).toBe(200)
    expect(envOutputLines('1000')).toBe(1000)
  })

  test('"0" → Infinity too (back-compat with the old opt-in "unlimited" value)', () => {
    expect(envOutputLines('0')).toBe(Number.POSITIVE_INFINITY)
  })

  test('garbage → Infinity (unrecognized ≙ no cap asked for)', () => {
    expect(envOutputLines('unlimited')).toBe(Number.POSITIVE_INFINITY)
    expect(envOutputLines('-5')).toBe(Number.POSITIVE_INFINITY)
    expect(envOutputLines('1.5')).toBe(Number.POSITIVE_INFINITY)
    expect(envOutputLines('50 lines')).toBe(Number.POSITIVE_INFINITY)
  })

  test('envOutputUnlimited: true unless an explicit finite cap was asked for', () => {
    expect(envOutputUnlimited(undefined)).toBe(true)
    expect(envOutputUnlimited('')).toBe(true)
    expect(envOutputUnlimited('   ')).toBe(true)
    expect(envOutputUnlimited('0')).toBe(true)
    expect(envOutputUnlimited('garbage')).toBe(true)
    expect(envOutputUnlimited('50')).toBe(false)
    expect(envOutputUnlimited('200')).toBe(false)
  })
})

describe('launchCwd (session.create cwd)', () => {
  test('prefers HERMES_CWD (real launch dir the hermes launcher exports)', () => {
    expect(launchCwd({ HERMES_CWD: '/home/u/proj', TERMINAL_CWD: '/other' })).toBe('/home/u/proj')
  })

  test('falls back to TERMINAL_CWD when HERMES_CWD is unset/blank', () => {
    expect(launchCwd({ TERMINAL_CWD: '/home/u/wt' })).toBe('/home/u/wt')
    expect(launchCwd({ HERMES_CWD: '  ', TERMINAL_CWD: '/home/u/wt' })).toBe('/home/u/wt')
  })

  test('falls back to process.cwd() (non-empty) when no launcher env set', () => {
    expect(launchCwd({})).toBe(process.cwd())
  })
})

describe('envToggle (tri-state)', () => {
  test('true/false for recognized values, null otherwise', () => {
    expect(envToggle('on')).toBe(true)
    expect(envToggle('0')).toBe(false)
    expect(envToggle(undefined)).toBe(null)
    expect(envToggle('')).toBe(null)
    expect(envToggle('maybe')).toBe(null)
  })
})

describe('resolveMouseEnabled (defers to Ink env surface)', () => {
  test('default ON when nothing is set', () => {
    expect(resolveMouseEnabled({})).toBe(true)
  })

  test('HERMES_TUI_MOUSE_TRACKING is the highest-precedence force knob', () => {
    // beats DISABLE_MOUSE and the MOUSE alias either way (toggle values, matching
    // Ink's parseToggle — the granular off|wheel|buttons|all lives in config.yaml,
    // the env var is on/off only).
    expect(
      resolveMouseEnabled({ HERMES_TUI_MOUSE_TRACKING: 'off', HERMES_TUI_DISABLE_MOUSE: '0', HERMES_TUI_MOUSE: '1' })
    ).toBe(false)
    expect(
      resolveMouseEnabled({ HERMES_TUI_MOUSE_TRACKING: 'on', HERMES_TUI_DISABLE_MOUSE: '1', HERMES_TUI_MOUSE: '0' })
    ).toBe(true)
  })

  test('an UNRECOGNIZED tracking value falls through to the next rung (Ink parity)', () => {
    // Ink's parseToggle returns null for non-toggle strings like "all", so the
    // legacy kill switch / alias / default decide.
    expect(resolveMouseEnabled({ HERMES_TUI_MOUSE_TRACKING: 'all' })).toBe(true)
    expect(resolveMouseEnabled({ HERMES_TUI_MOUSE_TRACKING: 'all', HERMES_TUI_DISABLE_MOUSE: '1' })).toBe(false)
  })

  test('legacy HERMES_TUI_DISABLE_MOUSE=1 kill switch (below TRACKING)', () => {
    expect(resolveMouseEnabled({ HERMES_TUI_DISABLE_MOUSE: '1' })).toBe(false)
    // ...but an explicit TRACKING toggle still wins over the legacy kill switch
    expect(resolveMouseEnabled({ HERMES_TUI_DISABLE_MOUSE: '1', HERMES_TUI_MOUSE_TRACKING: 'on' })).toBe(true)
  })

  test('HERMES_TUI_MOUSE alias is honored (kept — OpenTUI-native + launcher sets it)', () => {
    expect(resolveMouseEnabled({ HERMES_TUI_MOUSE: '0' })).toBe(false)
    expect(resolveMouseEnabled({ HERMES_TUI_MOUSE: '1' })).toBe(true)
    // alias sits below DISABLE_MOUSE: kill switch wins
    expect(resolveMouseEnabled({ HERMES_TUI_DISABLE_MOUSE: '1', HERMES_TUI_MOUSE: '1' })).toBe(false)
  })
})

describe('startupPrompt (--tui "prompt" seed)', () => {
  test('HERMES_TUI_QUERY wins (the launcher contract Ink also reads)', () => {
    expect(startupPrompt({ HERMES_TUI_QUERY: 'hi', HERMES_TUI_PROMPT: 'other' }, ['argv'])).toBe('hi')
  })

  test('HERMES_TUI_PROMPT is the OpenTUI alias fallback', () => {
    expect(startupPrompt({ HERMES_TUI_PROMPT: 'from prompt' }, [])).toBe('from prompt')
  })

  test('bare argv tail is the last fallback (standalone dev)', () => {
    expect(startupPrompt({}, ['hello', 'world'])).toBe('hello world')
  })

  test('blank/unset → undefined', () => {
    expect(startupPrompt({}, [])).toBeUndefined()
    expect(startupPrompt({ HERMES_TUI_QUERY: '   ' }, [])).toBeUndefined()
  })
})

describe('startupImage (--image seed)', () => {
  test('reads HERMES_TUI_IMAGE path (the launcher sets it; was silently dropped)', () => {
    expect(startupImage({ HERMES_TUI_IMAGE: '/tmp/a.png' })).toBe('/tmp/a.png')
    expect(startupImage({ HERMES_TUI_IMAGE: ' /tmp/b.png ' })).toBe('/tmp/b.png')
  })

  test('blank/unset → undefined', () => {
    expect(startupImage({})).toBeUndefined()
    expect(startupImage({ HERMES_TUI_IMAGE: '   ' })).toBeUndefined()
  })
})

describe('noConfirmDestructive (HERMES_TUI_NO_CONFIRM)', () => {
  test('truthy skips the confirm; default off; Ink parity', () => {
    expect(noConfirmDestructive({})).toBe(false)
    expect(noConfirmDestructive({ HERMES_TUI_NO_CONFIRM: '1' })).toBe(true)
    expect(noConfirmDestructive({ HERMES_TUI_NO_CONFIRM: 'true' })).toBe(true)
    expect(noConfirmDestructive({ HERMES_TUI_NO_CONFIRM: '0' })).toBe(false)
  })
})

describe('heapdumpOnStart (HERMES_HEAPDUMP_ON_START)', () => {
  test('truthy enables; default off', () => {
    expect(heapdumpOnStart({})).toBe(false)
    expect(heapdumpOnStart({ HERMES_HEAPDUMP_ON_START: 'on' })).toBe(true)
    expect(heapdumpOnStart({ HERMES_HEAPDUMP_ON_START: 'no' })).toBe(false)
  })
})

describe('scrollSpeedMultiplier (HERMES_TUI_SCROLL_SPEED)', () => {
  test('null when unset/garbage (keep native scroll behavior)', () => {
    expect(scrollSpeedMultiplier({})).toBeNull()
    expect(scrollSpeedMultiplier({ HERMES_TUI_SCROLL_SPEED: '' })).toBeNull()
    expect(scrollSpeedMultiplier({ HERMES_TUI_SCROLL_SPEED: 'fast' })).toBeNull()
    expect(scrollSpeedMultiplier({ HERMES_TUI_SCROLL_SPEED: '0' })).toBeNull()
    expect(scrollSpeedMultiplier({ HERMES_TUI_SCROLL_SPEED: '-2' })).toBeNull()
  })

  test('a positive value is honored and clamped to 20', () => {
    expect(scrollSpeedMultiplier({ HERMES_TUI_SCROLL_SPEED: '3' })).toBe(3)
    expect(scrollSpeedMultiplier({ HERMES_TUI_SCROLL_SPEED: '1.5' })).toBe(1.5)
    expect(scrollSpeedMultiplier({ HERMES_TUI_SCROLL_SPEED: '999' })).toBe(20)
  })

  test('CLAUDE_CODE_SCROLL_SPEED is the portability fallback (HERMES wins)', () => {
    expect(scrollSpeedMultiplier({ CLAUDE_CODE_SCROLL_SPEED: '4' })).toBe(4)
    expect(scrollSpeedMultiplier({ HERMES_TUI_SCROLL_SPEED: '2', CLAUDE_CODE_SCROLL_SPEED: '9' })).toBe(2)
  })
})
