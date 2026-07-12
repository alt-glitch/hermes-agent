/**
 * Regression: tall <diff showLineNumbers> scrolled partially above the
 * transcript viewport crashed the render loop under node:ffi.
 *
 * @opentui/core 0.4.0 marshals OptimizedBuffer.fillRect/drawText coordinates
 * as u32 (zig.ts FFI table) while LineNumberRenderable passes raw screen
 * coordinates — NEGATIVE when the diff is partially scrolled out of a
 * <scrollbox>. Bun's FFI silently wraps negatives (native bounds-check →
 * no-op); Node's experimental FFI throws ERR_INVALID_ARG_VALUE out of
 * CliRenderer.loop on EVERY frame (frozen UI + console error spam). Fixed by
 * boundary/ffiSafe.ts clamping/skipping before the FFI call.
 */
import { OptimizedBuffer, RGBA } from '@opentui/core'
import { describe, expect, test } from 'vitest'

import { installFfiCoordSafety } from '../boundary/ffiSafe.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

type Store = ReturnType<typeof createSessionStore>

// TALL diff: when expanded inside the sticky-bottom scrollbox the diff's TOP
// rows render above the viewport (negative screen y) — the live-crash trigger.
const ADDED = Array.from({ length: 40 }, (_, i) => `+def fn_${i}(): pass`)
const DIFF = [
  '--- a//tmp/v6smoke/greet.py',
  '+++ b//tmp/v6smoke/greet.py',
  '@@ -1,5 +1,45 @@',
  ' def greet(name):',
  '-    print("hello " + name)',
  '+    print(f"hello {name}")',
  ...ADDED,
  ' ',
  ' if __name__ == "__main__":',
  '     greet("world")',
  ''
].join('\n')

function seed(store: Store) {
  store.apply({ type: 'gateway.ready' })
  store.apply({ type: 'message.start' })
  store.apply({ type: 'tool.start', payload: { tool_id: 'p1', name: 'patch', context: '/tmp/v6smoke/greet.py' } })
  store.apply({
    type: 'tool.complete',
    payload: {
      tool_id: 'p1',
      name: 'patch',
      args: { path: '/tmp/v6smoke/greet.py', mode: 'replace' },
      diff_unified: DIFF,
      duration_s: 0.2,
      result: JSON.stringify({ success: true, diff: DIFF })
    }
  })
  store.apply({ type: 'message.complete' })
}

async function clickHeader(probe: RenderProbe, name: string): Promise<void> {
  const frame = await probe.waitForFrame(f => f.includes(name))
  const rows = frame.split('\n')
  const y = rows.findIndex(line => line.includes(name))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = (rows[y] ?? '').indexOf(name)
  await probe.click(x, y)
}

describe('node-ffi coordinate safety (boundary/ffiSafe.ts)', () => {
  test('negative coordinates no longer throw ERR_INVALID_ARG_VALUE', () => {
    installFfiCoordSafety() // idempotent (test/lib/render.ts installs it too)
    const buf = OptimizedBuffer.create(20, 10, 'unicode', { id: 'ffi-safety-probe' })
    const red = RGBA.fromInts(255, 0, 0, 255)
    try {
      // each of these threw TypeError ERR_INVALID_ARG_VALUE ("must be a uint32")
      expect(() => buf.fillRect(2, -3, 5, 2, red)).not.toThrow()
      expect(() => buf.fillRect(-1, 2, 5, 2, red)).not.toThrow()
      expect(() => buf.fillRect(2, 2, -5, 2, red)).not.toThrow()
      expect(() => buf.drawText('hi', -1, 2, red)).not.toThrow()
      expect(() => buf.drawText('hi', 2, -1, red)).not.toThrow()
      expect(() => buf.setCell(-1, 0, 'x', red, red)).not.toThrow()
      expect(() => buf.setCellWithAlphaBlending(0, -1, 'x', red, red)).not.toThrow()
      // a clipped fillRect still draws its visible part
      buf.fillRect(-2, -2, 6, 6, red)
      expect(() => buf.fillRect(0, 0, 4, 4, red)).not.toThrow()
    } finally {
      buf.destroy()
    }
  })

  test('tall diff expand/collapse + resize churn survives without render-loop errors', async () => {
    const store = createSessionStore()
    store.setDetails('collapsed', true)
    seed(store)
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { width: 120, height: 35 }
    )
    const errors: unknown[] = []
    const onErr = (e: unknown) => errors.push(e)
    process.on('uncaughtException', onErr)
    try {
      await clickHeader(probe, 'patch')
      // let tree-sitter + the scrollAnchor's sticky-suspension window land
      await new Promise(r => setTimeout(r, 200))
      // added rows only paint when the diff body is actually expanded (the
      // scrollAnchor holds the viewport at the diff TOP, so assert early rows)
      const expanded = await probe.waitForFrame(f => f.includes('fn_0'))
      expect(expanded).toContain('+ def fn_0(): pass')
      // Scroll INTO the tall diff so its top rows sit ABOVE the viewport
      // (negative screen y) — the exact live-crash condition. (The old anchor
      // produced this via transient sticky-bottom frames; the sticky
      // suspension removed those, so drive the scroll-cut explicitly.)
      let downTicks = 0
      while (probe.frame().includes('fn_0(') && downTicks < 30) {
        await probe.scroll(40, 15, 'down')
        downTicks++
      }
      const cut = probe.frame()
      expect(cut).not.toContain('fn_0(') // the diff top is cut above the viewport…
      expect(cut).toContain('fn_') // …while mid-diff rows still paint (negative-y path)
      // bring the header back on screen for the toggle churn
      for (let i = 0; i < downTicks + 5; i++) await probe.scroll(40, 15, 'up')
      // toggle a few times + resize churn
      await clickHeader(probe, 'patch')
      await new Promise(r => setTimeout(r, 100))
      await clickHeader(probe, 'patch')
      await new Promise(r => setTimeout(r, 200))
      probe.resize(100, 30)
      await new Promise(r => setTimeout(r, 100))
      probe.resize(120, 35)
      await new Promise(r => setTimeout(r, 200))
      expect(errors).toEqual([])
    } finally {
      process.off('uncaughtException', onErr)
      probe.destroy()
    }
  }, 30000)
})
