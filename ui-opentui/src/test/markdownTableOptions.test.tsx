/**
 * Streaming Markdown must not re-apply `tableOptions` on every text delta.
 *
 * The `<markdown>` host merges all dynamic props into one Solid render effect,
 * so any prop whose value is a fresh object per run is re-assigned each time
 * `content` changes. The native `tableOptions` setter has no equality guard and
 * re-rasters every settled table block, defeating `internalBlockMode="top-level"`.
 * Contract: one assignment at mount, zero per delta, one more per theme change.
 */
import { MarkdownRenderable } from '@opentui/core'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { Markdown } from '../view/markdown.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

const TABLE = [
  '| a | b | c |',
  '|---|---|---|',
  ...Array.from({ length: 20 }, (_, i) => `| ${i} | ${i * 2} | ${i * 3} |`)
].join('\n')

const found = Object.getOwnPropertyDescriptor(MarkdownRenderable.prototype, 'tableOptions')
if (!found?.set) throw new Error('MarkdownRenderable.tableOptions setter not found — installed @opentui/core changed')
const descriptor: PropertyDescriptor = found

function countTableOptionsWrites(): { count: () => number; restore: () => void } {
  let n = 0
  Object.defineProperty(MarkdownRenderable.prototype, 'tableOptions', {
    ...descriptor,
    set(this: MarkdownRenderable, value: unknown) {
      n += 1
      // Explicit bind: the native setter must run with the spied instance as `this`.
      descriptor.set?.bind(this)(value)
    }
  })
  return {
    count: () => n,
    restore: () => Object.defineProperty(MarkdownRenderable.prototype, 'tableOptions', descriptor)
  }
}

describe('Markdown streaming — tableOptions identity', () => {
  let restore: (() => void) | undefined
  afterEach(() => restore?.())

  it('assigns tableOptions once at mount, not once per delta, and again on a theme change', async () => {
    const spy = countTableOptionsWrites()
    restore = spy.restore
    const [text, setText] = createSignal(TABLE + '\n\n')
    // The real theme source: the store's reactive theme, swapped by skin.changed.
    const store = createSessionStore()
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <Markdown text={text()} streaming />
        </ThemeProvider>
      ),
      { height: 30, width: 60 }
    )
    try {
      await probe.settle()
      const atMount = spy.count()
      expect(atMount).toBeGreaterThanOrEqual(1)

      const deltas = 200
      const t0 = performance.now()
      for (let i = 0; i < deltas; i++) {
        setText(prev => prev + `word${i} `)
        if (i % 20 === 19) await probe.settle()
      }
      await probe.settle()
      const elapsedMs = performance.now() - t0
      const perDelta = spy.count() - atMount
      // Recorded for the run receipt; the assertion is the contract below.
      console.info(
        `[tableOptions] writes at mount=${atMount} per ${deltas} deltas=${perDelta} elapsed=${elapsedMs.toFixed(1)}ms`
      )
      expect(perDelta).toBe(0)

      store.apply({ type: 'skin.changed', payload: { colors: { border: '#ff00ff' } } })
      await probe.settle()
      expect(spy.count()).toBe(atMount + 1)
      // The table still renders as a grid after the theme swap.
      expect(probe.frame()).toContain('│5')
      expect(probe.frame()).toContain('┼')
    } finally {
      probe.destroy()
    }
  })
})
