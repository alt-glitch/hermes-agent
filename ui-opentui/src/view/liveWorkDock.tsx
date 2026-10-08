/**
 * Live-work dock rows (Ink `goalBar.tsx`, `agentsPanel.tsx` process block,
 * `agentsOverlay.tsx` ProcessesSection):
 *
 *   - GoalRow: one `⊙ goal · 3/20 turns · <title>` row while a /goal stands.
 *   - ProcessesTray: the session's background processes docked with the
 *     agents tray. Processes alone surface it; a finished process keeps its
 *     exit verdict for PROCESS_RETAIN_SECONDS after `exited_at`, then leaves.
 *   - ProcessesSection: the same rows, unbounded, inside the /agents overlay.
 *
 * Rows derive from the raw `process.list` snapshot against the shared 1s tick,
 * subscribed only while the block is mounted (non-empty snapshot).
 */
import { createMemo, For, Show } from 'solid-js'

import type { ProcessEntry } from '../boundary/schema/ProcessResponses.ts'
import type { GoalSnapshot } from '../boundary/schema/SessionControl.ts'
import { goalLine } from '../logic/goalStatus.ts'
import {
  buildProcessRows,
  PROCESS_GLYPH,
  processActivity,
  processSummary,
  type ProcessRow,
  type ProcessRowStatus
} from '../logic/processRoster.ts'
import { truncRight } from '../logic/truncate.ts'
import { useDimensions } from './dimensions.tsx'
import { useElapsedTick } from './elapsed.ts'
import { useTheme } from './theme.tsx'

type ThemeAccessor = ReturnType<typeof useTheme>

function processColor(status: ProcessRowStatus, theme: ThemeAccessor): string {
  const c = theme().color
  switch (status) {
    case 'running':
      return c.accent
    case 'done':
      return c.statusGood
    case 'failed':
      return c.error
    case 'killed':
      return c.warn
    case 'lost':
      return c.muted
  }
}

/** The standing goal row; renders nothing without an active/paused goal. */
export function GoalRow(props: { goal: GoalSnapshot | null }) {
  const theme = useTheme()
  const dims = useDimensions()
  const line = createMemo(() => goalLine(props.goal))
  return (
    <Show when={line()}>
      {l => (
        <box id="goal-row" height={1} flexShrink={0} style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text selectable={false} wrapMode="none">
            <span style={{ fg: l().glyph === '⊙' ? theme().color.accent : theme().color.warn }}>
              {`${l().glyph} ${l().label}`}
            </span>
            <span style={{ fg: theme().color.muted }}>{` · ${l().detail} · `}</span>
            <span style={{ fg: theme().color.text }}>
              {truncRight(
                l().title.replace(/\s+/g, ' ').trim(),
                Math.max(8, dims().width - `${l().glyph} ${l().label} · ${l().detail} · `.length - 4)
              )}
            </span>
          </text>
        </box>
      )}
    </Show>
  )
}

/** One `⚙ command · 42s · last: …` line; the verdict replaces activity once exited. */
function ProcessRowLine(props: { row: ProcessRow; width: number }) {
  const theme = useTheme()
  const activity = () => processActivity(props.row)
  return (
    <text id={`process-row-${props.row.id}`} height={1} flexShrink={0} selectable={false} wrapMode="none">
      <span style={{ fg: processColor(props.row.status, theme) }}>{`${PROCESS_GLYPH[props.row.status]} `}</span>
      <span style={{ fg: theme().color.text }}>
        {truncRight(props.row.command, Math.max(8, props.width - activity().length - 6))}
      </span>
      <span style={{ fg: theme().color.muted }}>{` · ${activity()}`}</span>
    </text>
  )
}

/** Rows against the shared tick; call only inside a scope mounted while processes exist. */
function useProcessRows(processes: () => readonly ProcessEntry[]) {
  const tick = useElapsedTick()
  return createMemo(() => (tick(), buildProcessRows(processes(), Date.now())))
}

const COMPACT_PROCESS_LIMIT = 4

function ProcessesTrayRows(props: { processes: readonly ProcessEntry[]; collapsed: boolean }) {
  const theme = useTheme()
  const dims = useDimensions()
  const rows = useProcessRows(() => props.processes)
  const visible = () => rows().slice(0, COMPACT_PROCESS_LIMIT)
  const hidden = () => Math.max(0, rows().length - COMPACT_PROCESS_LIMIT)
  return (
    <Show when={rows().length > 0}>
      <box
        id="processes-tray"
        flexShrink={0}
        style={{
          backgroundColor: theme().color.completionBg,
          flexDirection: 'column',
          paddingLeft: 1,
          paddingRight: 1
        }}
      >
        <text selectable={false} wrapMode="none">
          <span style={{ fg: theme().color.accent }}>
            <b>{`${props.collapsed ? '▸' : '▾'} Processes · ${processSummary(rows())}`}</b>
          </span>
          <span style={{ fg: theme().color.muted }}>
            {`${hidden() && !props.collapsed ? ` · +${hidden()} more` : ''}  ·  /agents inspect · /stop end all`}
          </span>
        </text>
        <For each={props.collapsed ? [] : visible()}>
          {row => <ProcessRowLine row={row} width={dims().width - 4} />}
        </For>
      </box>
    </Show>
  )
}

/** Dock block beside the agents tray; mounts nothing (and no tick) with no processes. */
export function ProcessesTray(props: { processes: readonly ProcessEntry[]; collapsed?: boolean }) {
  return (
    <Show when={props.processes.length > 0}>
      <ProcessesTrayRows processes={props.processes} collapsed={props.collapsed === true} />
    </Show>
  )
}

function ProcessesSectionRows(props: { processes: readonly ProcessEntry[]; width: number }) {
  const theme = useTheme()
  const rows = useProcessRows(() => props.processes)
  return (
    <Show when={rows().length > 0}>
      <box id="agents-processes" flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text height={1} flexShrink={0} selectable={false} wrapMode="none" fg={theme().color.accent}>
          <b>{`Processes · ${processSummary(rows())}`}</b>
        </text>
        <For each={rows()}>{row => <ProcessRowLine row={row} width={props.width} />}</For>
      </box>
    </Show>
  )
}

/** The /agents overlay's Processes section (not part of the cursor roster; `/stop` ends them all). */
export function ProcessesSection(props: { processes: readonly ProcessEntry[]; width: number }) {
  return (
    <Show when={props.processes.length > 0}>
      <ProcessesSectionRows processes={props.processes} width={props.width} />
    </Show>
  )
}
