/**
 * Visual-hierarchy design pass (Appendix C) — the ink budget. "Gold is the
 * single lamp: it sits on the newest answer and on the ❯ waiting for the next
 * command, nowhere else. Blue is the hum of machinery. Grey is everything that
 * merely happened."
 *
 * Layers:
 *   1. theme: `muted` is a TRUE NEUTRAL (no longer the gold hue family) in
 *      both themes; the new `bg` token paints the root canvas (skin override).
 *   2. glyph vocabulary: the per-tool glyph map (registry) — identity survives
 *      the default collapsed view.
 *   3. messageLine roles: earned gold (glyphColor), muted user body
 *      (bodyColor), turn boundary > part gap (turnSpacing), settled-turn
 *      narration demotion (lastTextId).
 *   4. frames: machinery indent (+2 under the turn) for tool + thinking rows.
 */
import { describe, expect, test } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { DARK_THEME, fromSkin, LIGHT_THEME } from '../logic/theme.ts'
import { App } from '../view/App.tsx'
import { bodyColor, glyphColor, lastTextId, turnSpacing } from '../view/messageLine.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { DEFAULT_TOOL_GLYPH, glyphFor, TOOL_GLYPHS } from '../view/tools/registry.tsx'
import { renderProbe } from './lib/render.ts'

// ── 1. theme: neutral muted + bg token ───────────────────────────────────

/** True when a hex color is achromatic (r=g=b — a pure grey, no hue). */
function isAchromatic(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return false
  return m[1] === m[2] && m[2] === m[3]
}

describe('theme — muted is a true neutral, not darker gold (design-pass precondition)', () => {
  test('DARK muted left the gold hue family: pure grey in the statusFg silver family', () => {
    expect(DARK_THEME.color.muted).toBe('#808080') // CSS gray — silver family, darker step
    expect(isAchromatic(DARK_THEME.color.muted)).toBe(true)
    expect(DARK_THEME.color.muted).not.toBe('#CC9B1F') // the old gold "dim"
  })

  test('LIGHT muted had the same disease — now neutral too', () => {
    expect(LIGHT_THEME.color.muted).toBe('#696969') // CSS dimgray
    expect(isAchromatic(LIGHT_THEME.color.muted)).toBe(true)
  })

  test('session label/border rode the gold muted — now the same neutral', () => {
    expect(isAchromatic(DARK_THEME.color.sessionLabel)).toBe(true)
    expect(isAchromatic(DARK_THEME.color.sessionBorder)).toBe(true)
  })

  test('bg token: TRANSPARENT by default — the terminal owns the canvas (glitch decision)', () => {
    expect(DARK_THEME.color.bg).toBe('transparent')
    expect(LIGHT_THEME.color.bg).toBe('transparent')
  })

  test('fromSkin: skins may override bg via ui_bg; default stays the theme bg', () => {
    expect(fromSkin({ ui_bg: '#101010' }, {}).color.bg).toBe('#101010')
    expect(fromSkin({}, {}).color.bg).toBe(DARK_THEME.color.bg)
  })

  test('muted no longer borrows banner_dim (the stock skin ships GOLD there — the live re-gold bug)', () => {
    // The default Hermes skin sends banner_dim '#B8860B'; borrowing it for
    // muted re-golded every dim surface in the live app. It must stay neutral.
    expect(fromSkin({ banner_dim: '#B8860B' }, {}).color.muted).toBe(DARK_THEME.color.muted)
  })

  test('skins keep a dedicated transcript-dim override: ui_muted', () => {
    expect(fromSkin({ ui_muted: '#445566' }, {}).color.muted).toBe('#445566')
  })
})

// ── 2. glyph vocabulary ──────────────────────────────────────────────────

describe('tool glyph vocabulary (registry) — identity survives the collapsed view', () => {
  test('the settled per-tool glyph map, pinned', () => {
    expect(TOOL_GLYPHS).toEqual({
      clarify: '?',
      delegate_task: '⚕',
      execute_code: '$',
      patch: '◆',
      process: '$',
      read_file: '◇',
      search_files: '○',
      skill_manage: '▲',
      skill_view: '▲',
      terminal: '$',
      todo: '☰',
      web_extract: '●',
      web_search: '●',
      write_file: '◆'
    })
  })

  test('MCP/unknown tools fall back to ◦', () => {
    expect(glyphFor('mcp_railway_deploy')).toBe(DEFAULT_TOOL_GLYPH)
    expect(glyphFor('totally_new_tool')).toBe('◦')
    expect(glyphFor('terminal')).toBe('$')
  })

  test('skin tool_emojis override the default glyph; absent override keeps default', () => {
    expect(glyphFor('terminal', { terminal: '⚔' })).toBe('⚔')
    expect(glyphFor('read_file', { terminal: '⚔' })).toBe('◇') // not overridden → default
    expect(glyphFor('mcp_x', { mcp_x: '🚀' })).toBe('🚀')
    expect(glyphFor('terminal', undefined)).toBe('$') // no overrides → default
  })
})

// ── 3. messageLine roles (pure) ──────────────────────────────────────────

const color = DARK_THEME.color

describe('glyphColor — gold is earned', () => {
  test('the user ❯ and the NEWEST answer ⚕ are primary; older answers grey', () => {
    expect(glyphColor('user', false, color)).toBe(color.primary)
    expect(glyphColor('assistant', true, color)).toBe(color.primary)
    expect(glyphColor('assistant', false, color)).toBe(color.muted)
    expect(glyphColor('system', false, color)).toBe(color.muted)
  })
})

describe('bodyColor — the answer is the only full-bright prose', () => {
  test('user body is muted (your words are context); assistant bright; system dim', () => {
    expect(bodyColor('user', color)).toBe(color.muted)
    expect(bodyColor('assistant', color)).toBe(color.text)
    expect(bodyColor('system', color)).toBe(color.muted)
  })
})

describe('turnSpacing — turn boundary > part gap', () => {
  test('a user turn gets blank space above AND below, MORE than the 1-row part gap', () => {
    const user = turnSpacing('user', false)
    expect(user.top).toBeGreaterThan(1) // above the prompt > part gap
    expect(user.bottom).toBeGreaterThanOrEqual(1) // blank line below too
    expect(turnSpacing('assistant', false)).toEqual({ bottom: 0, top: 1 })
    expect(turnSpacing('system', false)).toEqual({ bottom: 0, top: 1 })
  })

  test('/compact collapses all turn margins', () => {
    expect(turnSpacing('user', true)).toEqual({ bottom: 0, top: 0 })
    expect(turnSpacing('assistant', true)).toEqual({ bottom: 0, top: 0 })
  })
})

describe('lastTextId — settled-turn narration demotion', () => {
  test('finds the FINAL text part (the answer that keeps full-bright text)', () => {
    expect(
      lastTextId([
        { id: 'p1', text: 'Let me look…', type: 'text' },
        { id: 'p2', name: 'terminal', state: 'complete', type: 'tool' },
        { id: 'p3', text: 'The answer.', type: 'text' }
      ])
    ).toBe('p3')
  })

  test('no text parts → undefined (nothing demotes)', () => {
    expect(lastTextId([{ id: 'p1', name: 'terminal', state: 'complete', type: 'tool' }])).toBeUndefined()
    expect(lastTextId(undefined)).toBeUndefined()
    expect(lastTextId([])).toBeUndefined()
  })
})

// ── 4. frames: machinery indent ──────────────────────────────────────────

describe('machinery tier indent — tools + thinking nest +2 under the turn', () => {
  test('tool and Thought rows sit 2 columns right of where flat content starts', async () => {
    const store = createSessionStore()
    store.setDetails('collapsed', true)
    store.apply({ type: 'gateway.ready' })
    store.pushUser('inspect the files')
    store.apply({ type: 'message.start' })
    store.apply({ payload: { text: '**Plan**\n\nthink' }, type: 'reasoning.delta' })
    store.apply({ payload: { context: 'ls', name: 'terminal', tool_id: 't1' }, type: 'tool.start' })
    store.apply({
      payload: { args: { command: 'ls' }, duration_s: 0.1, name: 'terminal', result_text: 'a\nb', tool_id: 't1' },
      type: 'tool.complete'
    })
    store.apply({ type: 'message.complete' })

    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { height: 30, width: 80 }
    )
    try {
      const frame = await probe.waitForFrame(f => f.includes('terminal') && f.includes('inspect the files'))
      const rows = frame.split('\n')
      const userCol = (rows.find(r => r.includes('inspect the files')) ?? '').indexOf('inspect the files')
      const toolCol = (rows.find(r => r.includes('$ terminal')) ?? '').indexOf('$ terminal')
      const thoughtCol = (rows.find(r => r.includes('◐ Thought')) ?? '').indexOf('◐ Thought')
      expect(userCol).toBeGreaterThanOrEqual(0)
      // machinery rows start +2 columns right of base content (the user body
      // shares the parts column's base x — both sit after the 2-col gutter).
      expect(toolCol).toBe(userCol + 2)
      expect(thoughtCol).toBe(userCol + 2)
    } finally {
      probe.destroy()
    }
  })
})
