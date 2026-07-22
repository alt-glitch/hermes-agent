/**
 * Theme SDK token contract — the OpenTUI port of upstream a8444bfc (cross-surface
 * skin shape), 30ee6f74 (ui_tool/ui_thinking + skinnable diffs), 3ba6eebc
 * (syntax_* palette keys), and cd05498e (paired light_colors/dark_colors).
 *
 * Behavior-level only: decode + RELATIONSHIPS between tokens (alias precedence,
 * fallback parents, polarity overlay selection), never palette snapshots.
 *
 * HONEST SCOPE / live-smoke note: the pipeline tests prove skin.changed →
 * schema decode → store → theme signal → view bindings. They CANNOT prove the
 * live native repaint (the headless renderer force-flushes every frame, and
 * uncontrolled native renderables — `<textarea>`, native `<markdown>` bodies —
 * cache colors at mount). The native `<markdown>` body (reasoning text, code
 * blocks) never paints headlessly at all. To verify those live: build
 * (`node scripts/build.mjs`), launch `HERMES_TUI_ENGINE=opentui hermes` in a
 * real terminal/tmux, run `/skin <name>` where the skin sets `background`,
 * `ui_tool`, `ui_thinking`, `syntax_*`, and `diff_*`, and confirm the canvas,
 * running tool glyph, reasoning body, code-block highlighting, and file-diff
 * line fills recolor without a restart.
 */
import { RGBA } from '@opentui/core'
import { Schema } from 'effect'
import { describe, expect, test, vi } from 'vitest'

import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import { createSessionStore } from '../logic/store.ts'
import { DARK_THEME, fromSkin, skinColorsForPolarity, themeFromSkin } from '../logic/theme.ts'
import { App } from '../view/App.tsx'
import { syntaxStyleFor } from '../view/markdown.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

const decodeEvent = Schema.decodeUnknownOption(GatewayEventSchema)

const hex = (c: RGBA): string => {
  const h = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase()
}

describe('background alias — canvas bg (theme-sdk `background` ⇄ engine `ui_bg`)', () => {
  test('`background` alone drives the canvas bg', () => {
    expect(fromSkin({ background: '#112233' }, {}).color.bg).toBe('#112233')
  })

  test('`ui_bg` stays the more specific key and wins over the alias', () => {
    expect(fromSkin({ background: '#112233', ui_bg: '#0A0A0A' }, {}).color.bg).toBe('#0A0A0A')
  })

  test('no key → the default (unpainted) canvas is unchanged', () => {
    expect(fromSkin({}, {}).color.bg).toBe(DARK_THEME.color.bg)
  })
})

describe('polarity palette selection — paired light_colors/dark_colors overlays', () => {
  const skin = {
    colors: { ui_accent: '#111111', ui_text: '#EEEEEE' },
    dark_colors: { ui_accent: '#333333' },
    light_colors: { ui_accent: '#222222' }
  }

  test('light terminal prefers light_colors; dark prefers dark_colors', () => {
    expect(skinColorsForPolarity(skin, true).ui_accent).toBe('#222222')
    expect(skinColorsForPolarity(skin, false).ui_accent).toBe('#333333')
  })

  test('the paired block OVERLAYS the base palette — unlisted keys survive', () => {
    expect(skinColorsForPolarity(skin, true).ui_text).toBe('#EEEEEE')
    expect(skinColorsForPolarity(skin, false).ui_text).toBe('#EEEEEE')
  })

  test('an absent or empty paired block leaves the base palette untouched', () => {
    expect(skinColorsForPolarity({ colors: skin.colors }, true)).toEqual(skin.colors)
    expect(skinColorsForPolarity({ colors: skin.colors, light_colors: {} }, true)).toEqual(skin.colors)
  })

  test('themeFromSkin resolves the overlay against the DETECTED polarity', () => {
    vi.stubEnv('HERMES_TUI_LIGHT', '1')
    try {
      expect(themeFromSkin(skin).color.accent).toBe('#222222')
    } finally {
      vi.unstubAllEnvs()
    }
    vi.stubEnv('HERMES_TUI_LIGHT', '0')
    try {
      expect(themeFromSkin(skin).color.accent).toBe('#333333')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('element/syntax/diff token routing — overridable, defaults track parents', () => {
  test('ui_tool routes to color.tool; default tracks the resolved accent', () => {
    expect(fromSkin({ ui_tool: '#123456' }, {}).color.tool).toBe('#123456')
    // relationship, not a snapshot: with no ui_tool the marker IS the accent
    expect(fromSkin({ ui_accent: '#ABCDEF' }, {}).color.tool).toBe('#ABCDEF')
  })

  test('ui_thinking routes to color.thinking; default tracks the EFFECTIVE muted', () => {
    expect(fromSkin({ ui_thinking: '#654321' }, {}).color.thinking).toBe('#654321')
    // recoloring muted (ui_muted) carries the reasoning body with it
    expect(fromSkin({ ui_muted: '#445566' }, {}).color.thinking).toBe('#445566')
  })

  test('syntax_* route to their tokens; defaults keep the highlighter byte-identical', () => {
    const skinned = fromSkin(
      {
        syntax_comment: '#040404',
        syntax_keyword: '#030303',
        syntax_number: '#020202',
        syntax_string: '#010101'
      },
      {}
    ).color
    expect(skinned.syntaxString).toBe('#010101')
    expect(skinned.syntaxNumber).toBe('#020202')
    expect(skinned.syntaxKeyword).toBe('#030303')
    expect(skinned.syntaxComment).toBe('#040404')

    // default relationships (string→label, number/keyword→accent, comment→muted)
    const plain = fromSkin({}, {}).color
    expect(plain.syntaxString).toBe(plain.label)
    expect(plain.syntaxNumber).toBe(plain.accent)
    expect(plain.syntaxKeyword).toBe(plain.accent)
    expect(plain.syntaxComment).toBe(plain.muted)
    // and they follow the parent when the SKIN moves the parent
    const relabeled = fromSkin({ ui_label: '#775500' }, {}).color
    expect(relabeled.syntaxString).toBe('#775500')
  })

  test('the native highlighter reads the syntax tokens (not the brand tokens)', () => {
    const theme = fromSkin({ syntax_comment: '#040404', syntax_string: '#010101' }, {})
    const style = syntaxStyleFor(theme)
    expect(hex(style.getStyle('string')?.fg ?? RGBA.fromHex('#000000'))).toBe('#010101')
    expect(hex(style.getStyle('comment')?.fg ?? RGBA.fromHex('#000000'))).toBe('#040404')
    // untouched families still ride their brand parents
    const plain = syntaxStyleFor(fromSkin({}, {}))
    expect(hex(plain.getStyle('string')?.fg ?? RGBA.fromHex('#000000'))).toBe(
      hex(RGBA.fromHex(fromSkin({}, {}).color.label))
    )
  })

  test('diff_* route to the Ink-parity tokens AND alias the native line fills', () => {
    const skinned = fromSkin(
      {
        diff_added: '#0A3A0A',
        diff_added_word: '#00AA00',
        diff_removed: '#3A0A0A',
        diff_removed_word: '#AA0000'
      },
      {}
    ).color
    expect(skinned.diffAdded).toBe('#0A3A0A')
    expect(skinned.diffRemoved).toBe('#3A0A0A')
    expect(skinned.diffAddedWord).toBe('#00AA00')
    expect(skinned.diffRemovedWord).toBe('#AA0000')
    // native `<diff>` line backgrounds pick up the cross-surface key…
    expect(skinned.diffAddedBg).toBe('#0A3A0A')
    expect(skinned.diffRemovedBg).toBe('#3A0A0A')
    // …unless the engine-specific *_bg key overrides it
    const specific = fromSkin({ diff_added: '#0A3A0A', diff_added_bg: '#114411' }, {}).color
    expect(specific.diffAddedBg).toBe('#114411')
    expect(specific.diffAdded).toBe('#0A3A0A')
    // no keys → defaults unchanged
    expect(fromSkin({}, {}).color.diffAddedBg).toBe(DARK_THEME.color.diffAddedBg)
  })
})

describe('wire decode — skin payloads with paired palettes', () => {
  test('skin.changed with light_colors/dark_colors decodes and RETAINS them', () => {
    const decoded = decodeEvent({
      payload: {
        colors: { ui_accent: '#111111' },
        dark_colors: { ui_accent: '#333333' },
        light_colors: { ui_accent: '#222222' },
        name: 'aurora'
      },
      type: 'skin.changed'
    })
    expect(decoded._tag).toBe('Some')
    if (decoded._tag !== 'Some') return
    const event = decoded.value
    if (event.type !== 'skin.changed') throw new Error('wrong variant')
    expect(event.payload?.light_colors?.ui_accent).toBe('#222222')
    expect(event.payload?.dark_colors?.ui_accent).toBe('#333333')
  })

  test('an OLD payload without paired palettes still decodes (back-compat)', () => {
    const decoded = decodeEvent({ payload: { colors: { ui_tool: '#123456' } }, type: 'skin.changed' })
    expect(decoded._tag).toBe('Some')
  })
})

describe('live skin.changed data pipeline — store → theme → chrome binding', () => {
  test('skin.changed re-derives the theme (new tokens included) without a remount', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    // a RUNNING tool part so the ⚡ marker (the ui_tool consumer) is mounted
    store.apply({ type: 'message.start' })
    store.apply({ type: 'tool.start', payload: { name: 'terminal', tool_id: 't1' } })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { height: 24, width: 100 }
    )
    try {
      store.apply({
        payload: { colors: { ui_thinking: '#665544', ui_tool: '#123456' } },
        type: 'skin.changed'
      })
      await probe.settle()
      // the theme carries the routed tokens (Solid setState merges the path,
      // so assert the VALUES the views bind to, not object identity)
      expect(store.state.theme.color.tool).toBe('#123456')
      expect(store.state.theme.color.thinking).toBe('#665544')
      // …and the mounted running-tool glyph re-binds to it (data pipeline —
      // NOT proof of live native repaint; see the file header)
      let toolGlyphFg: string | undefined
      for (const line of probe.spans().lines) {
        for (const s of line.spans) {
          if (s.text.includes('⚡') && s.fg) toolGlyphFg = hex(s.fg)
        }
      }
      expect(toolGlyphFg).toBe('#123456')
    } finally {
      probe.destroy()
    }
  })
})
