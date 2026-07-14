/**
 * AgentsTray — the background-agents tray docked below the composer (Epic 2.7).
 *
 * Compact (unfocused): a bounded, at-a-glance list of ACTIVE subagents
 * (canonical `running` or `queued`) showing model + goal. Expanded (focused):
 * one row per active subagent showing status · goal · elapsed-ish · last
 * activity line, with a themed highlight on the selection.
 *
 * Focus routing (the hard part): the tray takes NATIVE focus (its root box is
 * focusable) — `focusRenderable` blurs the composer textarea for us, and
 * focusing the textarea back blurs the box, whose BLURRED event is the single
 * collapse trigger. The composer hands focus over via `onFocusDown` (Down on an
 * EMPTY composer, no dropdown — see composer.tsx); while the tray is focused:
 *   - Up/Down move the selection (composer's history handler is gated on the
 *     textarea being focused, so it stays out of the way);
 *   - Enter opens the agents dashboard preselected on the row (the dashboard
 *     replaces the input zone, unmounting the tray → destroy → blur → collapse);
 *   - Esc returns focus to the composer (`onExit` → the composer's focus());
 *   - a printable key is NOT handled here — the composer's reclaim rule focuses
 *     the textarea and inserts the char, and the resulting blur collapses us.
 * The `defaultPrevented` guard keeps the very Down that focused the tray (the
 * composer preventDefaults it) from also moving the selection.
 */
import { RenderableEvents, type BoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'

import type { SubagentInfo } from '../logic/store.ts'
import { isRunning, normalizeSubagentStatus } from '../logic/subagentTree.ts'
import { elapsedSeconds, useElapsedTick } from './elapsed.ts'
import { useTheme } from './theme.tsx'

/** What the App binds to hand the tray keyboard focus (composer Down). */
export interface AgentsTrayApi {
  /** Try to take focus; false when ineligible (no running agents / not mounted). */
  focusTray: () => boolean
}

/** Tray membership follows the canonical spawn-tree status domain. Legacy
 * aliases normalize there; terminal and unknown values stay out. */
export function isTrayAgent(sa: SubagentInfo): boolean {
  return isRunning(sa)
}

/** `m:ss` for the row's elapsed-ish counter. */
function fmtElapsed(secs: number): string {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/** Keep a row's activity tail to one line's worth. */
function truncate(s: string, max = 48): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Provider prefixes are useful in configuration, noisy in a narrow live tray. */
function shortModel(model?: string): string {
  if (!model) return 'agent'
  return model.split('/').at(-1) || model
}

function statusColor(status: string, theme: ReturnType<typeof useTheme>): string {
  const c = theme().color
  switch (normalizeSubagentStatus(status)) {
    case 'running':
      return c.accent
    case 'queued':
      return c.muted
    case 'completed':
      return c.statusGood
    case 'interrupted':
    case 'timeout':
      return c.warn
    case 'error':
    case 'failed':
      return c.error
  }
}

export function AgentsTray(props: {
  subagents: SubagentInfo[]
  /** Enter on a row — open that agent in the dashboard. */
  onOpen: (id: string) => void
  /** Esc (or the tray emptying while focused) — give focus back to the composer. */
  onExit?: (() => void) | undefined
  /** Receives the focus-handoff API once (the App wires it to the composer's Down). */
  bind?: ((api: AgentsTrayApi) => void) | undefined
}) {
  const running = createMemo(() => props.subagents.filter(isTrayAgent))
  const [focused, setFocused] = createSignal(false)
  const [sel, setSel] = createSignal(0)
  // Clamp against a shrinking list (an agent above the selection completing).
  const selected = () => Math.min(sel(), Math.max(0, running().length - 1))
  let boxRef: BoxRenderable | undefined

  // First-seen wall clock per agent id — the subagent stream carries no start
  // timestamp, so "elapsed-ish" is time since the tray first saw the agent.
  // Non-reactive Map; rows repaint via the shared 1s tick while expanded.
  const firstSeen = new Map<string, number>()
  createEffect(() => {
    for (const sa of running()) if (!firstSeen.has(sa.id)) firstSeen.set(sa.id, Date.now())
  })

  const attach = (el: BoxRenderable) => {
    boxRef = el
    // The single collapse trigger: native focus left the box (printable-key
    // reclaim by the composer, an overlay opening, or unmount-destroy).
    el.on(RenderableEvents.BLURRED, () => setFocused(false))
  }

  props.bind?.({
    focusTray: () => {
      if (running().length === 0 || !boxRef) return false
      setSel(0)
      setFocused(true)
      boxRef.focus()
      return true
    }
  })

  // The last running agent finished while the tray was focused: the box is about
  // to unmount — hand focus back to the composer instead of leaving it nowhere.
  createEffect(() => {
    if (focused() && running().length === 0) {
      setFocused(false)
      props.onExit?.()
    }
  })

  useKeyboard(key => {
    // defaultPrevented: the Down that HANDED us focus was consumed by the composer.
    if (!focused() || key.defaultPrevented) return
    if (key.name === 'up') {
      setSel(Math.max(0, selected() - 1))
      key.preventDefault()
    } else if (key.name === 'down') {
      setSel(Math.min(running().length - 1, selected() + 1))
      key.preventDefault()
    } else if (key.name === 'return') {
      const sa = running()[selected()]
      if (sa) props.onOpen(sa.id) // dashboard replaces the input zone → unmount → blur → collapse
      key.preventDefault()
    } else if (key.name === 'escape') {
      boxRef?.blur()
      setFocused(false)
      props.onExit?.()
      // A tray-exit Esc is CONSUMED — without this, a composer remount can
      // register its handler after ours and the same keystroke would arm the
      // Esc+Esc prompt-history double-press (Epic 5 review caveat).
      key.preventDefault()
    }
  })

  // The compact list is intentionally capped: it makes background work visible
  // without letting a wide fan-out consume the transcript. Composer-Down hands
  // focus to the same box and swaps in the existing full inspector rows.
  return (
    <Show when={running().length > 0}>
      <box ref={attach} focusable style={{ flexDirection: 'column', flexShrink: 0 }}>
        <Show when={focused()} fallback={<CompactTrayRows agents={running()} />}>
          <TrayRows agents={running()} selected={selected()} firstSeen={firstSeen} />
        </Show>
      </box>
    </Show>
  )
}

const COMPACT_AGENT_LIMIT = 5

/** Persistent live summary. No synthetic `main` row: these are only agents the
 * gateway has authoritatively reported through the subagent event stream. */
function CompactTrayRows(props: { agents: SubagentInfo[] }) {
  const theme = useTheme()
  const visible = () => props.agents.slice(0, COMPACT_AGENT_LIMIT)
  const remaining = () => Math.max(0, props.agents.length - COMPACT_AGENT_LIMIT)
  return (
    <box
      style={{
        backgroundColor: theme().color.completionBg,
        flexDirection: 'column',
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <text selectable={false} wrapMode="none">
        <span style={{ fg: theme().color.accent }}>
          <b>{`◆ ${props.agents.length} agent${props.agents.length === 1 ? '' : 's'} active`}</b>
        </span>
        <span style={{ fg: theme().color.muted }}>{'  ·  ↓ inspect'}</span>
      </text>
      <For each={visible()}>
        {sa => {
          const status = () => normalizeSubagentStatus(sa.status)
          return (
            <text selectable={false} wrapMode="none">
              <span style={{ fg: statusColor(status(), theme) }}>{status() === 'queued' ? '○ ' : '● '}</span>
              <span style={{ fg: theme().color.muted }}>{`${truncate(shortModel(sa.model), 24)}  `}</span>
              <span style={{ fg: theme().color.label }}>{truncate(sa.goal || sa.id, 72)}</span>
            </text>
          )
        }}
      </For>
      <Show when={remaining() > 0}>
        <text selectable={false} fg={theme().color.muted} wrapMode="none">{`… +${remaining()} more`}</text>
      </Show>
    </box>
  )
}

/** The expanded rows — split out so the 1s elapsed tick is only subscribed while
 *  the tray is focused (the `<Show>` scope owns the subscription's onCleanup). */
function TrayRows(props: { agents: SubagentInfo[]; selected: number; firstSeen: Map<string, number> }) {
  const theme = useTheme()
  const tick = useElapsedTick()
  return (
    <box
      style={{
        backgroundColor: theme().color.completionBg,
        flexDirection: 'column',
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <For each={props.agents}>
        {(sa, i) => {
          const active = () => i() === props.selected
          const last = () => sa.trace?.at(-1)?.text ?? sa.thought
          const secs = () => (tick(), elapsedSeconds(props.firstSeen.get(sa.id) ?? Date.now()))
          const status = () => normalizeSubagentStatus(sa.status)
          return (
            <box
              style={{
                backgroundColor: active() ? theme().color.completionCurrentBg : theme().color.completionBg
              }}
            >
              <text selectable={false} wrapMode="none">
                <span style={{ fg: active() ? theme().color.accent : theme().color.muted }}>
                  {active() ? '▸ ' : '  '}
                </span>
                <span style={{ fg: statusColor(status(), theme) }}>{`● ${status()}`}</span>
                <span style={{ fg: active() ? theme().color.text : theme().color.label }}>{`  ${truncate(
                  sa.goal || sa.id,
                  72
                )}`}</span>
                <span style={{ fg: theme().color.muted }}>{`  · ${fmtElapsed(secs())}`}</span>
                <span style={{ fg: theme().color.muted }}>{last() ? `  ${truncate(last() ?? '')}` : ''}</span>
              </text>
            </box>
          )
        }}
      </For>
      <text selectable={false} fg={theme().color.muted}>
        ↑/↓ select · Enter inspect · Esc back
      </text>
    </box>
  )
}
