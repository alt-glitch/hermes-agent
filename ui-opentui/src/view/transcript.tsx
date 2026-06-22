/**
 * Transcript — the scrolling message pane (spec v4 §2 `view/transcript.tsx`).
 *
 * ONE full-height <scrollbox> with a reactive <For> (opencode's model — the
 * viewport clips growing output so terminal scrollback is never corrupted; no
 * `writeToScrollback`). Carries the §8 #2 gotchas EXACTLY:
 *   - `minHeight:0` on BOTH the wrapper box AND the <scrollbox> (so the flex
 *     child can shrink below content height instead of pushing the composer off),
 *   - NO `flexDirection` on the <scrollbox> ROOT style (it has internal
 *     viewport/content children; setting it there breaks content-height
 *     measurement → phantom scroll offset that clips the top + leaves a gap),
 *   - `stickyScroll` + `stickyStart="bottom"` to pin the latest line.
 *
 * A `ScrollAnchorProvider` gives collapse/expand toggles (tool/thinking) a handle
 * to hold the viewport in place so expanding doesn't yank to the bottom (#4).
 *
 * ── Windowing (S1+S2 of docs/plans/opentui-transcript-windowing.md, #27) ───
 * Behind `HERMES_TUI_WINDOWING` (unset → ON; 0/false/no/off → OFF), each row is
 * wrapped in a measuring box (`onSizeChange` records its exact laid-out height,
 * margins included) and rows outside [scrollTop − viewport, scrollTop +
 * 2·viewport) swap to an EXACT-HEIGHT empty spacer `<box height={recorded}/>`
 * — 1 yoga node, no text buffers, no native handles — so the mounted set stays
 * ~3 viewports of rows regardless of transcript length (the 671MB→Ink-parity
 * memory fix). The Solid `<Show>` unmount destroys the row's renderables
 * (@opentui/solid `_removeNode` → `destroyRecursively()` once unparented).
 *
 * Drivers (S2 — append-time adjudication, not just scroll):
 *  - a renderer frame callback (`setFrameCallback` — scroll always triggers a
 *    render, so every scroll movement is observed; no extra timer) compares
 *    `scrollTop` AND `scrollHeight` to the last computation anchor with
 *    ≥ ¼-viewport hysteresis (logic/window.ts),
 *  - a `createComputed` on `messages.length` re-adjudicates SYNCHRONOUSLY on
 *    every append/splice — while pinned at the bottom the window is anchored
 *    to the cumulative content BOTTOM (`pinnedBottom`), so burst-appended rows
 *    are windowed out the moment they scroll past the margin instead of
 *    ballooning the mounted set until the next frame.
 * Both publish the mounted-key set through one signal + `createSelector`, so
 * only rows whose mounted-ness actually flipped re-render.
 *
 * Never windowed: streaming rows, the last row while a turn runs, and the
 * bottom BOTTOM_ALWAYS_MOUNTED rows (see its doc). Rows the window has never
 * adjudicated default to MOUNTED only when created within the bottom
 * BOTTOM_ALWAYS_MOUNTED of the transcript or streaming (live rows paint
 * instantly with zero added latency); a row created deep in a bulk snapshot
 * (resume `commitSnapshot`) starts as an ESTIMATE spacer — a resumed 2k
 * session mounts only the bottom window. While a mouse selection is being
 * DRAGGED the window FREEZES (no swaps — a swap would destroy highlighted
 * renderables out from under the native selection walk); once the drag
 * finishes, the persisting highlight only PINS the rows containing selected
 * renderables (highlight + later Ctrl+C copy stay exact) so a streaming turn
 * can't balloon the mounted set behind a lingering selection.
 *
 * Spacer corrections (S2, the zero-jank rule): when a remount/measure lands a
 * height different from what the spacer occupied, the wrapper's onSizeChange
 * fires DURING the layout traversal, before any cell is painted. If the view
 * is pinned to the bottom the scrollbox's own sticky re-pin (which runs in the
 * content's onSizeChange, i.e. BEFORE the row wrappers') has already
 * re-anchored — nothing to do. Otherwise, for a row fully ABOVE the viewport
 * (`correctionIsLegal`), scrollTop is compensated by the delta in the same
 * frame, so visible content never moves. Corrections intersecting the
 * viewport are forbidden and simply not applied (the swap itself is the
 * accepted "fixed by remount" path).
 *
 * Lazy exact-measure (S2, design §4 — the documented SIMPLE choice):
 * @opentui/core cannot lay out without parenting into the live tree, so there
 * is no true offscreen measurement. When idle (no appends, no scroll movement,
 * no running turn, no selection for HERMES_TUI_WINDOW_IDLE_MS ≈ 1s), a pulse
 * mounts a small batch (MEASURE_BATCH_ROWS) of never-measured rows nearest the
 * bottom window edge (`edgeMeasureBatch` — they're the next to be seen),
 * records exact heights, and the next recompute swaps them back to now-exact
 * spacers; corrections obey the jank rule above. Rows far from the window keep
 * their estimates until the march reaches them. Scrolling itself measures the
 * margin band as it always did.
 *
 * DEV stats: current/peak simultaneously-mounted rows (logic/window.ts
 * `windowRowStats`) — exposed on `globalThis.__hermesTuiWindowStats` when
 * HERMES_TUI_WINDOW_STATS is set, asserted bounded by the headless tests.
 *
 * Known S2 limits (documented, deferred): /compact·/details toggles and width
 * resizes leave out-of-window spacer heights stale until remount or the idle
 * march (resize invalidation is S3, design §5). A discrete scroll jump larger
 * than the margin in one frame remounts a mis-estimated row already inside
 * the viewport — the in-viewport correction is forbidden (jank rule), so that
 * single user-caused frame absorbs the estimate error (the design's accepted
 * "remounted for view" path).
 */
import type { BoxRenderable, ScrollAcceleration, ScrollBoxRenderable } from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { createComputed, createMemo, createSelector, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'

import { diagnosticsEnabled, envFlag, scrollSpeedMultiplier } from '../logic/env.ts'
import type { Message, SessionStore } from '../logic/store.ts'
import {
  computeWindow,
  correctionIsLegal,
  edgeMeasureBatch,
  estimateMessageHeight,
  hysteresisFor,
  measureIdleDelayMs,
  noteRowMounted,
  noteRowUnmounted,
  shouldRecompute,
  windowRowStats
} from '../logic/window.ts'
import { DisplayProvider } from './display.tsx'
import { HomeHint } from './homeHint.tsx'
import { MessageLine, turnSpacing } from './messageLine.tsx'
import { ScrollAnchorProvider } from './scrollAnchor.tsx'
import { useTheme } from './theme.tsx'

/**
 * A constant-multiplier scroll acceleration — the OpenTUI port of Ink's
 * `HERMES_TUI_SCROLL_SPEED` base. OpenTUI owns the wheel-accel CURVE natively
 * (lib/scroll-acceleration.ts MacOSScrollAccel); this just lets a user dial the
 * base rows/event up or down by a fixed factor. Installed ONLY when the env var
 * is set (scrollSpeedMultiplier returns null otherwise → native default kept).
 */
function constantScrollAccel(multiplier: number): ScrollAcceleration {
  return {
    tick: () => multiplier,
    reset: () => {}
  }
}

/** Module-level: read once at first mount (env is fixed for the process life). */
const scrollSpeed = scrollSpeedMultiplier()
const scrollAccel: ScrollAcceleration | undefined = scrollSpeed !== null ? constantScrollAccel(scrollSpeed) : undefined

/**
 * The bottom K rows are ALWAYS mounted (the sticky-bottom region the user
 * lives in; also the zone where swap turbulence would be most visible). 30 is
 * a fixed, documented pick (the design's alternative — ceil(viewport/avg-row)
 * — buys little: rows under the viewport+margin are mounted by the window calc
 * anyway, so K only backstops sticky re-pins and burst appends).
 */
const BOTTOM_ALWAYS_MOUNTED = 30

/** Rows mounted per idle measure pulse (design §4 "small batches"). Small
 *  enough that a pulse's churn is invisible work above the viewport; the march
 *  covers a full resume snapshot over a couple of minutes of idleness. */
const MEASURE_BATCH_ROWS = 10

/** The published window state: which keys are mounted, and which keys the
 *  computation has SEEN (unseen keys default to mounted — see isMounted). */
interface WinState {
  readonly mounted: ReadonlySet<number>
  readonly known: ReadonlySet<number>
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false
  for (const k of a) if (!b.has(k)) return false
  return true
}

/** Signal equality for WinState — identical sets must not re-notify selectors. */
function sameWinState(a: WinState | undefined, b: WinState | undefined): boolean {
  if (!a || !b) return a === b
  return sameSet(a.mounted, b.mounted) && sameSet(a.known, b.known)
}

export function Transcript(props: { store: SessionStore }) {
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable | undefined>()
  const theme = useTheme()
  const renderer = useRenderer()
  const dropped = () => props.store.state.dropped
  const sid = () => props.store.state.sessionId
  // The NEWEST assistant answer's index — gold is earned (design pass): only
  // that turn's `⚕` glyph stays primary; older answers demote to grey.
  const latestAssistant = createMemo(() => {
    const messages = props.store.state.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') return i
    }
    return -1
  })

  // ── windowing state (S1) ───────────────────────────────────────────────
  // Read once per transcript: the flag is an A/B + escape hatch, not live config.
  const windowing = envFlag(process.env.HERMES_TUI_WINDOWING, true)
  // Stable row keys: messages carry no id and the store relies on reference
  // identity (<For> keys by item reference; solid-js/store proxies are cached
  // per underlying object, so the reference is stable across reads/mutations).
  // A WeakMap-assigned monotonic number gives the window math a primitive key
  // without restructuring the store or mutating Message objects.
  const rowKeys = new WeakMap<Message, number>()
  let rowSeq = 0
  const keyOf = (message: Message): number => {
    let key = rowKeys.get(message)
    if (key === undefined) {
      key = ++rowSeq
      rowKeys.set(message, key)
    }
    return key
  }
  // key → last exact height measured while the REAL row was mounted (the
  // wrapper's onSizeChange value; includes the row's margins). Non-reactive:
  // spacers read it once at swap time, the frame driver reads it per compute.
  const heights = new Map<number, number>()
  // key → the height the LAYOUT currently occupies for the row (real or
  // spacer/estimate — whatever the wrapper last laid out at). The S2 spacer-
  // correction compares a fresh measurement against this to compute the delta
  // that must be compensated when the change sits above the viewport.
  const assumed = new Map<number, number>()
  // key → the mount default for rows the window has never adjudicated,
  // decided at row CREATION: streaming rows and rows created within the bottom
  // BOTTOM_ALWAYS_MOUNTED of the transcript mount (live rows paint instantly);
  // anything deeper (a bulk resume snapshot) starts as an estimate spacer.
  const defaults = new Map<number, boolean>()
  // key → the row's live measuring wrapper (the idle measure pull below reads
  // post-layout heights for batch rows whose mount changed nothing); and the
  // reverse map (wrapper → key) for pinning rows under a persisting selection.
  const wrappers = new Map<number, BoxRenderable>()
  const wrapperKeys = new WeakMap<object, number>()
  // key → cached settled-row height estimate (estimateFor scans the row text —
  // caching keeps the per-append adjudication O(rows), not O(text)). Tagged
  // with the /compact flag it was computed under.
  const estimates = new Map<number, number>()
  let estimatesCompact = false
  const [winState, setWinState] = createSignal<WinState | undefined>(undefined, { equals: sameWinState })
  // Non-reactive mirror of the latest winState for event callbacks (onSizeChange
  // must not subscribe; createSelector reads are for tracked scopes).
  let liveWin: WinState | undefined
  /** Non-reactive mounted-ness (for onSizeChange et al.): the window's verdict
   *  when the key has been adjudicated, its creation default otherwise. */
  const mountedNow = (key: number): boolean => {
    if (!liveWin || !liveWin.known.has(key)) return defaults.get(key) ?? true
    return liveWin.mounted.has(key)
  }
  // Per-row mounted-ness: only rows whose answer FLIPPED re-run their <Show>.
  const isMounted = createSelector(winState, (key: number, s: WinState | undefined) => {
    if (!s || !s.known.has(key)) return defaults.get(key) ?? true
    return s.mounted.has(key)
  })
  const estimateFor = (message: Message, key: number): number => {
    const compact = props.store.state.compact
    if (compact !== estimatesCompact) {
      estimates.clear()
      estimatesCompact = compact
    }
    const streaming = message.streaming ?? false
    if (!streaming) {
      const cached = estimates.get(key)
      if (cached !== undefined) return cached
    }
    const estimate = estimateMessageHeight(
      message,
      turnSpacing(message.role, compact),
      compact ? 0 : 1,
      !compact && !streaming
    )
    if (!streaming) estimates.set(key, estimate)
    return estimate
  }
  // DEV stats exposure for the bench (HERMES_TUI_WINDOW_STATS — defaults to
  // the HERMES_TUI_DIAGNOSTICS master switch; settable individually): the live
  // current/peak mounted-row counters from logic/window.ts.
  if (envFlag(process.env.HERMES_TUI_WINDOW_STATS, diagnosticsEnabled())) {
    ;(globalThis as unknown as Record<string, unknown>)['__hermesTuiWindowStats'] = windowRowStats()
  }

  // ── window drivers: per-frame scrollTop/scrollHeight check (no scroll signal
  // exists; the frame callback fires on every rendered frame, and scrolling
  // always renders) + a synchronous re-adjudication on every append (S2).
  let anchor: number | null = null
  let lastCount = -1
  let lastScrollHeight = -1
  let lastScrollTop = -1
  let lastActivityAt = Date.now()
  let lastPulseAt = 0
  let measureBatch: ReadonlySet<number> = new Set<number>()
  const idleMs = measureIdleDelayMs(process.env.HERMES_TUI_WINDOW_IDLE_MS)
  const tick = (force = false): void => {
    const sb = scroll()
    if (!sb) return
    // Selection handling (S2 refinement of the S1 full freeze):
    //  - while DRAGGING, the native selection walks the LIVE tree on every
    //    update — swapping a row out (destroying its renderables) mid-walk
    //    would corrupt the highlight/copy. Full freeze, as in S1.
    //  - a FINISHED highlight persists by design (boundary/renderer.ts keeps
    //    it so Ctrl+C can re-copy). An indefinite full freeze would let a
    //    burst-streaming turn balloon the mounted set (the S1 hole this slice
    //    closes), so instead only the rows that CONTAIN selected renderables
    //    are pinned (never windowed) — the highlight and a later Ctrl+C copy
    //    stay exact, and everything else keeps windowing.
    const selection = renderer.getSelection()
    if (selection?.isActive && selection.isDragging) {
      lastActivityAt = Date.now()
      return
    }
    const pinned = new Set<number>()
    if (selection?.isActive) {
      lastActivityAt = Date.now() // a live highlight is activity: no idle pulses
      for (const renderable of selection.selectedRenderables) {
        let node: unknown = renderable
        while (node && typeof node === 'object') {
          const key = wrapperKeys.get(node)
          if (key !== undefined) {
            pinned.add(key)
            break
          }
          node = (node as { parent?: unknown }).parent
        }
      }
    }
    const viewportHeight = sb.viewport.height
    if (viewportHeight <= 0) return
    const messages = props.store.state.messages
    // Idle measure pull: a batch row whose mount landed at EXACTLY the spacer
    // height fires no onSizeChange — read its post-layout height directly so
    // the march advances past it. (Batch publishes happen only in frame-
    // callback ticks, so by ANY later tick the batch's layout has run.)
    for (const key of measureBatch) {
      if (heights.has(key) || !mountedNow(key)) continue
      const wrapper = wrappers.get(key)
      const h = wrapper?.height ?? 0
      if (h > 0) {
        heights.set(key, h)
        assumed.set(key, h)
      }
    }
    const scrollTop = sb.scrollTop
    const scrollHeight = sb.scrollHeight
    const running = props.store.state.info.running ?? false
    const countChanged = messages.length !== lastCount
    const hysteresis = hysteresisFor(viewportHeight)
    // Content growth without a count change (streaming deltas) moves
    // scrollHeight — treat it like scroll movement against the same hysteresis.
    const heightMoved = lastScrollHeight !== -1 && Math.abs(scrollHeight - lastScrollHeight) >= hysteresis
    const scrolled = shouldRecompute(scrollTop, anchor, hysteresis)
    const now = Date.now()
    if (countChanged || scrollTop !== lastScrollTop || running) lastActivityAt = now
    lastScrollTop = scrollTop
    // Idle measure pulse (design §4): only in frame-callback ticks (append
    // ticks are activity by definition), only when truly idle, only while
    // some row is still unmeasured (heights covers every live measured key).
    const pulseDue =
      !force &&
      !running &&
      heights.size < messages.length &&
      now - lastActivityAt >= idleMs &&
      now - lastPulseAt >= idleMs
    if (!force && !countChanged && !heightMoved && !scrolled && !pulseDue) return
    const rows = messages.map((message, i) => {
      const key = keyOf(message)
      const height = heights.get(key) ?? null
      return {
        key,
        height,
        estimate: height === null ? estimateFor(message, key) : undefined,
        // Never window: a streaming row (remount would restart native markdown
        // streaming) and the last row while a turn runs (deltas land there).
        // A row with an expanded tool/reasoning body is NOT detectable from
        // here (the override lives in component-local signals — toolPart.tsx/
        // reasoningPart.tsx); expanded rows far above the viewport may
        // re-collapse on remount. Accepted for S1.
        neverWindow: (message.streaming ?? false) || (running && i === messages.length - 1) || pinned.has(key)
      }
    })
    // Pinned to the bottom (sticky region): anchor the window to the content
    // BOTTOM so rows appended since the last layout are adjudicated against
    // where the pin will land, not a stale scrollTop (S2 append-time rule).
    const atBottom = scrollTop >= scrollHeight - viewportHeight
    const result = computeWindow({
      rows,
      scrollTop,
      viewportHeight,
      margin: viewportHeight, // 1 viewport each side (design §Mechanism 1)
      bottomK: BOTTOM_ALWAYS_MOUNTED,
      pinnedBottom: atBottom
    })
    anchor = result.anchor
    lastCount = messages.length
    lastScrollHeight = scrollHeight
    const known = new Set(rows.map(r => r.key))
    // The store cap splices old rows out — drop their per-key records too.
    if (countChanged) {
      for (const map of [heights, assumed, defaults, estimates]) {
        for (const key of map.keys()) if (!known.has(key)) map.delete(key)
      }
    }
    // Idle measure batch: mount the next never-measured rows nearest the
    // window edge. The previous batch stays mounted until the NEXT pulse
    // replaces it (not merely until a height lands): async row content — the
    // native markdown tokenizes over a few frames — needs more than one layout
    // pass before its recorded height is trustworthy. Once everything is
    // measured the leftover batch drops back to (exact) spacers.
    let batch = new Set<number>()
    if (pulseDue) {
      batch = new Set(edgeMeasureBatch(rows, result.mounted, MEASURE_BATCH_ROWS))
      lastPulseAt = now
    } else if (heights.size < messages.length) {
      for (const key of measureBatch) if (known.has(key)) batch.add(key)
    }
    measureBatch = batch
    const mounted = batch.size > 0 ? new Set([...result.mounted, ...batch]) : result.mounted
    liveWin = { mounted, known }
    setWinState(liveWin)
  }
  onMount(() => {
    if (!windowing) return
    const frame = (_deltaTime: number): Promise<void> => {
      tick()
      return Promise.resolve()
    }
    renderer.setFrameCallback(frame)
    onCleanup(() => renderer.removeFrameCallback(frame))
  })
  // Append-time adjudication (S2): re-window synchronously when the transcript
  // grows/shrinks, so a burst of appends can't balloon the mounted set between
  // frames. `on(..., { defer })` keeps the tick untracked — only the length
  // re-runs it (content deltas are the frame driver's scrollHeight check).
  if (windowing) {
    createComputed(
      on(
        () => props.store.state.messages.length,
        () => tick(true),
        { defer: true }
      )
    )
  }

  /** One windowed row: a measuring wrapper around the real MessageLine or an
   *  exact-height spacer. The wrapper stays mounted either way (1 box), so its
   *  `onSizeChange` keeps the height record fresh while the row is real. */
  const WindowedRow = (rowProps: { message: Message; index: () => number }) => {
    const key = keyOf(rowProps.message)
    // Creation default for the not-yet-adjudicated row (see `defaults`):
    // appended live rows land in the bottom region → mounted instantly; a row
    // created deep inside a bulk snapshot starts as an estimate spacer.
    // (Component bodies are untracked — these reads are a one-time snapshot.)
    defaults.set(
      key,
      (rowProps.message.streaming ?? false) ||
        rowProps.index() >= props.store.state.messages.length - BOTTOM_ALWAYS_MOUNTED
    )
    let wrapper: BoxRenderable | undefined
    onCleanup(() => wrappers.delete(key))
    const record = (): void => {
      if (!wrapper) return
      const h = wrapper.height
      if (h <= 0) return
      // Record the exact height only while the REAL row is mounted — a
      // spacer's (estimate's) height must never overwrite the measurement.
      if (mountedNow(key)) heights.set(key, h)
      const prev = assumed.get(key)
      assumed.set(key, h)
      if (prev === undefined || prev === h) return
      // ── S2 spacer correction (the zero-jank rule) ─────────────────────
      // The row's laid-out height changed (estimate spacer → measured row, or
      // a re-measure). onSizeChange fires inside the layout traversal, before
      // paint. The scrollbox content's own onSizeChange (parent — runs FIRST)
      // already re-pinned the bottom when sticky applies, so at-bottom needs
      // no compensation here. Otherwise compensate scrollTop for changes
      // fully ABOVE the viewport — same frame, zero visible movement. The
      // legality check uses the row's PREVIOUS extent (what the user sees).
      const sb = scroll()
      if (!sb) return
      const viewportHeight = sb.viewport.height
      if (viewportHeight <= 0) return
      const scrollTop = sb.scrollTop
      const atBottom = scrollTop >= sb.scrollHeight - viewportHeight
      if (atBottom) return // the sticky pin compensated already
      const rowTop = wrapper.y - sb.content.y // content-space coordinates
      const rowBottom = rowTop + prev
      if (correctionIsLegal(rowTop, rowBottom, scrollTop, viewportHeight, atBottom) && rowBottom <= scrollTop) {
        sb.scrollTop = scrollTop + (h - prev)
      }
    }
    /** The real row, instrumented: the DEV mounted-row counters the headless
     *  tests assert against (and the bench can read — see windowRowStats). */
    const RealRow = () => {
      noteRowMounted()
      onCleanup(noteRowUnmounted)
      return <MessageLine message={rowProps.message} latest={rowProps.index() === latestAssistant()} />
    }
    return (
      <box
        ref={el => {
          wrapper = el
          wrappers.set(key, el)
          wrapperKeys.set(el, key)
        }}
        style={{ flexDirection: 'column', flexShrink: 0 }}
        onSizeChange={record}
      >
        <Show
          when={isMounted(key)}
          fallback={<box style={{ height: heights.get(key) ?? estimateFor(rowProps.message, key), flexShrink: 0 }} />}
        >
          <RealRow />
        </Show>
      </box>
    )
  }

  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      {/* reserve a 1-cell right gutter so the vertical scrollbar never paints OVER
          hard-width content (markdown tables / code blocks clipped their right
          border under the bar — glitch 2026-06-13). */}
      <scrollbox
        ref={setScroll}
        style={{ flexGrow: 1, minHeight: 0 }}
        contentOptions={{ paddingRight: 1 }}
        stickyScroll
        stickyStart="bottom"
        {...(scrollAccel ? { scrollAcceleration: scrollAccel } : {})}
      >
        <ScrollAnchorProvider scroll={scroll}>
          {/* display flags (/compact, /details — Epic 3) for the rows below */}
          <DisplayProvider
            flags={() => ({
              compact: props.store.state.compact,
              details: props.store.state.details,
              timestamps: props.store.state.timestamps,
              reasoningFull: props.store.state.reasoningFull
            })}
          >
            {/* empty-transcript home screen (item 12); replaced by messages on the first turn */}
            <Show when={props.store.state.messages.length === 0}>
              <HomeHint store={props.store} />
            </Show>
            {/* Honest truncation notice: the rolling cap hides the OLDEST rows from the
              DISPLAY (never the model's context — that lives on the gateway). Point to
              the dashboard for the full transcript. selectable=false → it's chrome,
              excluded from copy/selection. */}
            <Show when={dropped() > 0}>
              <text selectable={false} style={{ fg: theme().color.muted }}>
                {`⤒ ${dropped()} earlier message${dropped() === 1 ? '' : 's'} — scroll-back capped; full transcript on the dashboard${sid() ? ` · session ${sid()}` : ''}`}
              </text>
            </Show>
            <For each={props.store.state.messages}>
              {(message, i) =>
                windowing ? (
                  <WindowedRow message={message} index={i} />
                ) : (
                  <MessageLine message={message} latest={i() === latestAssistant()} />
                )
              }
            </For>
          </DisplayProvider>
        </ScrollAnchorProvider>
      </scrollbox>
    </box>
  )
}
