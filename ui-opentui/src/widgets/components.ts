/**
 * The sdk's composite components — Dialog, Accordion, Shimmer loaders, grid
 * shims — implemented as plain widget-runtime function components (h + hooks)
 * so the shared template contract behaves the same on both engines. These are
 * transliterations of the Ink originals (`ui-tui/src/components/*`), with the
 * engine-specific bits (theme store reads) going through `useWidgetTheme`.
 */
import { Box, Fragment, h, Text, type WNode } from './element.ts'
import { useEffect, useState, useWidgetTheme } from './runtime.ts'

// ── small color helper (Ink lib/color.js `mix` equivalent) ──────────

function channel(hex: string, at: number): number {
  return Number.parseInt(hex.slice(at, at + 2), 16)
}

function mixHex(a: string, b: string, t: number): string {
  const ha = /^#[0-9a-fA-F]{6}$/.test(a) ? a : '#808080'
  const hb = /^#[0-9a-fA-F]{6}$/.test(b) ? b : '#808080'
  const lerp = (x: number, y: number) => Math.round(x + (y - x) * t)
  const part = (at: number) =>
    lerp(channel(ha.slice(1), at), channel(hb.slice(1), at))
      .toString(16)
      .padStart(2, '0')
  return `#${part(0)}${part(2)}${part(4)}`
}

// ── Dialog ───────────────────────────────────────────────────────────

/** Bordered card with optional title + hint (Ink `Dialog` parity). */
export function Dialog(props: Record<string, unknown>): WNode {
  const theme = useWidgetTheme()
  const width = typeof props['width'] === 'number' ? props['width'] : undefined
  const title = typeof props['title'] === 'string' ? props['title'] : undefined
  const hint = props['hint']
  const innerWidth = width !== undefined ? Math.max(1, width - 6) : undefined
  return h(
    Box,
    {
      borderColor: theme.color.primary,
      borderStyle: 'round',
      flexDirection: 'column',
      paddingX: 2,
      paddingY: 1,
      ...(width !== undefined ? { width } : {})
    },
    title !== undefined
      ? h(
          Box,
          { justifyContent: 'center', marginBottom: 1, ...(innerWidth !== undefined ? { width: innerWidth } : {}) },
          h(Text, { bold: true, color: theme.color.primary }, title)
        )
      : null,
    props['children'] as WNode,
    hint !== undefined
      ? h(
          Box,
          { marginTop: 1 },
          typeof hint === 'string' ? h(Text, { color: theme.color.muted }, hint) : (hint as WNode)
        )
      : null
  )
}

/** Placement shell for modal content. The native host owns modal placement
 *  (the widget panel renders above the status bar), so Overlay is a plain
 *  column wrapper here — content and theming carry over 1:1. */
export function Overlay(props: Record<string, unknown>): WNode {
  return h(Box, { flexDirection: 'column' }, props['children'] as WNode)
}

// ── Accordion ────────────────────────────────────────────────────────

/** Expand/collapse section (Ink `Accordion` parity — click the header row to
 *  toggle; modal apps may drive `open` from reducer state instead). */
export function Accordion(props: Record<string, unknown>): WNode {
  const [uncontrolled, setUncontrolled] = useState(props['defaultOpen'] === true)
  const t = (props['t'] as { color: { accent: string; muted: string } } | undefined) ?? useWidgetTheme()
  const open = typeof props['open'] === 'boolean' ? props['open'] : uncontrolled
  const count = typeof props['count'] === 'number' ? props['count'] : undefined
  const suffix = typeof props['suffix'] === 'string' ? props['suffix'] : undefined
  const onToggle = props['onToggle']
  const toggle = () => {
    if (typeof onToggle === 'function') (onToggle as () => void)()
    if (typeof props['open'] !== 'boolean') setUncontrolled(v => !v)
  }
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { onClick: toggle },
      h(Text, { color: t.color.accent }, open ? '▾ ' : '▸ '),
      h(Text, { bold: true, color: t.color.accent }, typeof props['title'] === 'string' ? props['title'] : ''),
      count !== undefined ? h(Text, { color: t.color.muted }, ` (${count})`) : null,
      suffix !== undefined ? h(Text, { color: t.color.muted }, ` ${suffix}`) : null
    ),
    open ? (props['children'] as WNode) : null
  )
}

// ── shimmer loaders (Ink `loaders.tsx` parity) ───────────────────────

const BAND = 7

/** Pure band math: [pre, band, post] cell widths for a sweep at `phase`. */
export function shimmerSegments(width: number, phase: number, band = BAND): [number, number, number] {
  const cycle = width + band
  const start = (((phase % cycle) + cycle) % cycle) - band
  const from = Math.max(0, start)
  const to = Math.min(width, start + band)
  return to <= from ? [width, 0, 0] : [from, to - from, width - to]
}

/** One shimmering run. Controlled: the parent owns `phase`. */
export function Shimmer(props: Record<string, unknown>): WNode {
  const char = typeof props['char'] === 'string' ? props['char'] : '▁'
  const color = typeof props['color'] === 'string' ? props['color'] : '#808080'
  const highlight = typeof props['highlight'] === 'string' ? props['highlight'] : '#a0a0a0'
  const phase = typeof props['phase'] === 'number' ? props['phase'] : 0
  const width = typeof props['width'] === 'number' ? props['width'] : 8
  const [pre, band, post] = shimmerSegments(width, phase)
  return h(
    Text,
    null,
    pre > 0 ? h(Text, { color }, char.repeat(pre)) : null,
    band > 0 ? h(Text, { color: highlight }, char.repeat(band)) : null,
    post > 0 ? h(Text, { color }, char.repeat(post)) : null
  )
}

// Shared shimmer clock: ONE unref'd interval drives every mounted shimmer
// composition; it exists only while subscribers do.
const TICK_MS = 90

/** Animation budget per mount — after it the skeleton freezes in place. */
export const SHIMMER_ANIMATE_MS = 30_000

const clockListeners = new Set<(phase: number) => void>()
let clockId: NodeJS.Timeout | null = null
let clockPhase = 0

export function subscribeShimmerClock(fn: (phase: number) => void): () => void {
  clockListeners.add(fn)
  if (!clockId) {
    clockId = setInterval(() => {
      clockPhase += 1
      for (const listener of clockListeners) listener(clockPhase)
    }, TICK_MS)
    clockId.unref()
  }
  return () => {
    clockListeners.delete(fn)
    if (!clockListeners.size && clockId) {
      clearInterval(clockId)
      clockId = null
    }
  }
}

/** Phase from the shared clock, bounded: stops advancing after `animateMs`. */
export function useShimmerPhase(animateMs = SHIMMER_ANIMATE_MS): number {
  const [phase, setPhase] = useState(clockPhase)
  useEffect(() => {
    const startedAt = Date.now()
    let unsubscribe: (() => void) | null = subscribeShimmerClock(next => {
      if (Date.now() - startedAt >= animateMs) {
        unsubscribe?.()
        unsubscribe = null
        return
      }
      setPhase(next)
    })
    return () => {
      unsubscribe?.()
      unsubscribe = null
    }
  }, [animateMs])
  return phase
}

/** Skeleton rows shaped like `label: value` content, diagonal shimmer. */
export function ShimmerRows(props: Record<string, unknown>): WNode {
  const phase = useShimmerPhase()
  const t = props['t'] as { color: { completionBg: string; label: string; muted: string } } | undefined
  const width = typeof props['width'] === 'number' ? props['width'] : 24
  const rows = props['rows']
  const base =
    typeof props['color'] === 'string'
      ? props['color']
      : t
        ? mixHex(t.color.muted, t.color.completionBg, 0.5)
        : '#808080'
  const glow = typeof props['highlight'] === 'string' ? props['highlight'] : (t?.color.label ?? '#a0a0a0')
  const spec: readonly (readonly [number, number])[] =
    typeof rows === 'number'
      ? Array.from({ length: Math.max(1, rows) }, (_, i) => {
          const label = Math.max(4, Math.round(width * 0.3) - (i % 3))
          return [label, Math.max(4, width - label - 1)] as const
        })
      : Array.isArray(rows)
        ? (rows as readonly (readonly [number, number])[])
        : [[8, 15] as const]
  return h(
    Box,
    { flexDirection: 'column' },
    ...spec.map(([labelWidth, valueWidth], i) =>
      h(
        Text,
        null,
        h(Shimmer, { color: base, highlight: glow, phase: phase - i * 2, width: labelWidth }),
        h(Text, null, ' '),
        h(Shimmer, { color: base, highlight: glow, phase: phase - i * 2 - labelWidth, width: valueWidth })
      )
    )
  )
}

// ── grid shims ───────────────────────────────────────────────────────

/** Minimal grid shims: the Ink versions do measured grid layout for the
 *  modal debug demos; user widgets get a flex approximation here. */
export function WidgetGrid(props: Record<string, unknown>): WNode {
  return h(Box, { flexDirection: 'row', flexWrap: 'wrap', gap: 1 }, props['children'] as WNode)
}

export function GridAreas(props: Record<string, unknown>): WNode {
  return h(Box, { flexDirection: 'column', gap: 1 }, props['children'] as WNode)
}

export { Fragment }
