/**
 * Picker overlay tests (Epic 7 model picker v2; picker v2.1) — headless frames
 * with a simulated keyboard through the REAL component: provider group headers
 * render, typing into the NATIVE `<input>` filters live (fuzzy, incl.
 * provider-field matches; backspace + Alt+Backspace word-delete come from the
 * input), arrows traverse the flat item order ACROSS group boundaries (headers
 * skipped), Enter picks the highlighted value (cross-provider values carry
 * `--provider`), Esc closes, and a no-match query shows the empty state.
 *
 * v2.1: unconfigured-provider rows are hidden by default; Ctrl+U reveals them
 * dimmed + non-selectable (env-var hint, traversal skips them); Ctrl+R runs
 * the registered catalog re-fetch exactly once and swaps the rows live.
 */
import { afterEach, describe, expect, test } from 'vitest'

import { buildModelTabs, registerPickerRefresh, registerPickerTabs } from '../logic/slash.ts'
import type { PickerItem } from '../logic/store.ts'
import { DEFAULT_THEME } from '../logic/theme.ts'
import { Picker } from '../view/overlays/picker.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

// the Ctrl+R + tab-strip seams are module-level state — never leak them across tests
afterEach(() => {
  registerPickerRefresh(undefined)
  registerPickerTabs(undefined)
})

/** A grouped model catalog: current = claude-sonnet-4 under Anthropic. */
const ITEMS: PickerItem[] = [
  {
    current: true,
    group: 'Anthropic',
    haystacks: ['anthropic', 'Anthropic'],
    label: 'claude-sonnet-4',
    value: 'claude-sonnet-4 --provider anthropic'
  },
  {
    group: 'Anthropic',
    haystacks: ['anthropic', 'Anthropic'],
    label: 'claude-opus-4',
    value: 'claude-opus-4 --provider anthropic'
  },
  { group: 'OpenAI', haystacks: ['openai', 'OpenAI'], label: 'gpt-5', value: 'gpt-5 --provider openai' },
  {
    group: 'Nous Research',
    haystacks: ['nous', 'Nous Research'],
    label: 'hermes-4-405b',
    value: 'hermes-4-405b --provider nous'
  }
]

interface Harness {
  probe: RenderProbe
  picked: string[]
  closed: { value: boolean }
}

interface MountPickerOptions {
  errorLabel?: string
  initialRefresh?: boolean
  initialTab?: 'all' | 'current'
  loadingLabel?: string
}

async function mountPicker(items: PickerItem[] = ITEMS, options: MountPickerOptions = {}): Promise<Harness> {
  const picked: string[] = []
  const closed = { value: false }
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => DEFAULT_THEME}>
        <Picker
          title="Switch model"
          items={items}
          errorLabel={options.errorLabel ?? 'Could not load models'}
          initialRefresh={options.initialRefresh === true}
          initialTab={options.initialTab ?? 'current'}
          loadingLabel={options.loadingLabel ?? 'Loading…'}
          onPick={v => picked.push(v)}
          onClose={() => (closed.value = true)}
        />
      </ThemeProvider>
    ),
    // kitty keyboard so a SIMULATED lone Esc parses (see lib/render.ts)
    { height: 24, kittyKeyboard: true, width: 70 }
  )
  return { closed, picked, probe }
}

describe('Picker — grouped render', () => {
  test('group headers + items render; the current model carries the ✓', async () => {
    const h = await mountPicker()
    try {
      const frame = h.probe.frame()
      expect(frame).toContain('Anthropic')
      expect(frame).toContain('OpenAI')
      expect(frame).toContain('Nous Research')
      expect(frame).toContain('claude-sonnet-4 ✓')
      expect(frame).toContain('hermes-4-405b')
      // initial selection sits on the CURRENT model
      expect(frame).toContain('› claude-sonnet-4')
    } finally {
      h.probe.destroy()
    }
  })
})

describe('Picker — optimistic model hydration', () => {
  test('mounts a loading shell immediately, then swaps hydrated rows into the All page', async () => {
    let resolveLoad: (items: PickerItem[]) => void = () => {}
    registerPickerTabs(buildModelTabs)
    registerPickerRefresh(() => new Promise(resolve => (resolveLoad = resolve)))
    const h = await mountPicker([], { initialRefresh: true, initialTab: 'all', loadingLabel: 'Loading models…' })
    try {
      expect(h.probe.frame()).toContain('Loading models…')
      resolveLoad(ITEMS)
      await h.probe.settle()
      const frame = await h.probe.waitForFrame(value => value.includes('hermes-4-405b'))
      expect(stripLine(frame)).toContain('[ All ]')
      expect(frame).toContain('claude-sonnet-4 ✓')
      expect(frame).toContain('gpt-5')
      expect(frame).not.toContain('Loading models…')
    } finally {
      h.probe.destroy()
    }
  })

  test('shows a retryable error, then Ctrl+R recovers in place', async () => {
    let calls = 0
    registerPickerRefresh(() => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(ITEMS)
    })
    const h = await mountPicker([], { initialRefresh: true, loadingLabel: 'Loading models…' })
    try {
      const frame = await h.probe.waitForFrame(value => value.includes('Could not load models'))
      expect(frame).toContain('Ctrl+R retry')
      expect(frame).not.toContain('(no matches)')
      h.probe.keys.pressKey('r', { ctrl: true })
      await h.probe.settle()
      const recovered = await h.probe.waitForFrame(value => value.includes('hermes-4-405b'))
      expect(recovered).not.toContain('Could not load models')
      expect(calls).toBe(2)
    } finally {
      h.probe.destroy()
    }
  })

  test('ignores a late hydration result after the picker unmounts', async () => {
    let resolveLoad: (items: PickerItem[]) => void = () => {}
    registerPickerRefresh(() => new Promise(resolve => (resolveLoad = resolve)))
    const h = await mountPicker([], { initialRefresh: true })
    h.probe.destroy()
    resolveLoad(ITEMS)
    await Promise.resolve()
    await Promise.resolve()
  })
})

describe('Picker — fuzzy filtering', () => {
  test('typing filters live; a provider-field query (oai) keeps only that group', async () => {
    const h = await mountPicker()
    try {
      await h.probe.keys.typeText('oai')
      await h.probe.settle()
      const frame = await h.probe.waitForFrame(f => !f.includes('claude-sonnet-4'))
      expect(frame).toContain('gpt-5')
      expect(frame).toContain('OpenAI') // its group header survives
      expect(frame).not.toContain('hermes-4-405b')
      expect(frame).toContain('› gpt-5') // selection reset to the top match
    } finally {
      h.probe.destroy()
    }
  })

  test('son4 finds claude-sonnet-4; backspace widens the filter again', async () => {
    const h = await mountPicker()
    try {
      await h.probe.keys.typeText('son4')
      await h.probe.settle()
      let frame = await h.probe.waitForFrame(f => !f.includes('gpt-5'))
      expect(frame).toContain('claude-sonnet-4')
      for (let i = 0; i < 4; i++) h.probe.keys.pressBackspace()
      await h.probe.settle()
      frame = await h.probe.waitForFrame(f => f.includes('gpt-5'))
      expect(frame).toContain('hermes-4-405b')
    } finally {
      h.probe.destroy()
    }
  })

  test('a no-match query shows the empty state; Enter is a no-op', async () => {
    const h = await mountPicker()
    try {
      await h.probe.keys.typeText('zzzz')
      await h.probe.settle()
      const frame = await h.probe.waitForFrame(f => f.includes('(no matches)'))
      expect(frame).not.toContain('claude-sonnet-4')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.picked).toEqual([])
    } finally {
      h.probe.destroy()
    }
  })
})

describe('Picker — traversal across groups + pick + close', () => {
  test('↓↓ from the current item crosses the Anthropic→OpenAI boundary (header skipped); Enter picks cross-provider', async () => {
    const h = await mountPicker()
    try {
      // start: claude-sonnet-4 (flat 0) → ↓ claude-opus-4 (flat 1) → ↓ gpt-5
      // (flat 2 — FIRST item of the next group; the header row is not a stop)
      h.probe.keys.pressArrow('down')
      h.probe.keys.pressArrow('down')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('› gpt-5')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.picked).toEqual(['gpt-5 --provider openai']) // provider+model switch
    } finally {
      h.probe.destroy()
    }
  })

  test('↑ from the top wraps to the LAST item (across all groups)', async () => {
    const h = await mountPicker()
    try {
      // selection starts on the current item (flat 0)
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('› hermes-4-405b')
    } finally {
      h.probe.destroy()
    }
  })

  test('Esc closes without picking', async () => {
    const h = await mountPicker()
    try {
      h.probe.keys.pressEscape()
      await h.probe.settle()
      await h.probe.settle()
      expect(h.closed.value).toBe(true)
      expect(h.picked).toEqual([])
    } finally {
      h.probe.destroy()
    }
  })
})

describe('Picker — native input editing (v2.1)', () => {
  test('Alt+Backspace word-deletes the last query term (native input editing)', async () => {
    const h = await mountPicker()
    try {
      await h.probe.keys.typeText('claude opus')
      await h.probe.settle()
      let frame = await h.probe.waitForFrame(f => !f.includes('claude-sonnet-4'))
      expect(frame).toContain('claude-opus-4') // multi-term AND narrowed to one model
      h.probe.keys.pressBackspace({ meta: true }) // word-delete `opus` → query `claude `
      await h.probe.settle()
      frame = await h.probe.waitForFrame(f => f.includes('claude-sonnet-4'))
      expect(frame).toContain('claude-opus-4')
      expect(frame).not.toContain('hermes-4-405b') // `claude` still filters
    } finally {
      h.probe.destroy()
    }
  })
})

/** v2.1 catalog: configured groups (one with a display name ≠ slug) plus two
 *  UNCONFIGURED providers (`unavailable` hint rows), one of them sitting
 *  BETWEEN configured groups so traversal must skip across it. */
const MIXED: PickerItem[] = [
  {
    current: true,
    group: 'Anthropic',
    haystacks: ['anthropic', 'Anthropic'],
    label: 'claude-sonnet-4',
    value: 'claude-sonnet-4 --provider anthropic'
  },
  {
    group: 'Anthropic',
    haystacks: ['anthropic', 'Anthropic'],
    label: 'claude-opus-4',
    value: 'claude-opus-4 --provider anthropic'
  },
  {
    group: 'Mistral',
    haystacks: ['mistral', 'Mistral'],
    label: 'no API key — set MISTRAL_API_KEY',
    unavailable: true,
    value: 'mistral'
  },
  { group: 'OpenAI', haystacks: ['openai', 'OpenAI'], label: 'gpt-5', value: 'gpt-5 --provider openai' },
  {
    group: 'GitHub Copilot',
    haystacks: ['copilot', 'GitHub Copilot'],
    label: 'no API key — set GITHUB_TOKEN',
    unavailable: true,
    value: 'copilot'
  }
]

describe('Picker — unconfigured providers (Ctrl+U toggle, v2.1)', () => {
  test('hidden by default; Ctrl+U reveals dimmed env-var hints; Ctrl+U again hides', async () => {
    const h = await mountPicker(MIXED)
    try {
      let frame = h.probe.frame()
      expect(frame).not.toContain('Mistral')
      expect(frame).not.toContain('GITHUB_TOKEN')
      expect(frame).toContain('Ctrl+U show unconfigured') // footer-hinted
      h.probe.keys.pressKey('u', { ctrl: true })
      await h.probe.settle()
      frame = await h.probe.waitForFrame(f => f.includes('Mistral'))
      expect(frame).toContain('no API key — set MISTRAL_API_KEY')
      expect(frame).toContain('GitHub Copilot')
      expect(frame).toContain('no API key — set GITHUB_TOKEN')
      expect(frame).toContain('Ctrl+U hide unconfigured')
      h.probe.keys.pressKey('u', { ctrl: true })
      await h.probe.settle()
      frame = await h.probe.waitForFrame(f => !f.includes('Mistral'))
      expect(frame).not.toContain('GITHUB_TOKEN')
    } finally {
      h.probe.destroy()
    }
  })

  test('revealed rows are non-selectable: ↓↓ skips the Mistral hint; ↓ again wraps past the Copilot hint', async () => {
    const h = await mountPicker(MIXED)
    try {
      h.probe.keys.pressKey('u', { ctrl: true })
      await h.probe.settle()
      await h.probe.waitForFrame(f => f.includes('Mistral'))
      // selection reset to the top selectable (claude-sonnet-4) on toggle
      expect(h.probe.frame()).toContain('› claude-sonnet-4')
      h.probe.keys.pressArrow('down')
      h.probe.keys.pressArrow('down') // opus → (skip Mistral hint) → gpt-5
      await h.probe.settle()
      expect(h.probe.frame()).toContain('› gpt-5')
      h.probe.keys.pressArrow('down') // (skip trailing Copilot hint) → wrap to top
      await h.probe.settle()
      expect(h.probe.frame()).toContain('› claude-sonnet-4')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.picked).toEqual(['claude-sonnet-4 --provider anthropic']) // never a hint row
    } finally {
      h.probe.destroy()
    }
  })

  test('provider DISPLAY-NAME query narrows to the group in both views', async () => {
    // configured-only view: `research` matches only via the display name
    const items: PickerItem[] = [
      ...MIXED,
      {
        group: 'Nous Research',
        haystacks: ['nous', 'Nous Research'],
        label: 'hermes-4-405b',
        value: 'hermes-4-405b --provider nous'
      }
    ]
    const h = await mountPicker(items)
    try {
      await h.probe.keys.typeText('research')
      await h.probe.settle()
      let frame = await h.probe.waitForFrame(f => !f.includes('claude-sonnet-4'))
      expect(frame).toContain('hermes-4-405b')
      expect(frame).toContain('Nous Research')
      expect(frame).not.toContain('gpt-5')
      // toggled view: `github` matches the UNCONFIGURED GitHub Copilot group
      for (let i = 0; i < 8; i++) h.probe.keys.pressBackspace()
      h.probe.keys.pressKey('u', { ctrl: true })
      await h.probe.settle()
      await h.probe.keys.typeText('github')
      await h.probe.settle()
      frame = await h.probe.waitForFrame(f => f.includes('GITHUB_TOKEN') && !f.includes('claude-sonnet-4'))
      expect(frame).toContain('GitHub Copilot')
      expect(frame).not.toContain('hermes-4-405b')
      expect(frame).not.toContain('(no matches)') // hint rows alone are still matches
    } finally {
      h.probe.destroy()
    }
  })
})

describe('Picker — manual catalog refresh (Ctrl+R, v2.1)', () => {
  test('Ctrl+R runs the registered re-fetch ONCE, shows refreshing…, swaps the rows live', async () => {
    let calls = 0
    let resolveFetch: (items: PickerItem[]) => void = () => {}
    registerPickerRefresh(() => {
      calls++
      return new Promise<PickerItem[]>(resolve => (resolveFetch = resolve))
    })
    const h = await mountPicker()
    try {
      expect(h.probe.frame()).toContain('Ctrl+R refresh') // footer-hinted
      h.probe.keys.pressKey('r', { ctrl: true })
      await h.probe.settle()
      const pendingFrame = await h.probe.waitForFrame(f => f.includes('refreshing…'))
      expect(pendingFrame).toContain('claude-sonnet-4') // old rows stay while pending
      expect(calls).toBe(1)
      resolveFetch([
        {
          current: true,
          group: 'Anthropic',
          haystacks: ['anthropic', 'Anthropic'],
          label: 'claude-fresh-5',
          value: 'claude-fresh-5 --provider anthropic'
        }
      ])
      await h.probe.settle()
      const frame = await h.probe.waitForFrame(f => f.includes('claude-fresh-5'))
      expect(frame).not.toContain('claude-sonnet-4') // live swap, picker stays open
      expect(frame).not.toContain('refreshing…')
      expect(calls).toBe(1)
    } finally {
      h.probe.destroy()
    }
  })

  test('Ctrl+R without a registered re-fetch is a silent no-op (skills picker)', async () => {
    const h = await mountPicker()
    try {
      expect(h.probe.frame()).not.toContain('Ctrl+R refresh')
      h.probe.keys.pressKey('r', { ctrl: true })
      await h.probe.settle()
      expect(h.probe.frame()).toContain('claude-sonnet-4') // unchanged, no crash
    } finally {
      h.probe.destroy()
    }
  })
})

/** The chip-strip line of a frame: the active chip is always bracketed and the
 *  trailing `All` chip always present, which no other picker line has both of. */
function stripLine(frame: string): string {
  return frame.split('\n').find(l => l.includes('All') && l.includes('[ ')) ?? ''
}

describe('Picker — provider tabs (v2.2 chip strip)', () => {
  test('chips order Nous-first then catalog order then All; open lands on the CURRENT provider tab with the ✓ selected', async () => {
    registerPickerTabs(buildModelTabs)
    const h = await mountPicker() // catalog order: Anthropic, OpenAI, Nous Research
    try {
      const frame = h.probe.frame()
      const strip = stripLine(frame)
      // Nous hoisted ahead of catalog order; All trails; current (Anthropic) chip active.
      expect(strip.indexOf('Nous Research')).toBeGreaterThanOrEqual(0)
      expect(strip.indexOf('Nous Research')).toBeLessThan(strip.indexOf('Anthropic'))
      expect(strip.indexOf('Anthropic')).toBeLessThan(strip.indexOf('OpenAI'))
      expect(strip.indexOf('OpenAI')).toBeLessThan(strip.indexOf('All'))
      expect(strip).toContain('[ Anthropic ]')
      // rows are tab-filtered to the active provider; ✓ row selected.
      expect(frame).toContain('› claude-sonnet-4 ✓')
      expect(frame).toContain('claude-opus-4')
      expect(frame).not.toContain('gpt-5')
      expect(frame).not.toContain('hermes-4-405b')
      // footer hints the strip
      expect(frame).toContain('Tab provider')
    } finally {
      h.probe.destroy()
    }
  })

  test('Tab cycles forward and WRAPS (… → OpenAI → All → Nous → …); Shift+Tab cycles back; returning lands on the ✓', async () => {
    registerPickerTabs(buildModelTabs)
    const h = await mountPicker()
    try {
      // order: Nous Research, Anthropic(active), OpenAI, All
      h.probe.keys.pressTab()
      await h.probe.settle()
      let frame = h.probe.frame()
      expect(stripLine(frame)).toContain('[ OpenAI ]')
      expect(frame).toContain('› gpt-5')
      expect(frame).not.toContain('claude-sonnet-4')
      h.probe.keys.pressTab() // → All: the classic full grouped view
      await h.probe.settle()
      frame = h.probe.frame()
      expect(stripLine(frame)).toContain('[ All ]')
      expect(frame).toContain('claude-sonnet-4')
      expect(frame).toContain('gpt-5')
      expect(frame).toContain('hermes-4-405b')
      h.probe.keys.pressTab() // wrap → Nous Research (first chip)
      await h.probe.settle()
      frame = h.probe.frame()
      expect(stripLine(frame)).toContain('[ Nous Research ]')
      expect(frame).toContain('› hermes-4-405b')
      h.probe.keys.pressTab({ shift: true }) // back → All
      await h.probe.settle()
      expect(stripLine(h.probe.frame())).toContain('[ All ]')
      h.probe.keys.pressTab({ shift: true }) // back → OpenAI
      h.probe.keys.pressTab({ shift: true }) // back → Anthropic: ✓ re-selected
      await h.probe.settle()
      frame = h.probe.frame()
      expect(stripLine(frame)).toContain('[ Anthropic ]')
      expect(frame).toContain('› claude-sonnet-4 ✓')
    } finally {
      h.probe.destroy()
    }
  })

  test('←/→ cycle ONLY while the query is empty; the active tab filters BEFORE the fuzzy query', async () => {
    registerPickerTabs(buildModelTabs)
    const h = await mountPicker()
    try {
      h.probe.keys.pressArrow('right') // empty query → Anthropic → OpenAI
      await h.probe.settle()
      expect(stripLine(h.probe.frame())).toContain('[ OpenAI ]')
      // search WITHIN the tab: hermes-4-405b exists under Nous, not here
      await h.probe.keys.typeText('hermes')
      await h.probe.settle()
      let frame = await h.probe.waitForFrame(f => f.includes('(no matches)'))
      expect(frame).not.toContain('hermes-4-405b')
      // with a non-empty query ←/→ stay native cursor moves — no cycling
      h.probe.keys.pressArrow('left')
      await h.probe.settle()
      expect(stripLine(h.probe.frame())).toContain('[ OpenAI ]')
      // Tab still cycles with a query; the query carries over (composes per tab)
      h.probe.keys.pressTab() // → All
      await h.probe.settle()
      frame = await h.probe.waitForFrame(f => f.includes('hermes-4-405b'))
      expect(stripLine(frame)).toContain('[ All ]')
      expect(frame).not.toContain('gpt-5') // fuzzy query still applied under All
    } finally {
      h.probe.destroy()
    }
  })

  test('unconfigured providers get NO chips; Ctrl+U under All reveals them (unchanged); provider tabs drop the hint', async () => {
    registerPickerTabs(buildModelTabs)
    const h = await mountPicker(MIXED) // tabs: Anthropic, OpenAI (Mistral/Copilot unconfigured)
    try {
      let frame = h.probe.frame()
      const strip = stripLine(frame)
      expect(strip).not.toContain('Mistral')
      expect(strip).not.toContain('GitHub Copilot')
      // active provider tab: Ctrl+U does not apply (no unconfigured rows here)
      expect(frame).not.toContain('Ctrl+U show unconfigured')
      h.probe.keys.pressTab()
      h.probe.keys.pressTab() // Anthropic → OpenAI → All
      await h.probe.settle()
      frame = h.probe.frame()
      expect(stripLine(frame)).toContain('[ All ]')
      expect(frame).toContain('Ctrl+U show unconfigured')
      h.probe.keys.pressKey('u', { ctrl: true })
      await h.probe.settle()
      frame = await h.probe.waitForFrame(f => f.includes('Mistral'))
      expect(frame).toContain('no API key — set MISTRAL_API_KEY')
      expect(frame).toContain('no API key — set GITHUB_TOKEN')
    } finally {
      h.probe.destroy()
    }
  })

  test('without a registered tab derivation the picker stays stripless (skills view)', async () => {
    const h = await mountPicker()
    try {
      const frame = h.probe.frame()
      expect(frame).not.toContain('All')
      expect(frame).not.toContain('Tab provider')
    } finally {
      h.probe.destroy()
    }
  })
})
