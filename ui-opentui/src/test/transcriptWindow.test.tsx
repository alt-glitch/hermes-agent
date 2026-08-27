/**
 * Transcript windowing S1+S2 — headless integration (view/transcript.tsx +
 * logic/window.ts behind HERMES_TUI_WINDOWING). Proves, against the REAL
 * renderer tree:
 *   - out-of-window rows are actually UNMOUNTED (far fewer live renderables
 *     than the unwindowed tree — the spacer is 1 box, the row was ~3+ texts),
 *   - spacers are EXACT-height (total scrollHeight identical ON vs OFF — the
 *     zero-jank invariant),
 *   - scrolling far away REMOUNTS spaced-out rows (content paints again),
 *   - the flag OFF renders the legacy tree (no wrappers, everything mounted),
 * and the S2 slices:
 *   - append-time adjudication: bursting 1500 appends keeps the PEAK
 *     simultaneously-mounted row count bounded (< 120) — rows scrolled past
 *     the margin become spacers without a manual scroll,
 *   - resume (commitSnapshot): a bulk snapshot mounts only the bottom window;
 *     everything above starts as estimate spacers and remounts on scroll-back,
 *   - the idle exact-measure march + spacer corrections are ZERO-JANK: with
 *     wrong estimates (soft-wrapped rows), idle pulses fix spacer heights
 *     while the visible frame stays byte-identical — sticky-bottom pinning
 *     compensates when pinned, explicit scrollTop compensation when reading
 *     mid-history.
 */
import { ScrollBoxRenderable, type Renderable } from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { createSignal, Show } from 'solid-js'
import { afterEach, describe, expect, test } from 'vitest'

import { createSessionStore, type Message } from '../logic/store.ts'
import { resetWindowRowStats, windowRowStats } from '../logic/window.ts'
import { ThemeProvider } from '../view/theme.tsx'
import { Transcript } from '../view/transcript.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

type Store = ReturnType<typeof createSessionStore>

const ENV_KEYS = ['HERMES_TUI_WINDOWING', 'HERMES_TUI_WINDOW_IDLE_MS'] as const
const envBefore = ENV_KEYS.map(k => process.env[k])
afterEach(() => {
  ENV_KEYS.forEach((k, i) => {
    const v = envBefore[i]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  })
})

/** Seed `n` settled one-line system rows (flat text — no async markdown). */
function seedRows(n: number): Store {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  for (let i = 0; i < n; i++) store.pushSystem(`row-${i} marker`)
  return store
}

function walk(node: Renderable, visit: (n: Renderable) => void): void {
  visit(node)
  for (const child of node.getChildren()) walk(child, visit)
}

interface Mounted {
  probe: RenderProbe
  count: () => number
  scrollbox: () => ScrollBoxRenderable
}

async function mountTranscript(store: Store, windowing: '1' | '0'): Promise<Mounted> {
  process.env.HERMES_TUI_WINDOWING = windowing
  let root: Renderable | undefined
  function Grab() {
    root = useRenderer().root
    return null
  }
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <Grab />
        <Transcript store={store} />
      </ThemeProvider>
    ),
    { width: 50, height: 12 }
  )
  // several passes: layout (heights recorded) → frame tick (window computed)
  // → swap render — the driver is the renderer frame callback.
  for (let i = 0; i < 6; i++) await probe.settle()
  const count = () => {
    let n = 0
    if (root) walk(root, () => n++)
    return n
  }
  const scrollbox = () => {
    let sb: ScrollBoxRenderable | undefined
    if (root) {
      walk(root, node => {
        if (node instanceof ScrollBoxRenderable) sb ??= node
      })
    }
    if (!sb) throw new Error('no scrollbox in the mounted tree')
    return sb
  }
  return { probe, count, scrollbox }
}

const ROWS = 120

describe('transcript windowing (HERMES_TUI_WINDOWING) — S1 machinery', () => {
  test('out-of-window rows unmount into exact-height spacers; OFF keeps the full tree', async () => {
    const on = await mountTranscript(seedRows(ROWS), '1')
    const off = await mountTranscript(seedRows(ROWS), '0')
    try {
      // sticky-bottom: both variants sit pinned at the bottom showing the tail.
      expect(on.probe.frame()).toContain(`row-${ROWS - 1} marker`)
      expect(off.probe.frame()).toContain(`row-${ROWS - 1} marker`)

      // ZERO-JANK INVARIANT: spacers are exact-height — the windowed content
      // is precisely as tall as the fully-mounted content.
      expect(on.scrollbox().scrollHeight).toBe(off.scrollbox().scrollHeight)
      expect(on.scrollbox().scrollHeight).toBeGreaterThan(100) // sanity: way past the viewport

      // The window actually sheds renderables: ~viewport±margin + bottom-30
      // stay mounted out of 120 rows; the rest are 1-box spacers. The legacy
      // tree keeps every row's text renderables alive.
      expect(on.count()).toBeLessThan(off.count() * 0.6)
    } finally {
      on.probe.destroy()
      off.probe.destroy()
    }
  })

  test('scrolling far from the bottom remounts spaced-out rows (and the frame paints them)', async () => {
    const on = await mountTranscript(seedRows(ROWS), '1')
    try {
      const sb = on.scrollbox()
      // row-0 is far outside the bottom window: not painted while pinned.
      expect(on.probe.frame()).not.toContain('row-0 marker')
      sb.scrollTo(0)
      for (let i = 0; i < 6; i++) await on.probe.settle()
      expect(sb.scrollTop).toBe(0)
      expect(on.probe.frame()).toContain('row-0 marker')
    } finally {
      on.probe.destroy()
    }
  })
})

// ── S2 — append-time adjudication + windowed resume + idle exact-measure ──

/** Drop the right-most columns (scrollbar territory): corrections legitimately
 *  resize the thumb as estimates become exact — that is NOT content movement. */
function clipScrollbar(frame: string): string {
  return frame
    .split('\n')
    .map(line => line.slice(0, -2).replace(/\s+$/, ''))
    .join('\n')
}

describe('transcript windowing — S2 append-time adjudication', () => {
  test.each(['1', '0'] as const)(
    'a promoted queued turn stays bottom-followed when fixed composer chrome disappears (windowing=%s)',
    async windowing => {
      process.env.HERMES_TUI_WINDOWING = windowing
      const store = seedRows(120)
      const [queued, setQueued] = createSignal(true)
      let root: Renderable | undefined
      function Grab() {
        root = useRenderer().root
        return null
      }
      const probe = await renderProbe(
        () => (
          <ThemeProvider theme={() => store.state.theme}>
            <Grab />
            <box style={{ flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
              <Transcript store={store} />
              <Show when={queued()}>
                <box style={{ flexShrink: 0, height: 4 }}>
                  <text>queued (1)\n1. review this change\nEnter send now</text>
                </box>
              </Show>
            </box>
          </ThemeProvider>
        ),
        { width: 60, height: 18 }
      )
      try {
        for (let i = 0; i < 6; i++) await probe.settle()
        let sb: ScrollBoxRenderable | undefined
        if (root) {
          walk(root, node => {
            if (node instanceof ScrollBoxRenderable) sb ??= node
          })
        }
        if (!sb) throw new Error('no transcript scrollbox')
        expect(probe.frame()).toContain('queued (1)')

        // A title/status/chrome update can leave OpenTUI's scrollbox off
        // its sticky re-engage point. A user submission is an explicit intent to
        // return to the live edge, even from that transient/manual state.
        sb.scrollTo(Math.max(0, sb.scrollTop - 10))
        expect(sb.scrollTop).toBeLessThan(sb.scrollHeight - sb.viewport.height)

        // Queue promotion removes fixed-height composer chrome and appends the
        // optimistic user row. The assistant then streams into the SAME row, so
        // subsequent deltas do not change messages.length.
        setQueued(false)
        store.pushUser('review this change')
        store.apply({ type: 'message.start' })
        await probe.settle()
        for (let i = 0; i < 24; i++) {
          store.apply({
            payload: { text: `${i === 0 ? '' : '\n'}streamed answer after promotion line ${i}` },
            type: 'message.delta'
          })
          await probe.settle()
        }
        for (let i = 0; i < 3; i++) await probe.settle()

        expect(probe.frame()).toContain('streamed answer after promotion line 23')
        expect(sb.scrollTop).toBe(sb.scrollHeight - sb.viewport.height)
      } finally {
        probe.destroy()
      }
    }
  )

  test('bursting 1500 appends keeps the peak mounted-row count bounded (< 120)', async () => {
    // Pin the cap below the burst size: this test ALSO exercises the
    // cap-trim × windowing interplay (trimmed rows' spacers must be pruned,
    // scroll-to-top must land on the oldest SURVIVOR, row-500). The default
    // ceiling is 3000 under windowing (#27) — a 1500-row burst never trims it.
    process.env.HERMES_TUI_MAX_MESSAGES = '1000'
    const onStore = (() => {
      try {
        return createSessionStore()
      } finally {
        delete process.env.HERMES_TUI_MAX_MESSAGES
      }
    })()
    onStore.apply({ type: 'gateway.ready' })
    const on = await mountTranscript(onStore, '1')
    try {
      resetWindowRowStats()
      // Burst: 100 appends per frame — the per-append adjudication must window
      // rows out as they pass the margin, NOT wait for the next frame tick.
      for (let i = 0; i < 1500; i++) {
        onStore.pushSystem(i % 5 === 4 ? `row-${i} marker\nsecond line\nthird line` : `row-${i} marker`)
        if (i % 100 === 99) await on.probe.settle()
      }
      for (let i = 0; i < 6; i++) await on.probe.settle()
      expect(windowRowStats().peakMounted).toBeLessThan(120)
      // pinned at the bottom: the tail painted (live rows mount instantly)
      expect(on.probe.frame()).toContain('row-1499 marker')

      // ZERO-JANK INVARIANT survives the burst: spacers (measured or
      // estimated — these rows never soft-wrap) occupy EXACTLY the height the
      // full tree would. (The store cap trims both to the same 1000 rows.)
      process.env.HERMES_TUI_MAX_MESSAGES = '1000'
      const offStore = (() => {
        try {
          return createSessionStore()
        } finally {
          delete process.env.HERMES_TUI_MAX_MESSAGES
        }
      })()
      offStore.apply({ type: 'gateway.ready' })
      for (let i = 0; i < 1500; i++) {
        offStore.pushSystem(i % 5 === 4 ? `row-${i} marker\nsecond line\nthird line` : `row-${i} marker`)
      }
      const off = await mountTranscript(offStore, '0')
      try {
        expect(on.scrollbox().scrollHeight).toBe(off.scrollbox().scrollHeight)
      } finally {
        off.probe.destroy()
      }

      // scroll-to-top remounts burst rows that were never painted
      const sb = on.scrollbox()
      sb.scrollTo(0)
      for (let i = 0; i < 6; i++) await on.probe.settle()
      // the cap kept the newest 1000 rows → the oldest surviving row is 500
      expect(on.probe.frame()).toContain('row-500 marker')
    } finally {
      on.probe.destroy()
    }
  }, 120_000)
})

describe('transcript windowing — S2 selection: drag freezes, a finished highlight only pins its rows', () => {
  test('a persisting (finished) selection does not freeze windowing; its rows stay mounted for copy', async () => {
    const store = seedRows(60)
    const on = await mountTranscript(store, '1')
    try {
      // drag-select across a visible row's TEXT line (rows interleave with
      // margin lines — find one from the frame), then release — the highlight
      // PERSISTS by design (boundary/renderer.ts keeps it so Ctrl+C re-copies).
      const textY = on.probe
        .frame()
        .split('\n')
        .findIndex(line => line.includes('marker'))
      expect(textY).toBeGreaterThanOrEqual(0)
      await on.probe.mouse.drag(3, textY, 30, textY + 2)
      await on.probe.settle()
      const selection = on.probe.renderer.getSelection()
      expect(selection?.isActive).toBe(true)
      expect(selection?.isDragging).toBe(false)
      const copied = selection?.getSelectedText() ?? ''
      expect(copied).toContain('marker')

      // burst 300 appends while the highlight lingers: windowing must keep
      // adjudicating (the S1 full freeze would balloon the mounted set)…
      resetWindowRowStats()
      for (let i = 0; i < 300; i++) {
        store.pushSystem(`late-${i} marker`)
        if (i % 50 === 49) await on.probe.settle()
      }
      for (let i = 0; i < 6; i++) await on.probe.settle()
      expect(windowRowStats().peakMounted).toBeLessThan(120)

      // …while the selected row — long scrolled out past the margin — stays
      // PINNED: the highlight's renderables are alive and Ctrl+C still copies
      // the exact same text.
      expect(on.probe.renderer.getSelection()?.getSelectedText()).toBe(copied)
    } finally {
      on.probe.destroy()
    }
  }, 60_000)
})

describe('transcript windowing — S2 windowed resume (commitSnapshot)', () => {
  function snapshot(n: number): Message[] {
    const out: Message[] = []
    for (let i = 0; i < n; i++) {
      if (i % 3 === 0) out.push({ role: 'user', text: `question-${i} marker` })
      else if (i % 3 === 1) out.push({ role: 'assistant', text: `answer-${i} marker\nwith a second line` })
      else out.push({ role: 'system', text: `note-${i} marker` })
    }
    return out
  }

  test('a bulk snapshot mounts only the bottom window; history starts as estimate spacers', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const on = await mountTranscript(store, '1')
    try {
      resetWindowRowStats()
      store.hydrate(() => snapshot(600))
      for (let i = 0; i < 6; i++) await on.probe.settle()
      // Only the bottom window (+ bottom-30 sticky region) ever mounted — the
      // 600-row snapshot must NOT transiently mount everything.
      expect(windowRowStats().peakMounted).toBeLessThan(120)
      expect(on.probe.frame()).toContain('answer-598 marker')

      // estimate spacers above are exact for these unwrapped rows (incl. the
      // ⧉ copy chip line on settled user/assistant rows) — scrollHeight
      // matches the fully-mounted legacy tree.
      const offStore = createSessionStore()
      offStore.apply({ type: 'gateway.ready' })
      const off = await mountTranscript(offStore, '0')
      try {
        offStore.hydrate(() => snapshot(600))
        for (let i = 0; i < 6; i++) await off.probe.settle()
        expect(on.scrollbox().scrollHeight).toBe(off.scrollbox().scrollHeight)
      } finally {
        off.probe.destroy()
      }

      // scroll-back into never-mounted history remounts it
      on.scrollbox().scrollTo(0)
      for (let i = 0; i < 6; i++) await on.probe.settle()
      expect(on.probe.frame()).toContain('question-0 marker')
    } finally {
      on.probe.destroy()
    }
  }, 60_000)
})

describe('transcript windowing — S2 idle exact-measure + zero-jank corrections', () => {
  // Every 4th row soft-wraps (~120 chars at width 50): the line-count estimate
  // is WRONG (1 line vs 3), so the idle march must correct spacer heights —
  // without ever moving visible content.
  function wrappySeed(n: number): Store {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const long = 'wrap '.repeat(24).trim() // ~119 chars → 3 wrapped lines
    for (let i = 0; i < n; i++) store.pushSystem(i % 4 === 0 ? `row-${i} ${long}` : `row-${i} marker`)
    return store
  }

  // 400 rows: the mount itself runs ~10 frames (≈100 rows measured by the
  // march before the baseline is captured) — enough unmeasured, wrongly-
  // estimated history must REMAIN above for the assertions to bite.
  const WRAPPY_ROWS = 400

  test('pinned at the bottom: sticky pinning absorbs above-viewport corrections (frame is byte-stable)', async () => {
    process.env.HERMES_TUI_WINDOW_IDLE_MS = '0' // pulse every idle frame
    const on = await mountTranscript(wrappySeed(WRAPPY_ROWS), '1')
    try {
      const sb = on.scrollbox()
      const before = clipScrollbar(on.probe.frame())
      const shBefore = sb.scrollHeight
      // idle pulses march up the history, mounting+measuring 10 rows at a time
      for (let i = 0; i < 50; i++) {
        await on.probe.settle()
        expect(clipScrollbar(on.probe.frame())).toBe(before) // ZERO jank, every pulse
      }
      // corrections actually happened: the wrapped rows were under-estimated
      expect(sb.scrollHeight).toBeGreaterThan(shBefore)
      // ...and converged to the legacy tree's exact total
      const off = await mountTranscript(wrappySeed(WRAPPY_ROWS), '0')
      try {
        expect(sb.scrollHeight).toBe(off.scrollbox().scrollHeight)
      } finally {
        off.probe.destroy()
      }
    } finally {
      on.probe.destroy()
    }
  }, 120_000)

  test('compact mode invalidates off-window heights and preserves the settled visible frame', async () => {
    process.env.HERMES_TUI_WINDOW_IDLE_MS = '0'
    const store = wrappySeed(WRAPPY_ROWS)
    const on = await mountTranscript(store, '1')
    try {
      store.setCompact(true)
      for (let i = 0; i < 4; i++) await on.probe.settle()
      const stable = clipScrollbar(on.probe.frame())
      for (let i = 0; i < 50; i++) {
        await on.probe.settle()
        expect(clipScrollbar(on.probe.frame())).toBe(stable)
      }

      const offStore = wrappySeed(WRAPPY_ROWS)
      offStore.setCompact(true)
      const off = await mountTranscript(offStore, '0')
      try {
        expect(on.scrollbox().scrollHeight).toBe(off.scrollbox().scrollHeight)
      } finally {
        off.probe.destroy()
      }
    } finally {
      on.probe.destroy()
    }
  }, 120_000)

  test('terminal width changes invalidate off-window heights and reconverge through zero-jank idle corrections', async () => {
    process.env.HERMES_TUI_WINDOW_IDLE_MS = '0'
    const on = await mountTranscript(wrappySeed(WRAPPY_ROWS), '1')
    try {
      on.probe.resize(32, 12)
      for (let i = 0; i < 60; i++) await on.probe.settle()

      const off = await mountTranscript(wrappySeed(WRAPPY_ROWS), '0')
      try {
        off.probe.resize(32, 12)
        for (let i = 0; i < 8; i++) await off.probe.settle()
        expect(on.scrollbox().scrollHeight).toBe(off.scrollbox().scrollHeight)
        expect(on.probe.frame()).toContain('row-399')
      } finally {
        off.probe.destroy()
      }
    } finally {
      on.probe.destroy()
    }
  }, 120_000)

  test('reading mid-history: above-viewport corrections compensate scrollTop in the same frame', async () => {
    process.env.HERMES_TUI_WINDOW_IDLE_MS = '0'
    const on = await mountTranscript(wrappySeed(WRAPPY_ROWS), '1')
    try {
      const sb = on.scrollbox()
      // leave the sticky pin and park mid-history (estimates above AND below)
      sb.scrollTo(Math.floor(sb.scrollHeight / 2))
      for (let i = 0; i < 6; i++) await on.probe.settle() // window remount settles
      const baseline = clipScrollbar(on.probe.frame())
      const scrollTopBefore = sb.scrollTop
      for (let i = 0; i < 50; i++) {
        await on.probe.settle()
        expect(clipScrollbar(on.probe.frame())).toBe(baseline) // ZERO jank
      }
      // the under-estimated rows ABOVE the viewport grew; scrollTop was
      // compensated by exactly that growth — that's WHY the frame held still.
      expect(sb.scrollTop).toBeGreaterThan(scrollTopBefore)
    } finally {
      on.probe.destroy()
    }
  }, 120_000)
})
