/**
 * StatusBar — the session chrome above the composer. ONE left-aligned line at
 * EVERY width (status chrome v3 — user feedback: "everything left-aligned,
 * all on one line, no random scatter"):
 *
 *   ● model ·effort │ ctx: ██████░░░░░░ 42% · 84k │ cost: $0.41 │ up: 23m │ cmp: 2 │ profile │ mcp: 2 │ …/cwd (branch)
 *
 * Design rules (this pass):
 *   - Every segment is LABELED and terse (`ctx:`, `cost:`, `up:`, `cmp:`,
 *     `mcp:`; the profile name reads as itself) — self-describing, lowercase,
 *     no decoration.
 *   - No right-pinning, no flexGrow spacer, no two-line wide mode: segments
 *     flow left with generous ` │ ` separators; the cwd comes LAST and
 *     tail-truncates into whatever width remains (dropped entirely below a
 *     useful budget — never squeezed to noise).
 *   - The context bar is the chrome's most important gauge, so it BREATHES:
 *     10–14 cells by terminal width (`ctxBarCells`), vs the old 5.
 *   - Responsive = drop, don't restack: as the terminal narrows, tail segments
 *     drop WHOLE in reverse priority (mcp → bg → profile → cmp → up → cost →
 *     ctx detail collapsing to a bare `ctx: 42%`, then the `⚡ agents` chip) via
 *     the pure, table-tested `statusSegments` ladder. The health dot, model and
 *     ctx % are pinned. Nothing truncates mid-segment, so the row NEVER wraps.
 *
 * A pending update (`info.update_behind > 0`) BORROWS the whole line as a
 * transient notice; it dismisses on Esc or after NOTICE_TTL_MS.
 *
 * Colors respect the Appendix C roles: the navy `statusBg` fill (the one
 * correct blue surface), `statusFg` for the model/profile/percent, muted
 * metrics + labels, ok/warn dot, level-tinted ctx bar and cmp count.
 *
 * Background-activity chrome (glitch 2026-06-13): `⚡ N` = running subagents
 * (folded here from the old agents-tray line; includes background/async
 * delegations, which also emit `subagent.*` events while they run), `bg: N` =
 * in-flight background PROMPTS (`/bg` → prompt.background, cleared on
 * background.complete). When the turn is IDLE but a background delegation is
 * still in flight, the bar adds `↩ resumes when subagent finishes` (driven by
 * the registry-backed `usage.active_subagents`, the one signal `⚡` can't give —
 * SubagentInfo has no fg/bg flag). All hidden at zero. (OS background processes
 * live in the /processes panel.)
 *
 * Parity notes (data that does not reach this TUI yet — reported, not faked):
 *   - `display.show_cost`: Ink reads it from its `config.get` polling loop,
 *     which this TUI doesn't have — cost shows whenever `usage.cost_usd` is
 *     present instead.
 *
 * Read-only chrome — the only input handled is Esc-to-dismiss for the notice.
 */
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'

import type { SessionStore } from '../logic/store.ts'
import { truncLeft, truncRight } from '../logic/truncate.ts'
import { isTrayAgent } from './agentsTray.tsx'
import { useDimensions } from './dimensions.tsx'
import { elapsedSeconds, useElapsedTick } from './elapsed.ts'
import { useTheme } from './theme.tsx'

const HOME = process.env.HOME ?? ''
const SEP = ' │ '
const DOT_SEP = ' · '
/** Horizontal cells the bar's row loses to chrome: the app shell's padding (2)
 *  + this box's own padding (2). */
const ROW_PADDING = 4
/** Minimum useful cwd budget — below this the cwd drops instead of squeezing. */
const CWD_MIN = 10
/** How long the transient update notice may borrow the bar line. */
const NOTICE_TTL_MS = 30_000

// ── pure, table-tested width/threshold logic ────────────────────────────

/** Which tail segments are visible at a given column count. Drop order as the
 *  terminal narrows (reverse priority): mcp → bg → profile → cmp → up →
 *  cost → ctxDetail (the bar+token read-out collapses to a bare `ctx: 42%`).
 *  Dot+model and the ctx % are pinned and never gated here; the cwd is gated
 *  by its own leftover-width budget instead. */
export interface StatusSegments {
  /** Running-subagents `⚡ N` chip — survives narrowest (drops last). */
  agents: boolean
  /** Full `ctx: ███░░ 42% · 84k` read-out; false → compact `ctx: 42%`. */
  ctxDetail: boolean
  cost: boolean
  /** Session uptime (`up: 23m`). */
  up: boolean
  compressions: boolean
  profile: boolean
  /** Running OS background-processes count (`bg: N`). */
  bg: boolean
  mcp: boolean
}

export function statusSegments(cols: number): StatusSegments {
  const w = Math.max(1, Math.floor(cols || 1))
  return {
    agents: w >= 60,
    ctxDetail: w >= 72,
    cost: w >= 80,
    up: w >= 88,
    compressions: w >= 94,
    profile: w >= 108,
    bg: w >= 118,
    mcp: w >= 126
  }
}

/** The context bar's cell count — the chrome's most important gauge, sized to
 *  breathe: 14 cells on wide terminals, 12 at normal widths, 10 when tight. */
export function ctxBarCells(cols: number): number {
  const w = Math.max(1, Math.floor(cols || 1))
  if (w >= 160) return 14
  if (w >= 100) return 12
  return 10
}

/** Context-pressure level for the bar/% colour (spec thresholds 50/80/95). */
export type CtxLevel = 'ok' | 'warn' | 'bad' | 'critical'
export function ctxLevel(pct: number): CtxLevel {
  if (pct >= 95) return 'critical'
  if (pct >= 80) return 'bad'
  if (pct >= 50) return 'warn'
  return 'ok'
}

/** Compression-count level (spec: warn ≥5, error ≥10). */
export type CmpLevel = 'ok' | 'warn' | 'bad'
export function cmpLevel(n: number): CmpLevel {
  if (n >= 10) return 'bad'
  if (n >= 5) return 'warn'
  return 'ok'
}

/** Compact token count: 84321 → `84k`, 1_250_000 → `1.3M`, 950 → `950`. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${Math.max(0, Math.round(n))}`
}

/** Compact session duration: 42 → `42s`, 23*60 → `23m`, 65*60 → `1h05m`. */
export function fmtShortDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

// ── local formatting helpers ────────────────────────────────────────────

/** `anthropic/claude-opus-4-8` → `claude-opus-4-8`; trims the provider prefix (Ink shortModelLabel). */
function shortModel(model: string): string {
  return model.includes('/') ? (model.split('/').at(-1) ?? model) : model
}

/** Reasoning effort → a compact suffix; hidden for the default/medium effort. */
function effortSuffix(effort: string | undefined, fast: boolean | undefined): string {
  const parts: string[] = []
  if (effort && effort !== 'medium' && effort !== 'default') parts.push(effort)
  if (fast) parts.push('fast')
  return parts.length ? ` ·${parts.join('·')}` : ''
}

/** Abbreviate cwd with `~` for $HOME, then collapse to the last two path segments
 *  (`…/lively-thrush/hermes-agent`) so deep worktree paths stay readable (Ink fmtCwdBranch). */
function shortCwd(cwd: string): string {
  const home = HOME && (cwd === HOME || cwd.startsWith(HOME + '/')) ? '~' + cwd.slice(HOME.length) : cwd
  const segs = home.split('/').filter(Boolean)
  return segs.length <= 3 ? home : '…/' + segs.slice(-2).join('/')
}

/** A unicode meter: `███░░` filled to `pct`% over `width` cells (Ink ctxBar). */
function ctxBar(pct: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function StatusBar(props: { store: SessionStore }) {
  const theme = useTheme()
  const dims = useDimensions()
  const info = () => props.store.state.info
  const tick = useElapsedTick()

  const ctxColorOf = (pct: number) => {
    const level = ctxLevel(pct)
    return level === 'critical'
      ? theme().color.statusCritical
      : level === 'bad'
        ? theme().color.statusBad
        : level === 'warn'
          ? theme().color.statusWarn
          : theme().color.statusGood
  }
  const cmpColorOf = (n: number) => {
    const level = cmpLevel(n)
    return level === 'bad' ? theme().color.error : level === 'warn' ? theme().color.warn : theme().color.muted
  }

  const dot = () => (info().running ? '◐' : props.store.state.ready ? '●' : '○')
  const dotColor = () =>
    info().running ? theme().color.statusWarn : props.store.state.ready ? theme().color.statusGood : theme().color.muted

  const segs = createMemo(() => statusSegments(dims().width))
  const barCells = createMemo(() => ctxBarCells(dims().width))

  // ── transient update notice (borrows the whole line; Esc / TTL dismisses) ──
  const [dismissed, setDismissed] = createSignal(false)
  const noticeText = createMemo(() => {
    const behind = info().updateBehind
    if (dismissed() || behind === undefined || behind <= 0) return ''
    const cmd = info().updateCommand
    const base = `↑ hermes is ${behind} commit${behind === 1 ? '' : 's'} behind`
    return `${base}${cmd ? ` — update: ${cmd}` : ''}${SEP}Esc to dismiss`
  })
  createEffect(() => {
    if (!noticeText()) return
    const timer = setTimeout(() => setDismissed(true), NOTICE_TTL_MS)
    onCleanup(() => clearTimeout(timer))
  })
  // Dismiss-only handler: never swallows Esc from overlays/composer (they keep
  // their own handlers); dismissing the notice alongside is benign.
  useKeyboard(key => {
    if (key.name === 'escape' && noticeText()) setDismissed(true)
  })

  // ── segment texts, in line order (each '' when hidden/absent — the plain
  //    string doubles as the width budget for the cwd tail) ──────────────
  const model = () => {
    const m = info().model
    return m ? shortModel(m) : ''
  }
  const effort = () => effortSuffix(info().effort, info().fast)
  const pct = () => info().contextPercent

  /** Plain text of the ctx segment (`ctx: ███░░ 42% · 84k` / `ctx: 42%`). */
  const ctxText = createMemo(() => {
    const p = pct()
    if (p === undefined) return ''
    if (!segs().ctxDetail) return `ctx: ${p}%`
    const used = info().contextUsed
    return `ctx: ${ctxBar(p, barCells())} ${p}%${used !== undefined ? `${DOT_SEP}${fmtTokens(used)}` : ''}`
  })

  const costText = createMemo(() => {
    const c = info().costUsd
    return segs().cost && c !== undefined ? `cost: $${c.toFixed(2)}` : ''
  })
  const upText = createMemo(() => {
    const started = info().startedAt
    if (!segs().up || !started || !model()) return ''
    tick() // re-derive once per second while shown
    return `up: ${fmtShortDuration(elapsedSeconds(started))}`
  })
  const cmpCount = () => info().compressions ?? 0
  const cmpText = createMemo(() => (segs().compressions && cmpCount() > 0 ? `cmp: ${cmpCount()}` : ''))
  const profileText = createMemo(() => {
    const p = info().profileName
    return segs().profile && p && p !== 'default' && p !== 'custom' ? p : ''
  })
  const mcpText = createMemo(() => {
    const n = info().mcpServers ?? 0
    return segs().mcp && n > 0 ? `mcp: ${n}` : ''
  })
  // `bg: N` — in-flight background-PROMPT tasks (`/bg` → prompt.background,
  // cleared on background.complete), mirroring Ink's bgTasks count.
  const bgText = createMemo(() => {
    const n = props.store.state.bgTasks.length
    return segs().bg && n > 0 ? `bg: ${n}` : ''
  })
  // `⚡ N` — running subagents. The ambient count lives HERE now (P4 input-density
  // fold): the agents tray no longer keeps a persistent collapsed line under the
  // composer — Down still expands it; this chip is the at-a-glance signal.
  const agentsText = createMemo(() => {
    const n = props.store.state.subagents.filter(isTrayAgent).length
    return segs().agents && n > 0 ? `⚡ ${n}` : ''
  })
  // Count of background/async delegations still running (`delegate_task(background=true)`,
  // from `usage.active_subagents` ← async_delegation.active_count()). NOTE: these also
  // appear in the `⚡ N` tray above while they emit `subagent.*` events, so we do NOT
  // render a separate count chip (it would double-count). We use this registry-backed
  // count only to drive the idle resume-hint below — the one signal `⚡` can't give,
  // because SubagentInfo carries no foreground/background flag (a foreground subagent
  // blocks the turn and can never be "resuming").
  const subagentCount = () => info().activeSubagents ?? 0
  // `☑ done/total` — the at-a-glance todo signal. The full live list is the
  // pinned TodoPanel above the composer; this chip persists even when the panel
  // auto-hides (no active work), so progress is never lost from view. It's tiny
  // (~6 cols) so it shows at ANY width (unlike the agents chip) — the chip is
  // the narrow-terminal fallback for the panel. Cleared when no snapshot exists.
  const todoText = createMemo(() => {
    const snap = props.store.state.latestTodos
    if (!snap || snap.counts.total === 0) return ''
    return `☑ ${snap.counts.completed}/${snap.counts.total}`
  })
  // Length of the left run WITHOUT the verbose resume hint and WITHOUT the cwd —
  // the fixed-ish segments. Used both to width-budget the resume hint (so it only
  // appears when it genuinely fits) and as the base for leftLen below.
  const baseLeftLen = createMemo(() => {
    let len = 1 // dot
    if (model()) len += 1 + model().length + effort().length
    for (const seg of [
      agentsText(),
      todoText(),
      ctxText(),
      costText(),
      upText(),
      cmpText(),
      profileText(),
      bgText(),
      mcpText()
    ]) {
      if (seg) len += SEP.length + seg.length
    }
    return len
  })
  // `↩ resumes when subagent finishes` — parked-background reassurance. When the
  // turn is IDLE (not running) but a background delegation is still in flight, the
  // result will re-enter on its own as a fresh turn — nothing to poll, no spinner.
  // Lowest-priority verbose segment: it's WIDTH-BUDGETED on the ACTUAL remaining
  // space (not a fixed column gate), so it only appears when the whole bar — incl.
  // mcp and a minimum cwd allowance — still fits on ONE line. A fixed gate was
  // brittle: the hint's width varies with the count's digits + which segments are
  // present, so a gate tuned for one content width wrapped the bar at another.
  const resumeHintText = createMemo(() => {
    const n = subagentCount()
    if (info().running || n <= 0) return ''
    const text = n === 1 ? '↩ resumes when subagent finishes' : `↩ resumes when ${n} subagents finish`
    // Reserve room for the leading run + this segment's ` │ ` + a minimal cwd.
    const need = baseLeftLen() + SEP.length + text.length + SEP.length + CWD_MIN
    return need <= dims().width - ROW_PADDING ? text : ''
  })

  // The cwd flows LAST on the same line (not right-pinned): its budget is the
  // row width minus every segment before it; it tail-truncates into that, and
  // drops whole below CWD_MIN.
  const leftLen = createMemo(() => {
    let len = baseLeftLen()
    if (resumeHintText()) len += SEP.length + resumeHintText().length
    return len
  })
  // The cwd is RIGHT-PINNED on its own (F10 — glitch 2026-06-13): left-aligning
  // it with everything else forced its head to truncate (`…/hermes-agent/ui-…`)
  // and stranded empty space at the right edge. Pinned right with a flex spacer,
  // the dirname + branch hug the edge and only the head clips (truncLeft). Its
  // budget is the row width minus the left run; it drops whole below CWD_MIN.
  const cwdText = createMemo(() => {
    const cwd = info().cwd
    const c = cwd ? shortCwd(cwd) : ''
    if (!c) return ''
    const full = info().branch ? `${c} (${info().branch})` : c
    const budget = dims().width - ROW_PADDING - leftLen() - SEP.length
    return budget >= CWD_MIN ? truncLeft(full, budget) : ''
  })

  /** A muted label + value span pair (`cost: $0.41`) with its leading ` │ `. */
  const Seg = (p: { text: string; fg?: string }) => (
    <Show when={p.text}>
      <span style={{ fg: theme().color.border }}>{SEP}</span>
      <span style={{ fg: p.fg ?? theme().color.muted }}>{p.text}</span>
    </Show>
  )

  return (
    <box
      style={{
        flexShrink: 0,
        flexDirection: 'row',
        backgroundColor: theme().color.statusBg,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <Show
        when={!noticeText()}
        fallback={
          // the update notice borrows the WHOLE line — warn-tinted,
          // head-truncated so the Esc hint clips last only on absurd widths.
          <text selectable={false}>
            <span style={{ fg: theme().color.warn }}>
              {truncRight(noticeText(), Math.max(1, dims().width - ROW_PADDING))}
            </span>
          </text>
        }
      >
        {/* ONE left-flowing text run: dot+model, then the labeled segments in
            priority order, the (pre-truncated) cwd last. No spacers, no pinning. */}
        <text selectable={false}>
          <span style={{ fg: dotColor() }}>{dot()}</span>
          <Show when={model()}>
            <span style={{ fg: theme().color.statusFg }}>{` ${model()}`}</span>
            <span style={{ fg: theme().color.muted }}>{effort()}</span>
          </Show>
          <Seg text={agentsText()} fg={theme().color.accent} />
          <Seg text={todoText()} fg={theme().color.statusGood} />
          <Show when={ctxText()}>
            <span style={{ fg: theme().color.border }}>{SEP}</span>
            <span style={{ fg: theme().color.muted }}>{'ctx: '}</span>
            {/* ctxText() truthy guarantees pct() is defined; `?? 0` only satisfies the type. */}
            <Show when={segs().ctxDetail} fallback={<span style={{ fg: ctxColorOf(pct() ?? 0) }}>{`${pct()}%`}</span>}>
              <span style={{ fg: ctxColorOf(pct() ?? 0) }}>{ctxBar(pct() ?? 0, barCells())}</span>
              <span style={{ fg: theme().color.statusFg }}>{` ${pct()}%`}</span>
              <Show when={info().contextUsed !== undefined}>
                <span style={{ fg: theme().color.muted }}>{`${DOT_SEP}${fmtTokens(info().contextUsed ?? 0)}`}</span>
              </Show>
            </Show>
          </Show>
          <Seg text={costText()} />
          <Seg text={upText()} />
          <Seg text={cmpText()} fg={cmpColorOf(cmpCount())} />
          {/* statusFg, not accent — persistent chrome spends no warm ink
              (design pass); the navy fill is the bar's one blue surface. */}
          <Seg text={profileText()} fg={theme().color.statusFg} />
          <Seg text={bgText()} fg={theme().color.statusWarn} />
          <Seg text={resumeHintText()} />
          <Seg text={mcpText()} />
        </text>
        {/* the cwd is RIGHT-PINNED (F10): a flex spacer eats the slack so the
            dirname + branch hug the right edge instead of stranding empty navy. */}
        <Show when={cwdText()}>
          <box style={{ flexGrow: 1 }} />
          <text selectable={false}>
            <span style={{ fg: theme().color.muted }}>{cwdText()}</span>
          </text>
        </Show>
      </Show>
    </box>
  )
}
