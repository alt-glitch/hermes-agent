/**
 * AgentsDashboard — the delegation/subagents view (spec §2b; Ink `agentsOverlay`,
 * item 15 "look into an agent trace live"). Master-detail:
 *   - top: the subagents tracked from the `subagent.*` stream, indented by depth;
 *     ↑/↓ SELECT a row (highlighted).
 *   - bottom: the SELECTED subagent's live trace (goal · status · model, latest
 *     thought, and the tool/progress/summary log) — sticky-bottom so it follows
 *     live; PgUp/PgDn scroll it.
 * Esc/Ctrl+C close (native keymap). §8 #2 scrollbox gotchas (minHeight:0, sticky bottom).
 */
import { type BoxRenderable, type ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createSignal, For, onMount, Show } from 'solid-js'

import type { SubagentInfo, TraceEntry } from '../../logic/store.ts'
import { truncRight } from '../../logic/truncate.ts'
import { useDimensions } from '../dimensions.tsx'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'

const PAGE = 8

function statusColor(status: string, theme: ReturnType<typeof useTheme>): string {
  const c = theme().color
  if (status === 'complete') return c.ok
  if (status === 'tool' || status === 'working') return c.accent
  if (status.includes('error') || status === 'failed') return c.error
  return c.warn
}

/** Per-kind glyph + color for a trace entry — makes the detail pane read like a
 *  transcript (tool calls pop, progress is quiet, the summary is the payoff). */
function traceGlyph(kind: TraceEntry['kind']): string {
  return kind === 'tool' ? '⚡' : kind === 'summary' ? '✓' : kind === 'start' ? '▶' : kind === 'reply' ? '❯' : '·'
}
function traceColor(kind: TraceEntry['kind'], theme: ReturnType<typeof useTheme>): string {
  const c = theme().color
  return kind === 'tool'
    ? c.accent
    : kind === 'summary'
      ? c.ok
      : kind === 'start'
        ? c.label
        : kind === 'reply'
          ? c.text
          : c.muted
}

export function AgentsDashboard(props: {
  subagents: SubagentInfo[]
  onClose: () => void
  /** Subagent id to preselect on open (Enter from the agents tray — Epic 2.7). */
  preselect?: string | undefined
}) {
  const theme = useTheme()
  const dims = useDimensions()
  const [sel, setSel] = createSignal(0)
  let rootRef: BoxRenderable | undefined
  let traceBox: ScrollBoxRenderable | undefined

  const count = () => props.subagents.length
  const selected = () => Math.min(sel(), Math.max(0, count() - 1))
  const current = () => props.subagents[selected()]

  // Close (Esc/Ctrl+C) is the native keymap; select + scroll stay in the raw global
  // handler below. Focus the root box on mount so the focus-within close layer is active.
  // A `preselect` id (tray Enter) lands the selection on that agent's row.
  onMount(() => {
    rootRef?.focus()
    if (props.preselect) {
      const idx = props.subagents.findIndex(sa => sa.id === props.preselect)
      if (idx >= 0) setSel(idx)
    }
  })
  useCloseLayer(
    () => rootRef,
    () => props.onClose()
  )

  useKeyboard(key => {
    // `q` closes (footer advertises "Esc/q close"); Esc/Ctrl+C close via the keymap.
    if (key.name === 'q') return props.onClose()
    if (key.name === 'up') setSel(s => Math.max(0, s - 1))
    else if (key.name === 'down') setSel(s => Math.min(Math.max(0, count() - 1), s + 1))
    else if (key.name === 'pageup') traceBox?.scrollBy(-PAGE)
    else if (key.name === 'pagedown') traceBox?.scrollBy(PAGE)
  })

  return (
    <box
      ref={el => (rootRef = el)}
      focusable
      style={{ borderColor: theme().color.accent, flexDirection: 'column', flexGrow: 1, minHeight: 0 }}
      border
    >
      <box style={{ flexShrink: 0, paddingLeft: 1 }}>
        <text fg={theme().color.accent}>
          <b>
            ⛓ Agents · {count()} subagent{count() === 1 ? '' : 's'}
          </b>
        </text>
      </box>

      {/* master: the subagent list (↑/↓ select) */}
      <box style={{ flexShrink: 0, flexDirection: 'column', maxHeight: 10 }}>
        <Show
          when={count() > 0}
          fallback={<text fg={theme().color.muted}>No subagents yet — delegate a task to spawn one.</text>}
        >
          {/* ONE line per row (de-crowd, glitch 2026-06-13): indent + select caret
              + status + a TRUNCATED goal + model — the full prompt no longer wraps
              the master list into a wall of text. The detail pane shows the rest. */}
          <For each={props.subagents}>
            {(sa, i) => {
              const indent = () => '  '.repeat(Math.max(0, sa.depth))
              // budget the goal into the leftover row width so it never wraps:
              // total − border/pad − indent − caret(2) − `● status `(status+3) − model tail.
              const goalMax = () => {
                const modelTail = sa.model ? sa.model.length + 3 : 0
                const used = 4 + indent().length + 2 + (sa.status.length + 3) + modelTail
                return Math.max(8, dims().width - used)
              }
              return (
                <text onMouseDown={() => setSel(i())}>
                  <span style={{ fg: theme().color.muted }}>{indent()}</span>
                  <span style={{ fg: i() === selected() ? theme().color.accent : theme().color.muted }}>
                    {i() === selected() ? '▸ ' : '  '}
                  </span>
                  <span style={{ fg: statusColor(sa.status, theme) }}>{`● ${sa.status} `}</span>
                  <span style={{ fg: i() === selected() ? theme().color.label : theme().color.text }}>
                    {truncRight(sa.goal || sa.id, goalMax())}
                  </span>
                  <span style={{ fg: theme().color.muted }}>{sa.model ? ` · ${sa.model}` : ''}</span>
                </text>
              )
            }}
          </For>
        </Show>
      </box>

      {/* detail: the selected subagent's live trace */}
      <box style={{ flexGrow: 1, minHeight: 0, flexDirection: 'column', borderColor: theme().color.border }} border>
        <Show when={current()} fallback={<text fg={theme().color.muted}> </text>}>
          {sa => (
            <>
              <box style={{ flexShrink: 0, paddingLeft: 1 }}>
                <text>
                  <span style={{ fg: theme().color.label }}>{sa().goal || sa().id}</span>
                  <span style={{ fg: statusColor(sa().status, theme) }}>{`  · ${sa().status}`}</span>
                  <span style={{ fg: theme().color.muted }}>{sa().model ? `  · ${sa().model}` : ''}</span>
                </text>
              </box>
              <Show when={sa().thought}>
                <box style={{ flexShrink: 0, paddingLeft: 1 }}>
                  <text>
                    <span style={{ fg: theme().color.muted }}>{`🧠 ${sa().thought}`}</span>
                  </text>
                </box>
              </Show>
              <box style={{ flexGrow: 1, minHeight: 0, paddingLeft: 1 }}>
                <scrollbox
                  ref={el => (traceBox = el)}
                  style={{ flexGrow: 1, minHeight: 0 }}
                  stickyScroll
                  stickyStart="bottom"
                >
                  <Show
                    when={(sa().trace?.length ?? 0) > 0}
                    fallback={<text fg={theme().color.muted}>(no activity yet)</text>}
                  >
                    <For each={sa().trace ?? []}>
                      {entry => (
                        <text>
                          <span style={{ fg: traceColor(entry.kind, theme) }}>{`${traceGlyph(entry.kind)} `}</span>
                          <span
                            style={{
                              fg:
                                entry.kind === 'summary' || entry.kind === 'reply'
                                  ? theme().color.text
                                  : theme().color.muted
                            }}
                          >
                            {entry.text}
                          </span>
                        </text>
                      )}
                    </For>
                  </Show>
                </scrollbox>
              </box>
            </>
          )}
        </Show>
      </box>

      <box style={{ flexShrink: 0, paddingLeft: 1 }}>
        <text fg={theme().color.muted}>Esc/q close · ↑↓ select · PgUp/PgDn scroll trace</text>
      </box>
    </box>
  )
}
