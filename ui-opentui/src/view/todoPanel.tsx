/**
 * TodoPanel — the pinned, live-updating task panel above the composer.
 *
 * Panel-primary todo UX (the in-transcript `todo` tool call collapses to a
 * one-line summary; this panel is the live tracker). Pinned in the chrome box
 * (App.tsx), so it sits OUTSIDE the windowed transcript scrollbox — always
 * mounted, never a spacer. Reads the O(1) `state.latestTodos` snapshot.
 *
 * Behaviour (locked design):
 *  - Header: counts only — "10 tasks · 1 done, 1 in progress, 8 open".
 *  - Rows: active items in parent-before-child DFS order, capped at MAX_ROWS;
 *    completed and cancelled collapse into the header count + overflow tail.
 *  - Overflow: "… +4 pending, 2 completed".
 *  - Auto-hide when there is no ACTIVE work (no pending/in_progress) — and the
 *    store auto-clears the snapshot once a session resets — so a finished plan
 *    steals zero screen. A glance-able count lives in the status-bar chip.
 *
 * Precedent: NoticeBanner / AgentsTray (flexShrink:0, <Show>-gated, width-budgeted).
 */
import { createMemo, For, Show } from 'solid-js'

import { todoTree, type TodoItem, type TodoSnapshot } from '../logic/store.ts'
import { truncRight } from '../logic/truncate.ts'
import { useDimensions } from './dimensions.tsx'
import { useTheme } from './theme.tsx'

/** Max checklist rows shown before overflow collapse (Claude-Code-ish ~5). */
const MAX_ROWS = 5

function glyph(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'in_progress':
      return '▣'
    case 'cancelled':
      return '✗'
    default:
      return '☐'
  }
}

/** Counts-only header: "N tasks · a done, b in progress, c open" (zero buckets dropped). */
export function headerText(snap: TodoSnapshot): string {
  const c = snap.counts
  const bits: string[] = []
  if (c.completed) bits.push(`${c.completed} done`)
  if (c.in_progress) bits.push(`${c.in_progress} in progress`)
  if (c.pending) bits.push(`${c.pending} open`)
  if (c.cancelled) bits.push(`${c.cancelled} cancelled`)
  const tail = bits.length ? ` · ${bits.join(', ')}` : ''
  return `${c.total} task${c.total === 1 ? '' : 's'}${tail}`
}

/** Active rows in parent-before-child DFS order. Completed/cancelled items are
 * counted in the header/overflow but do not consume pinned panel rows. */
export function visibleRows(snap: TodoSnapshot): Array<readonly [TodoItem, number]> {
  return todoTree(snap.todos)
    .filter(([todo]) => todo.status === 'in_progress' || todo.status === 'pending')
    .slice(0, MAX_ROWS)
}

/** True when there is active work worth pinning (any pending/in_progress). */
export function hasActiveWork(snap: TodoSnapshot | undefined): snap is TodoSnapshot {
  return !!snap && (snap.counts.pending > 0 || snap.counts.in_progress > 0)
}

/** Overflow tail: "… +N open, M done" for the rows/states not shown above. */
export function overflowText(snap: TodoSnapshot, shownActive: number): string {
  const c = snap.counts
  const activeTotal = c.pending + c.in_progress
  const hiddenActive = Math.max(0, activeTotal - shownActive)
  const done = c.completed
  const cancelled = c.cancelled
  const bits: string[] = []
  if (hiddenActive) bits.push(`${hiddenActive} more open`)
  if (done) bits.push(`${done} completed`)
  if (cancelled) bits.push(`${cancelled} cancelled`)
  return bits.length ? `… +${bits.join(', ')}` : ''
}

export function TodoPanel(props: { snapshot: TodoSnapshot | undefined }) {
  const theme = useTheme()
  const dims = useDimensions()
  const active = createMemo(() => (hasActiveWork(props.snapshot) ? props.snapshot : undefined))
  const colorFor = (status: TodoItem['status']): string => {
    const c = theme().color
    switch (status) {
      case 'completed':
        return c.ok
      case 'in_progress':
        return c.accent
      case 'cancelled':
        return c.muted
      default:
        return c.text
    }
  }
  const budget = () => Math.max(8, dims().width - 4)
  return (
    <Show when={active()}>
      {snap => {
        const rows = createMemo(() => visibleRows(snap()))
        const overflow = createMemo(() => overflowText(snap(), rows().length))
        return (
          <box style={{ flexShrink: 0, flexDirection: 'column', paddingLeft: 1 }}>
            {/* counts-only header (chrome, not selectable) */}
            <text selectable={false}>
              <span style={{ fg: theme().color.label }}>{truncRight(headerText(snap()), budget())}</span>
            </text>
            {/* active rows in DFS order, with nesting capped at four levels */}
            <For each={rows()}>
              {([item, depth]) => {
                const indent = ' '.repeat(Math.min(depth, 4) * 2)
                return (
                  <text selectable={false}>
                    <span>{indent}</span>
                    <span style={{ fg: colorFor(item.status) }}>{glyph(item.status)} </span>
                    <span
                      style={{
                        fg: item.status === 'in_progress' ? theme().color.text : theme().color.muted,
                        bold: item.status === 'in_progress'
                      }}
                    >
                      {truncRight(item.content, Math.max(1, budget() - indent.length - 2))}
                    </span>
                  </text>
                )
              }}
            </For>
            {/* overflow tail — the rows/states not shown above */}
            <Show when={overflow()}>
              <text selectable={false}>
                <span style={{ fg: theme().color.muted }}>{truncRight(overflow(), budget())}</span>
              </text>
            </Show>
          </box>
        )
      }}
    </Show>
  )
}
