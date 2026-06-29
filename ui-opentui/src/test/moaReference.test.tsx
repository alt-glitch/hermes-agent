/**
 * MoA reference-block port (upstream 163cb24d4). Layers:
 *   1. schema  — moa.reference / moa.aggregating decode (optional index/count)
 *   2. reducer — one moaReference part per event (push, not merge); aggregating
 *      adds no part; a reference with no live streaming assistant is dropped
 *   3. details — moaReference survives /details hidden (primary content, not folded)
 *   4. render  — the ◇ Reference i/n — label HEADER paints (it's <text>, not
 *      <markdown>); the body is asserted via the STORE because native <markdown>
 *      never paints in the headless renderer (see render.test.tsx:38-42).
 */
import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import { collapseHiddenParts } from '../logic/details.ts'
import { createSessionStore, type Part } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { moaReferenceHeader } from '../view/moaReferencePart.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame } from './lib/render.ts'

const decode = Schema.decodeUnknownOption(GatewayEventSchema)

// ── 1. schema ──────────────────────────────────────────────────────────
describe('MoA event schema decode', () => {
  test('moa.reference decodes with index/count present', () => {
    const ev = decode({ type: 'moa.reference', payload: { label: 'm', text: 'out', index: 1, count: 3 } })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'moa.reference') {
      expect(ev.value.payload?.label).toBe('m')
      expect(ev.value.payload?.text).toBe('out')
      expect(ev.value.payload?.index).toBe(1)
      expect(ev.value.payload?.count).toBe(3)
    }
  })

  test('moa.reference decodes with index/count ABSENT (they are omitted on the wire)', () => {
    const ev = decode({ type: 'moa.reference', payload: { label: 'm', text: 'out' } })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'moa.reference') {
      expect(ev.value.payload?.index).toBeUndefined()
      expect(ev.value.payload?.count).toBeUndefined()
    }
  })

  test('moa.aggregating decodes', () => {
    const ev = decode({ type: 'moa.aggregating', payload: { aggregator: 'opus' } })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'moa.aggregating') {
      expect(ev.value.payload?.aggregator).toBe('opus')
    }
  })
})

// ── 2. reducer ─────────────────────────────────────────────────────────
type MoaRefPart = Extract<Part, { type: 'moaReference' }>
function moaParts(store: ReturnType<typeof createSessionStore>): MoaRefPart[] {
  const last = store.state.messages[store.state.messages.length - 1]
  return (last?.parts ?? []).filter((p): p is MoaRefPart => p.type === 'moaReference')
}

describe('MoA reducer', () => {
  test('each moa.reference pushes its OWN part — two events make TWO blocks (not merged)', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ type: 'moa.reference', payload: { label: 'a', text: 'out-a', index: 1, count: 2 } })
    store.apply({ type: 'moa.reference', payload: { label: 'b', text: 'out-b', index: 2, count: 2 } })
    const parts = moaParts(store)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({ label: 'a', text: 'out-a', index: 1, count: 2 })
    expect(parts[1]).toMatchObject({ label: 'b', text: 'out-b', index: 2, count: 2 })
  })

  test('moa.aggregating adds NO transcript part (status-only)', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ type: 'moa.aggregating', payload: { aggregator: 'opus' } })
    // aggregating is status-only: it adds NO moaReference part to the turn.
    expect(moaParts(store)).toHaveLength(0)
  })

  test('a moa.reference with NO live streaming assistant is DROPPED (no stray bubble)', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    // no message.start → no live streaming assistant
    store.apply({ type: 'moa.reference', payload: { label: 'late', text: 'x' } })
    expect(moaParts(store)).toHaveLength(0)
    // and it did not create an assistant message
    expect(store.state.messages.some(m => m.role === 'assistant')).toBe(false)
  })

  test('a moa.reference after the turn SETTLED is dropped (mirrors Ink interrupted-guard)', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'done' } })
    store.apply({ type: 'message.complete' }) // settled → not streaming
    store.apply({ type: 'moa.reference', payload: { label: 'late', text: 'x' } })
    expect(moaParts(store)).toHaveLength(0)
  })
})

// ── 3. details fold ────────────────────────────────────────────────────
describe('collapseHiddenParts (/details hidden) treats moaReference as primary', () => {
  test('moaReference is NOT folded into the hidden run (reasoning IS)', () => {
    const parts: Part[] = [
      { type: 'reasoning', id: 'r1', text: 'thinking' },
      { type: 'moaReference', id: 'm1', label: 'a', text: 'out-a', index: 1, count: 2 },
      { type: 'text', id: 't1', text: 'answer' }
    ]
    const display = collapseHiddenParts(parts)
    // reasoning folds to a hiddenRun; moaReference + text survive as themselves
    expect(display.some(p => p.type === 'hiddenRun')).toBe(true)
    expect(display.some(p => p.type === 'moaReference')).toBe(true)
    expect(display.some(p => p.type === 'text')).toBe(true)
    // the moaReference must NOT have been counted into a hidden run
    const hidden = display.find(p => p.type === 'hiddenRun')
    if (hidden) expect(hidden.thoughts).toBe(1) // only the reasoning
  })
})

// ── 4. header formatting (pure) ────────────────────────────────────────
describe('moaReferenceHeader', () => {
  test('index/count present → numbered form', () => {
    expect(moaReferenceHeader('gpt', 2, 3)).toBe('Reference 2/3 — gpt')
  })
  test('index/count absent → no-number form', () => {
    expect(moaReferenceHeader('gpt')).toBe('Reference — gpt')
  })
  test('index 0 falls to no-number form (truthy check, matches Ink index && count)', () => {
    expect(moaReferenceHeader('gpt', 0, 3)).toBe('Reference — gpt')
  })
})

// ── 5. render ──────────────────────────────────────────────────────────
describe('MoA reference render', () => {
  test('the ◇ Reference header + label + index/count PAINT (header is <text>, not markdown)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ type: 'moa.reference', payload: { label: 'claude-opus', text: 'ref body text', index: 1, count: 3 } })
    store.apply({ type: 'message.delta', payload: { text: 'Aggregated answer.' } })
    store.apply({ type: 'message.complete' })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'Reference', width: 80, height: 18 }
    )
    expect(frame).toContain('◇') // the reference glyph
    expect(frame).toContain('Reference 1/3') // header + position
    expect(frame).toContain('claude-opus') // the source-model label
    // body text is rendered via native <markdown>, which does NOT paint headlessly
    // (render.test.tsx:38-42) — assert it via the STORE instead:
    const parts = moaParts(store)
    expect(parts[0]?.text).toBe('ref body text')
  })

  test('reference block survives /details hidden (it is primary content, never folded)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.setDetails('hidden')
    store.apply({ type: 'message.start' })
    store.apply({ type: 'moa.reference', payload: { label: 'm', text: 'b', index: 1, count: 1 } })
    store.apply({ type: 'message.complete' })
    // verify at the data layer: collapseHiddenParts keeps the moaReference
    const last = store.state.messages[store.state.messages.length - 1]
    const display = collapseHiddenParts(last?.parts ?? [])
    expect(display.some(p => p.type === 'moaReference')).toBe(true)
  })
})
