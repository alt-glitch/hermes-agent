/**
 * Inline `/skill` references in SENT user messages (Ink messageLine parity —
 * the transcript half of the inline completion trigger). Frame tests through
 * the real App tree (store → Transcript → MessageLine): a non-leading,
 * whitespace-preceded `/skill` token renders as an ACCENT span while the
 * surrounding prose keeps the user body color — flat sibling spans in one
 * native <text>, so the message source (and CopyChip's source) is untouched
 * and the frame still shows the text byte-for-byte.
 */
import { RGBA } from '@opentui/core'
import { describe, expect, test } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

type Store = ReturnType<typeof createSessionStore>

async function mountApp(store: Store): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} />
      </ThemeProvider>
    ),
    { height: 24, width: 80 }
  )
}

/** First styled span whose text contains `needle`, across the whole frame. */
function findSpan(probe: RenderProbe, needle: string) {
  for (const line of probe.spans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span
    }
  }
  return undefined
}

const rgb = (hex: string): number[] => RGBA.fromHex(hex).toInts().slice(0, 3)

describe('user-message inline skill references (frame spans)', () => {
  test('a mid-prose /skill accents; the prose around it keeps the user body color', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushUser('clean this up with /tidy then ship')
    const probe = await mountApp(store)
    try {
      await probe.waitForFrame(f => f.includes('/tidy'))
      // the message paints byte-for-byte — styling never rewrites the text
      expect(probe.frame()).toContain('clean this up with /tidy then ship')
      const refSpan = findSpan(probe, '/tidy')
      expect(refSpan).toBeDefined()
      expect(refSpan?.text).toBe('/tidy') // its own span: exactly the token
      expect(refSpan?.fg.toInts().slice(0, 3)).toEqual(rgb(store.state.theme.color.accent))
      // the prose on both sides stays the muted user body color
      for (const needle of ['clean this up with ', ' then ship']) {
        const span = findSpan(probe, needle)
        expect(span).toBeDefined()
        expect(span?.fg.toInts().slice(0, 3)).toEqual(rgb(store.state.theme.color.muted))
      }
    } finally {
      probe.destroy()
    }
  })

  test('a LEADING slash token is an invocation, not a reference — no accent', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushUser('/notaskill run something')
    const probe = await mountApp(store)
    try {
      await probe.waitForFrame(f => f.includes('/notaskill'))
      const span = findSpan(probe, '/notaskill')
      expect(span).toBeDefined()
      expect(span?.fg.toInts().slice(0, 3)).toEqual(rgb(store.state.theme.color.muted))
    } finally {
      probe.destroy()
    }
  })

  test('paths are never accented', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushUser('look at /usr/local/bin')
    const probe = await mountApp(store)
    try {
      await probe.waitForFrame(f => f.includes('/usr/local/bin'))
      expect(probe.frame()).toContain('look at /usr/local/bin')
      const span = findSpan(probe, '/usr/local/bin')
      expect(span).toBeDefined()
      expect(span?.fg.toInts().slice(0, 3)).toEqual(rgb(store.state.theme.color.muted))
    } finally {
      probe.destroy()
    }
  })
})
