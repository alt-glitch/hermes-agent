/**
 * StatusBar — the session chrome above the composer. ONE left-aligned line at
 * EVERY width (status chrome v3 — user feedback: "everything left-aligned,
 * all on one line, no random scatter"):
 *
 *   🔋 82% │ ● model ·effort │ ctx: ██████░░░░░░ 42% · 84k │ cost: $0.41 │ up: 23m │ cmp: 2 │ profile │ mcp: 2 │ project · …/cwd (branch)
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
 *     ctx detail collapsing to a bare `ctx: 42%`, then the `⛓ agents` chip) via
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
 * Background-activity chrome: `⛓ N` = active background delegations
 * (registry-backed `usage.active_subagents` when present, including
 * authoritative zero; local live rows are the compatibility fallback),
 * `bg: N` = in-flight background PROMPTS (`/bg` → prompt.background, cleared
 * on background.complete). Both hide at zero. (OS background processes live
 * in the /processes panel.)
 * While the main turn is idle, registry-backed background work also gets the
 * longest whole `↩ resumes…` reassurance that fits the actual remaining row.
 * The separate spawn HUD (`dD/C ⚡W/C+N`) summarizes the live turn tree and
 * delegation-cap pressure, matching Ink rather than conflating the two counts.
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

import { delegationPressure, idleSubagentResumeStatus, type DelegationState } from '../logic/agentStatus.ts'
import { batteryLabel, type BatteryCategory } from '../logic/battery.ts'
import type { SessionStore, SubagentInfo } from '../logic/store.ts'
import { buildSubagentTree, treeTotals, widthByDepth } from '../logic/subagentTree.ts'
import { truncLeft, truncRight } from '../logic/truncate.ts'
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
  /** Active-background-delegations `⛓ N` chip — survives narrowest (drops last). */
  agents: boolean
  /** Full `ctx: ███░░ 42% · 84k` read-out; false → compact `ctx: 42%`. */
  ctxDetail: boolean
  cost: boolean
  /** Voice mode / REC / STT chrome (exact-f7 breakpoint). */
  voice: boolean
  /** Session uptime (`up: 23m`). */
  up: boolean
  compressions: boolean
  /** Process-global attachable TUI sessions (`N sessions`). */
  sessions: boolean
  profile: boolean
  /** Connected browser-agent badge. */
  browser: boolean
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
    voice: w >= 84,
    up: w >= 88,
    compressions: w >= 94,
    sessions: w >= 100,
    profile: w >= 108,
    browser: w >= 112,
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

export type SpawnHudTone = 'error' | 'muted' | 'warn'

export interface SpawnHudModel {
  readonly text: string
  readonly tone: SpawnHudTone
}

/** Exact compact Ink SpawnHud semantics, kept pure for table tests. The HUD
 * describes the live turn tree; it is deliberately separate from the
 * registry-backed `active_subagents` count shown by the `⛓ N` chip. */
export function spawnHudModel(subagents: readonly SubagentInfo[], delegation: DelegationState): SpawnHudModel {
  const tree = buildSubagentTree(subagents)
  const totals = treeTotals(tree)
  if (totals.descendantCount === 0 && !delegation.paused) return { text: '', tone: 'muted' }

  const depth = Math.max(0, totals.maxDepthFromHere)
  const widestLevel = widthByDepth(tree).reduce((widest, level) => Math.max(widest, level), 0)
  const pressure = delegationPressure(delegation, {
    activeCount: totals.activeCount,
    depth,
    widestLevel
  })
  const pieces: string[] = []

  if (delegation.paused) pieces.push('⏸ paused')
  if (totals.descendantCount > 0) {
    const depthLabel = delegation.maxSpawnDepth === null ? `${depth}` : `${depth}/${delegation.maxSpawnDepth}`
    pieces.push(`d${depthLabel}`)

    if (totals.activeCount > 0) {
      const widthLabel =
        delegation.maxConcurrentChildren === null
          ? `${widestLevel}`
          : `${widestLevel}/${delegation.maxConcurrentChildren}`
      const extra = Math.max(0, totals.activeCount - widestLevel)
      pieces.push(`⚡${widthLabel}${extra > 0 ? `+${extra}` : ''}`)
    }
  }

  const tone: SpawnHudTone = pressure.level === 'error' ? 'error' : pressure.level === 'warn' ? 'warn' : 'muted'
  return { text: `${pressure.atCap ? '⚠ ' : ''}${pieces.join(' ')}`, tone }
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

/** Reasoning effort → a compact suffix; hidden only when unset/default. */
export function effortSuffix(effort: string | undefined, fast: boolean | undefined): string {
  const parts: string[] = []
  if (effort && effort !== 'default') parts.push(effort)
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

export function StatusBar(props: { store: SessionStore; subagentsVisible?: boolean }) {
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
  const batteryColorOf = (category: BatteryCategory) =>
    category === 'good'
      ? theme().color.statusGood
      : category === 'warn'
        ? theme().color.statusWarn
        : category === 'bad'
          ? theme().color.statusBad
          : category === 'critical'
            ? theme().color.statusCritical
            : theme().color.muted

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
  const voiceText = createMemo(() => {
    if (!segs().voice) return ''
    const voice = props.store.state.voice
    if (voice.recording) return '● REC'
    if (voice.processing) return '◉ STT'
    // The idle/off label is much less urgent than active REC/STT. Ink's final
    // fit check drops it when the already-populated tail cannot afford it;
    // OpenTUI's fixed ladder models that same outcome at normal widths.
    if (!voice.enabled && dims().width < 140) return ''
    return `voice ${voice.enabled ? 'on' : 'off'}${voice.tts ? ' [tts]' : ''}`
  })
  const voiceColor = () =>
    props.store.state.voice.recording
      ? theme().color.error
      : props.store.state.voice.processing
        ? theme().color.warn
        : theme().color.muted
  const browserText = createMemo(() => (segs().browser && props.store.state.browser.connected ? 'browser' : ''))
  const profileText = createMemo(() => {
    const p = info().profileName
    return segs().profile && p && p !== 'default' && p !== 'custom' ? p : ''
  })
  const mcpText = createMemo(() => {
    // The home catalog contains enabled MCP server names (disabled config
    // entries are filtered by the gateway). Keep the connected-only session
    // count as a compatibility fallback for older gateways or a catalog that
    // has not arrived yet.
    const n = props.store.state.catalog?.mcp.servers.length ?? info().mcpServers ?? 0
    return segs().mcp && n > 0 ? `mcp: ${n}` : ''
  })
  // `bg: N` — in-flight background-PROMPT tasks (`/bg` → prompt.background,
  // cleared on background.complete), mirroring Ink's bgTasks count.
  const bgText = createMemo(() => {
    const n = props.store.state.bgTasks.length
    return segs().bg && n > 0 ? `bg: ${n}` : ''
  })
  const sessionsText = createMemo(() => {
    const count = props.store.state.liveSessionCount
    return segs().sessions && count > 0 ? `${String(count)} ${count === 1 ? 'session' : 'sessions'}` : ''
  })
  // `⛓ N` — active background delegations. The registry-backed usage count
  // wins whenever present, including explicit zero; local live rows support
  // older gateways.
  // The tray no longer keeps a persistent collapsed line under the composer —
  // Down still expands it; this chip is the at-a-glance signal.
  const activeSubagents = createMemo(() =>
    props.subagentsVisible === false ? { count: 0, source: 'local' as const } : props.store.activeSubagentCount()
  )
  const agentsText = createMemo(() => {
    const n = activeSubagents().count
    return segs().agents && n > 0 ? `⛓ ${n}` : ''
  })
  const spawnHud = createMemo(() =>
    props.subagentsVisible === false
      ? { text: '', tone: 'muted' as const }
      : spawnHudModel(props.store.state.subagents, props.store.state.delegation)
  )
  const spawnHudColor = () => {
    const tone = spawnHud().tone
    return tone === 'error' ? theme().color.error : tone === 'warn' ? theme().color.warn : theme().color.muted
  }
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
  const batteryText = createMemo(() => {
    const reading = props.store.state.batteryStatus
    return props.store.state.batteryEnabled && reading?.available ? batteryLabel(reading) : ''
  })
  const batteryColor = () => {
    const reading = props.store.state.batteryStatus
    return reading ? batteryColorOf(reading.category) : theme().color.muted
  }

  // Fixed/higher-priority left run. The parked-subagent reassurance is
  // variable-width, so it budgets against this real length instead of gaining
  // a brittle fixed-column breakpoint.
  const baseLeftLen = createMemo(() => {
    let len = 1 // dot
    if (batteryText()) len += batteryText().length + SEP.length
    if (model()) len += 1 + model().length + effort().length
    for (const seg of [
      agentsText(),
      todoText(),
      ctxText(),
      costText(),
      upText(),
      cmpText(),
      voiceText(),
      sessionsText(),
      profileText(),
      browserText(),
      bgText(),
      mcpText(),
      spawnHud().text
    ]) {
      if (seg) len += SEP.length + seg.length
    }
    return len
  })
  const resumeHintText = createMemo(() => {
    const active = activeSubagents()
    // Only the registry-backed count can promise an automatic future resume;
    // local rows are a compatibility signal, not proof of parked background work.
    const count = active.source === 'usage' ? active.count : 0
    const cwdReserve = info().cwd ? SEP.length + CWD_MIN : 0
    const availableCells = dims().width - ROW_PADDING - baseLeftLen() - SEP.length - cwdReserve
    return idleSubagentResumeStatus({
      availableCells,
      count,
      running: info().running === true
    }).text
  })
  const leftLen = createMemo(() =>
    resumeHintText() ? baseLeftLen() + SEP.length + resumeHintText().length : baseLeftLen()
  )
  // The cwd is RIGHT-PINNED on its own (F10 — glitch 2026-06-13): left-aligning
  // it with everything else forced its head to truncate (`…/hermes-agent/ui-…`)
  // and stranded empty space at the right edge. Pinned right with a flex spacer,
  // the dirname + branch hug the edge and only the head clips (truncLeft). Its
  // budget is the row width minus the left run; it drops whole below CWD_MIN.
  const cwdText = createMemo(() => {
    const cwd = info().cwd
    const c = cwd ? shortCwd(cwd) : ''
    if (!c) return ''
    const cwdBranch = info().branch ? `${c} (${info().branch})` : c
    const project = info().projectName?.trim() ?? ''
    const budget = dims().width - ROW_PADDING - leftLen() - SEP.length
    if (budget < CWD_MIN) return ''
    if (!project) return truncLeft(cwdBranch, budget)
    const projectLabel = truncRight(project, budget)
    const remainder = budget - projectLabel.length - DOT_SEP.length
    return remainder < CWD_MIN ? projectLabel : `${projectLabel}${DOT_SEP}${truncLeft(cwdBranch, remainder)}`
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
        <text selectable={false} wrapMode="none">
          <Show when={batteryText()}>
            <span style={{ fg: batteryColor() }}>{batteryText()}</span>
            <span style={{ fg: theme().color.border }}>{SEP}</span>
          </Show>
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
          <Seg text={voiceText()} fg={voiceColor()} />
          <Seg text={sessionsText()} fg={theme().color.accent} />
          {/* statusFg, not accent — persistent chrome spends no warm ink
              (design pass); the navy fill is the bar's one blue surface. */}
          <Seg text={profileText()} fg={theme().color.statusFg} />
          <Seg text={browserText()} fg={theme().color.accent} />
          <Seg text={bgText()} fg={theme().color.statusWarn} />
          <Seg text={mcpText()} />
          <Seg text={resumeHintText()} />
          {/* Always-on when a live tree exists (or delegation is paused),
              after the width-gated tail segments just like Ink's SpawnHud. */}
          <Seg text={spawnHud().text} fg={spawnHudColor()} />
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
