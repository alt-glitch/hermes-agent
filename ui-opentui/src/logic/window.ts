/**
 * window — pure transcript-windowing math (slices S1+S2 of docs/plans/
 * opentui-transcript-windowing.md, issue #27). The view (view/transcript.tsx)
 * replaces out-of-window rows with EXACT-HEIGHT empty boxes (1 yoga node, no
 * text buffers / native handles), so the mounted set stays ~3 viewports of
 * rows regardless of transcript length. This module is the testable core:
 *
 *  - `computeWindow` — which row keys must be mounted for a given scrollTop:
 *    rows intersecting [scrollTop − margin, scrollTop + viewport + margin)
 *    over CUMULATIVE row heights (exact recorded heights; a line-count
 *    estimate stands in for never-measured rows), plus the never-window rows
 *    (streaming/live) and the bottom K rows (sticky-bottom region). With
 *    `pinnedBottom` (S2) the window anchors to the BOTTOM of the content
 *    instead of `scrollTop`: during burst appends / a resume snapshot the
 *    sticky pin will land at the new bottom, but layout (and therefore
 *    scrollTop) lags the store — anchoring to the cumulative content bottom
 *    adjudicates appended rows immediately instead of one frame late.
 *  - `shouldRecompute` — the hysteresis gate (≥ ¼ viewport via
 *    `hysteresisFor`): a computed window only changes once scrollTop has
 *    moved ≥ hysteresis from the anchor it was computed at, so swaps don't
 *    thrash at window edges.
 *  - `correctionIsLegal` — the jank rule for spacer-height corrections:
 *    a correction may only touch rows fully ABOVE the viewport (the caller
 *    compensates scrollTop in the same frame — automatic when bottom-anchored
 *    via the sticky pin) or fully BELOW it (invisible by definition). Anything
 *    intersecting the viewport would visibly move content: forbidden.
 *  - `estimateMessageHeight` — the cheap line-count estimate for rows that
 *    have never been measured (resume history above the viewport). A wrong
 *    estimate is fixed by remount (scrolling near) or by the S2 idle measure
 *    pass, both governed by the jank rule.
 *  - `edgeMeasureBatch` (S2 — design §4, the SIMPLE choice): @opentui/core
 *    cannot lay a renderable out without parenting it into the live tree
 *    (layout is the tree's Yoga pass), so true offscreen measurement isn't
 *    available. Instead the idle pass mounts a small batch of never-measured
 *    rows nearest the bottom window edge — they are the next to be seen when
 *    the user scrolls back — records their exact heights, and lets the next
 *    window recompute swap them back to (now exact) spacers. Estimates far
 *    from the window stay estimates until the march reaches them.
 *  - `windowRowStats` — a DEV counter (current / peak simultaneously-mounted
 *    real rows) the integration tests assert against and the bench can read
 *    (transcript.tsx exposes it on globalThis behind HERMES_TUI_WINDOW_STATS).
 */
import type { Message, Part } from './store.ts'

/** One transcript row as the window calc sees it. */
export interface WindowRow<K> {
  readonly key: K
  /** Exact recorded height (the row wrapper's last onSizeChange measurement,
   *  margins included) — or null when the row has never been measured. */
  readonly height: number | null
  /** Line-count estimate used while `height` is null (see estimateMessageHeight). */
  readonly estimate?: number | undefined
  /** Always mounted regardless of the window (streaming/live rows — a remount
   *  would restart native markdown streaming). */
  readonly neverWindow: boolean
}

export interface WindowParams<K> {
  readonly rows: readonly WindowRow<K>[]
  readonly scrollTop: number
  readonly viewportHeight: number
  /** Mounted band kept above/below the viewport (design: 1 viewport each side). */
  readonly margin: number
  /** Stand-in height for null-height rows without their own estimate. */
  readonly fallbackHeight?: number
  /** The bottom K rows are always mounted (sticky-bottom region). */
  readonly bottomK?: number
  /** Anchor the window to the BOTTOM of the cumulative content instead of
   *  `scrollTop` (S2 append-time adjudication): while the view is pinned to
   *  the bottom, appended rows extend the content BELOW the last laid-out
   *  scrollTop — the sticky pin only catches up at the next layout pass.
   *  Anchoring to the content bottom adjudicates those rows immediately
   *  (new in-window rows mount, rows pushed past the margin become spacers)
   *  without waiting a frame. */
  readonly pinnedBottom?: boolean
}

export interface WindowResult<K> {
  /** Row keys that must be mounted; everything else renders as a spacer. */
  readonly mounted: ReadonlySet<K>
  /** The scrollTop this window was computed at — the next hysteresis anchor. */
  readonly anchor: number
}

/** Default stand-in for a null-height row with no estimate (≈ a short row). */
export const DEFAULT_FALLBACK_HEIGHT = 2

/** Ceiling on a single row's line-count estimate — a pathological wall of text
 *  must not make the never-mounted region look kilometers tall. */
const ESTIMATE_MAX_LINES = 500

/** Hysteresis for the window recompute: ≥ ¼ viewport (design rule), never 0. */
export function hysteresisFor(viewportHeight: number): number {
  return Math.max(1, Math.ceil(viewportHeight / 4))
}

/** Whether scrollTop has moved far enough from the last computation anchor to
 *  justify a new window (no anchor yet → always). */
export function shouldRecompute(scrollTop: number, anchor: number | null, hysteresis: number): boolean {
  if (anchor === null) return true
  return Math.abs(scrollTop - anchor) >= hysteresis
}

/** Compute the set of row keys that must be mounted for this scroll position. */
export function computeWindow<K>(params: WindowParams<K>): WindowResult<K> {
  const fallback = params.fallbackHeight ?? DEFAULT_FALLBACK_HEIGHT
  const bottomK = params.bottomK ?? 0
  const heightOf = (r: WindowRow<K>): number => r.height ?? r.estimate ?? fallback
  // pinnedBottom: the effective scrollTop is where the sticky pin will land —
  // the cumulative content bottom minus one viewport (clamped at 0).
  let effectiveTop = params.scrollTop
  if (params.pinnedBottom) {
    let contentHeight = 0
    for (const r of params.rows) contentHeight += heightOf(r)
    effectiveTop = Math.max(0, contentHeight - params.viewportHeight)
  }
  const windowStart = effectiveTop - params.margin
  const windowEnd = effectiveTop + params.viewportHeight + params.margin
  const total = params.rows.length
  const mounted = new Set<K>()
  let top = 0
  let index = 0
  for (const r of params.rows) {
    const bottom = top + heightOf(r)
    // half-open intersection: a row merely touching a window edge stays out.
    const intersects = bottom > windowStart && top < windowEnd
    if (intersects || r.neverWindow || index >= total - bottomK) mounted.add(r.key)
    top = bottom
    index++
  }
  return { mounted, anchor: effectiveTop }
}

/** Rows the S2 idle measure pass should mount next: up to `batch` never-
 *  measured, not-currently-mounted, windowable rows, NEAREST THE BOTTOM first
 *  (the bottom window edge is where a scroll-back enters history, so these are
 *  the next rows to be seen; the march then proceeds upward over idle pulses).
 *  Never-window rows are excluded — they are always mounted anyway. */
export function edgeMeasureBatch<K>(rows: readonly WindowRow<K>[], mounted: ReadonlySet<K>, batch: number): K[] {
  const out: K[] = []
  for (let i = rows.length - 1; i >= 0 && out.length < batch; i--) {
    const r = rows[i]
    if (!r || r.height !== null || r.neverWindow || mounted.has(r.key)) continue
    out.push(r.key)
  }
  return out
}

/** Default idle delay before a lazy measure pulse (design §4): no appends, no
 *  scroll movement, no running turn for this long → mount one small batch. */
export const DEFAULT_MEASURE_IDLE_MS = 1000

/** Parse `HERMES_TUI_WINDOW_IDLE_MS` (TUI-only DEV/test knob): the idle delay
 *  before a lazy measure pulse. A non-negative integer → that delay (0 = pulse
 *  on every idle frame — the headless tests use this to make pulses
 *  deterministic); unset/garbage → DEFAULT_MEASURE_IDLE_MS. */
export function measureIdleDelayMs(value: string | undefined): number {
  const v = value?.trim() ?? ''
  if (!/^\d+$/.test(v)) return DEFAULT_MEASURE_IDLE_MS
  return Number.parseInt(v, 10)
}

// ── DEV counter: simultaneously-mounted real rows (current + peak) ────────
// Two ints, always maintained (the cost is negligible); the integration tests
// assert `peakMounted` stays bounded during bursts/resume, and transcript.tsx
// exposes the live object on globalThis when HERMES_TUI_WINDOW_STATS is set so
// the bench can sample it. One transcript per process in practice; tests that
// mount several reset between phases.
export interface WindowRowStats {
  mounted: number
  peakMounted: number
}

const rowStats: WindowRowStats = { mounted: 0, peakMounted: 0 }

/** The live stats object (mutated in place — safe to hold a reference). */
export function windowRowStats(): Readonly<WindowRowStats> {
  return rowStats
}

export function noteRowMounted(): void {
  rowStats.mounted++
  if (rowStats.mounted > rowStats.peakMounted) rowStats.peakMounted = rowStats.mounted
}

export function noteRowUnmounted(): void {
  rowStats.mounted--
}

/** Reset the peak to the CURRENT mounted count (rows still live stay counted). */
export function resetWindowRowStats(): void {
  rowStats.peakMounted = rowStats.mounted
}

/**
 * The jank rule: may a spacer-height correction for the row spanning
 * [rowTop, rowBottom) be applied at this scroll position without visibly
 * moving content?
 *
 *  - Fully BELOW the viewport → legal (invisible by definition).
 *  - Fully ABOVE the viewport → legal, PROVIDED the caller compensates
 *    scrollTop by the height delta in the same frame. When `atBottom`
 *    (sticky-bottom pinned) the pin performs that compensation automatically
 *    (bottom-anchored ⇒ zero visual movement); legality is the same either
 *    way — the flag documents which side owes the compensation.
 *  - Intersecting the viewport → forbidden; defer until the row scrolls out
 *    or is remounted for view.
 */
export function correctionIsLegal(
  rowTop: number,
  rowBottom: number,
  scrollTop: number,
  viewportHeight: number,
  _atBottom: boolean
): boolean {
  if (rowTop >= scrollTop + viewportHeight) return true // fully below the viewport
  if (rowBottom <= scrollTop) return true // fully above — compensate scrollTop in the same frame
  return false
}

/** Rendered line count of a text block (1-based; empty text still occupies a row). */
function lineCount(text: string): number {
  if (!text) return 1
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return lines
}

/** Estimated rendered lines of one part: text → its line count (view strips
 *  leading/trailing blanks — mirror that) + the settled block's `⧉ copy` chip
 *  line when `chips`; tool/reasoning → 1 collapsed header line (the default
 *  render for settled, never-mounted history). */
function partLines(part: Part, chips: boolean): number {
  if (part.type === 'text') return lineCount(part.text.replace(/^\n+|\n+$/g, '')) + (chips ? 1 : 0)
  return 1 // collapsed tool/reasoning header line
}

/**
 * Cheap line-count height estimate for a row that has never been measured
 * (resume history above the viewport). Deliberately ignores soft wrapping
 * — it is a placeholder until the row is actually mounted/measured, and a
 * wrong value may only be corrected per `correctionIsLegal` (or left until
 * remount). `spacing` is the row's turnSpacing margins; `gap` the inter-part
 * blank line (0 in /compact); `chips` mirrors the view's per-block `⧉ copy`
 * line (settled non-system rows outside /compact — messageLine.tsx CopyChip).
 */
export function estimateMessageHeight(
  message: Pick<Message, 'text' | 'parts'> & {
    readonly notification?: Message['notification']
    readonly role?: Message['role']
  },
  spacing: { readonly top: number; readonly bottom: number },
  gap: number,
  chips = false
): number {
  // Notification details are collapsed by default. Never budget their hidden
  // long-form body into a resume spacer; doing so recreates the giant-scroll
  // footprint that the disclosure row exists to prevent.
  if (message.notification) {
    return Math.min(ESTIMATE_MAX_LINES, Math.max(1, lineCount(message.text))) + spacing.top + spacing.bottom
  }
  const parts = message.parts
  let content: number
  if (parts && parts.length > 0) {
    content = gap * (parts.length - 1)
    for (const part of parts) content += partLines(part, chips)
  } else {
    content = lineCount(message.text)
    if (chips && message.role !== undefined && message.role !== 'system' && message.text.trim()) content += 1
  }
  return Math.min(ESTIMATE_MAX_LINES, Math.max(1, content)) + spacing.top + spacing.bottom
}
