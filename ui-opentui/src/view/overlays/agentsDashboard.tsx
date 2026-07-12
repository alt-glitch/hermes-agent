/**
 * Production native /agents surface. Transport remains outside the view:
 * callers supply immutable live/history state plus pause/kill callbacks.
 */
import { type BoxRenderable, type ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { createDelegationState, delegationPressure, type DelegationState } from '../../logic/agentStatus.ts'
import { diffSpawnSnapshots, type SpawnHistoryState, type SpawnSnapshot } from '../../logic/spawnHistory.ts'
import {
  buildSubagentTree,
  descendantIds,
  formatSummary,
  peakHotness,
  sparkline,
  treeTotals,
  widthByDepth
} from '../../logic/subagentTree.ts'
import { truncRight } from '../../logic/truncate.ts'
import { useDimensions } from '../dimensions.tsx'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'
import {
  AGENTS_FILTER_LABEL,
  AGENTS_FILTER_ORDER,
  AGENTS_SORT_LABEL,
  AGENTS_SORT_ORDER,
  cycleDashboardValue,
  dashboardWindow,
  prepareDashboardRows,
  selectedDashboardIndex,
  snapshotDashboardAgents,
  type AgentsFilterMode,
  type AgentsSortMode,
  type DashboardAgent
} from './agents/model.ts'
import { AgentDetail, AgentListRow, AgentsDiffView, AgentsTimeline, DelegationSummary } from './agents/panes.tsx'

type DashboardMode = 'detail' | 'list'
type DashboardActionResult = string | void
type MaybePromise<T> = Promise<T> | T

export interface AgentsDashboardDiffPair {
  readonly baseline: SpawnSnapshot
  readonly candidate: SpawnSnapshot
}

export interface AgentsDashboardProps {
  readonly subagents: readonly DashboardAgent[]
  readonly onClose: () => void
  readonly delegation?: DelegationState
  readonly diffPair?: AgentsDashboardDiffPair
  readonly history?: SpawnHistoryState
  readonly initialHistoryIndex?: number
  readonly onClearDiff?: () => void
  readonly onKillAgent?: (id: string) => MaybePromise<DashboardActionResult>
  readonly onKillSubtree?: (ids: readonly string[]) => MaybePromise<DashboardActionResult>
  readonly onPauseChange?: (paused: boolean) => MaybePromise<DashboardActionResult>
  /** Subagent id to preselect on open (Enter from the agents tray). */
  readonly preselect?: string
}

const EMPTY_HISTORY: SpawnHistoryState = Object.freeze({ snapshots: Object.freeze([]) })
const EMPTY_DELEGATION: DelegationState = createDelegationState()

function DiffSurface(props: { readonly pair: AgentsDashboardDiffPair; readonly width: number }) {
  const agentsA = createMemo(() => snapshotDashboardAgents(props.pair.baseline))
  const agentsB = createMemo(() => snapshotDashboardAgents(props.pair.candidate))
  const totalsA = createMemo(() => treeTotals(buildSubagentTree(agentsA())))
  const totalsB = createMemo(() => treeTotals(buildSubagentTree(agentsB())))
  const diff = createMemo(() => diffSpawnSnapshots(props.pair.baseline, props.pair.candidate))
  return (
    <AgentsDiffView
      baseline={props.pair.baseline}
      candidate={props.pair.candidate}
      diff={diff()}
      totalsA={totalsA()}
      totalsB={totalsB()}
      width={props.width}
    />
  )
}

export function AgentsDashboard(props: AgentsDashboardProps) {
  const theme = useTheme()
  const dims = useDimensions()
  const [mode, setMode] = createSignal<DashboardMode>('list')
  const [sort, setSort] = createSignal<AgentsSortMode>('depth-first')
  const [filter, setFilter] = createSignal<AgentsFilterMode>('all')
  const [selectedId, setSelectedId] = createSignal<string | undefined>(props.preselect)
  const [historyIndex, setHistoryIndex] = createSignal(
    Math.max(0, Math.min(props.history?.snapshots.length ?? 0, Math.floor(props.initialHistoryIndex ?? 0)))
  )
  const [flash, setFlash] = createSignal('')
  const [actionPending, setActionPending] = createSignal(false)
  const [nowMs, setNowMs] = createSignal(Date.now())
  const [sections, setSections] = createSignal<Readonly<Record<string, boolean>>>({})
  let rootRef: BoxRenderable | undefined
  let detailScroll: ScrollBoxRenderable | undefined
  let previousLiveCount = props.subagents.length

  const history = () => props.history ?? EMPTY_HISTORY
  const delegation = () => props.delegation ?? EMPTY_DELEGATION
  const replaySnapshot = createMemo(() => {
    const index = historyIndex()
    if (index > 0) return history().snapshots[index - 1]
    // The store archives before clearing live rows. Preserve that last turn in
    // the boundary render as well as in the following effect, avoiding an
    // empty-frame flash while historyIndex catches up.
    if (props.subagents.length === 0) return history().snapshots[0]
    return undefined
  })
  const replayMode = () => replaySnapshot() !== undefined
  const displayNowMs = () => replaySnapshot()?.finishedAtMs ?? nowMs()
  const agents = createMemo<readonly DashboardAgent[]>(() => {
    const snapshot = replaySnapshot()
    return snapshot === undefined ? props.subagents : snapshotDashboardAgents(snapshot)
  })
  const tree = createMemo(() => buildSubagentTree(agents()))
  const totals = createMemo(() => treeTotals(tree()))
  const widths = createMemo(() => widthByDepth(tree()))
  const rows = createMemo(() => prepareDashboardRows(agents(), sort(), filter()))
  const selectedIndex = createMemo(() => selectedDashboardIndex(rows(), selectedId()))
  const selected = createMemo(() => {
    const index = selectedIndex()
    return index < 0 ? undefined : rows()[index]
  })
  const showTimeline = () => dims().width >= 78 && dims().height >= 22
  const listCapacity = () => Math.max(4, Math.min(18, dims().height - (showTimeline() ? 16 : 10)))
  const visible = createMemo(() => dashboardWindow(rows(), selectedIndex(), listCapacity()))
  const peak = createMemo(() => peakHotness(tree()))
  const pressure = createMemo(() =>
    delegationPressure(delegation(), {
      activeCount: totals().activeCount,
      depth: totals().maxDepthFromHere,
      widestLevel: Math.max(0, ...widths())
    })
  )

  const modelMix = createMemo(() => {
    const counts = new Map<string, number>()
    for (const agent of agents()) {
      const key = agent.model?.split('/').at(-1) ?? 'inherit'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([name, count]) => `${name}×${String(count)}`)
      .join(' · ')
  })
  const metaLine = createMemo(() => {
    const parts = [formatSummary(totals()), sparkline(widths())]
    return parts.filter(Boolean).join('  ')
  })
  const title = createMemo(() => {
    const snapshot = replaySnapshot()
    if (snapshot === undefined) return `Spawn tree${delegation().paused ? ' · ⏸ paused' : ''}`
    if (historyIndex() === 0) return 'Last turn'
    return `Replay ${String(historyIndex())}/${String(history().snapshots.length)} · finished ${new Date(snapshot.finishedAtMs).toLocaleTimeString()}`
  })
  const listFooter = createMemo(() => {
    const locked = replayMode()
      ? ' · controls locked'
      : ` · x kill · X subtree · p ${delegation().paused ? 'resume' : 'pause'}`
    const historyHint =
      history().snapshots.length > 0
        ? ` · [ / ] history ${String(historyIndex())}/${String(history().snapshots.length)}`
        : ''
    const full = `↑↓/jk move · g/G top/bottom · Enter/→ open detail${locked} · s sort:${AGENTS_SORT_LABEL[sort()]} · f filter:${AGENTS_FILTER_LABEL[filter()]}${historyHint} · q close`
    const medium = `↑↓ move · Enter/→ open detail · s/f view${locked} · q close`
    const compact = `↑↓ move · Enter open · s/f view${locked} · q close`
    const available = Math.max(8, dims().width - 4)
    const footer = full.length + 2 <= available ? full : medium.length + 2 <= available ? medium : compact
    return truncRight(footer, available)
  })
  const detailFooter = createMemo(() => {
    const controls = replayMode()
      ? ' · controls locked'
      : ` · x kill · X subtree · p ${delegation().paused ? 'resume' : 'pause'}`
    const full = `↑↓/jk scroll · PgUp/PgDn page · g/G top/bottom · Esc/← back${controls} · q close`
    const compact = `↑↓ scroll · PgUp/PgDn page · Esc back${controls} · q close`
    const available = Math.max(8, dims().width - 4)
    return full.length + 2 <= available ? full : truncRight(compact, available)
  })

  function closeWithCleanup(): void {
    props.onClearDiff?.()
    props.onClose()
  }

  function backOrClose(): void {
    if (props.diffPair !== undefined) closeWithCleanup()
    else if (mode() === 'detail') setMode('list')
    else closeWithCleanup()
  }

  useCloseLayer(
    () => rootRef,
    () => backOrClose()
  )

  onMount(() => {
    rootRef?.focus()
  })

  createEffect(() => {
    const options = rows()
    if (options.length === 0) {
      if (selectedId() !== undefined) setSelectedId(undefined)
      return
    }
    const current = selectedId()
    if (current === undefined || !options.some(node => node.item.id === current)) {
      setSelectedId(options[0]?.item.id)
    }
  })

  createEffect(() => {
    const maximum = history().snapshots.length
    if (historyIndex() > maximum) setHistoryIndex(maximum)
  })

  createEffect(() => {
    const liveCount = props.subagents.length
    const archiveCount = history().snapshots.length
    if (historyIndex() === 0 && previousLiveCount > 0 && liveCount === 0 && archiveCount > 0) {
      setHistoryIndex(1)
      setMode('list')
      setSelectedId(undefined)
      setFlash('turn finished · inspect freely · q to close')
    }
    previousLiveCount = liveCount
  })

  createEffect(() => {
    selectedId()
    historyIndex()
    mode()
    detailScroll?.scrollTo(0)
  })

  createEffect(() => {
    if (replayMode()) return
    const ticking = agents().some(agent => {
      const status = agent.status.trim().toLowerCase()
      return agent.startedAt !== undefined && (status === 'running' || status === 'queued')
    })
    if (!ticking) return
    const timer = setInterval(() => setNowMs(Date.now()), 500)
    onCleanup(() => clearInterval(timer))
  })

  function moveSelection(delta: number): void {
    const options = rows()
    if (options.length === 0) return
    const current = selectedIndex()
    const next = Math.max(0, Math.min(options.length - 1, current + delta))
    setSelectedId(options[next]?.item.id)
  }

  function stepHistory(delta: -1 | 1): void {
    setHistoryIndex(current => {
      const next = Math.max(0, Math.min(history().snapshots.length, current + delta))
      if (next !== current) {
        setMode('list')
        setSelectedId(undefined)
        setFlash(next === 0 ? 'live turn' : `replay · ${String(next)}/${String(history().snapshots.length)}`)
      }
      return next
    })
  }

  async function runAction(
    unavailable: string,
    pending: string,
    success: string,
    action: (() => MaybePromise<DashboardActionResult>) | undefined
  ): Promise<void> {
    if (replayMode()) {
      setFlash('replay mode — controls disabled')
      return
    }
    if (action === undefined) {
      setFlash(unavailable)
      return
    }
    if (actionPending()) return
    setActionPending(true)
    setFlash(pending)
    try {
      const result = await action()
      setFlash(typeof result === 'string' && result ? result : success)
    } catch (error) {
      setFlash(error instanceof Error && error.message ? error.message : `${unavailable} — failed`)
    } finally {
      setActionPending(false)
    }
  }

  function togglePause(): void {
    const next = !delegation().paused
    void runAction(
      'pause control unavailable',
      next ? 'pausing spawning…' : 'resuming spawning…',
      next ? 'spawning paused' : 'spawning resumed',
      props.onPauseChange === undefined ? undefined : () => props.onPauseChange?.(next)
    )
  }

  function killOne(): void {
    const node = selected()
    if (node === undefined) return
    const id = node.item.id
    void runAction(
      'kill control unavailable',
      `killing ${id}…`,
      `killing ${id}`,
      props.onKillAgent === undefined ? undefined : () => props.onKillAgent?.(id)
    )
  }

  function killSubtree(): void {
    const node = selected()
    if (node === undefined) return
    const ids = [node.item.id, ...descendantIds(node)]
    void runAction(
      'subtree control unavailable',
      `killing subtree · ${String(ids.length)} node${ids.length === 1 ? '' : 's'}…`,
      `killing subtree · ${String(ids.length)} node${ids.length === 1 ? '' : 's'}`,
      props.onKillSubtree === undefined ? undefined : () => props.onKillSubtree?.(ids)
    )
  }

  function sectionOpen(name: string, defaultOpen: boolean): boolean {
    return sections()[name] ?? defaultOpen
  }

  function toggleSection(name: string): void {
    const defaults: Readonly<Record<string, boolean>> = {
      Budget: true,
      Files: false,
      'Live trace': true,
      Output: true,
      Progress: false,
      Summary: true,
      'Tool calls': true
    }
    setSections(current => ({ ...current, [name]: !(current[name] ?? defaults[name] ?? false) }))
  }

  useKeyboard(key => {
    const sequence = key.sequence
    if (sequence === 'q' && !key.ctrl && !key.meta) {
      closeWithCleanup()
      return
    }
    if (props.diffPair !== undefined) return

    if (sequence === '<' || sequence === '[') {
      stepHistory(1)
      return
    }
    if (sequence === '>' || sequence === ']') {
      stepHistory(-1)
      return
    }
    if (key.name === 'p' && !key.ctrl && !key.meta) {
      togglePause()
      return
    }
    if (key.name === 'x' && key.shift) {
      killSubtree()
      return
    }
    if (key.name === 'x' && !key.ctrl && !key.meta) {
      killOne()
      return
    }

    if (mode() === 'detail') {
      if (key.name === 'left' || key.name === 'h') setMode('list')
      else if (key.name === 'pageup' || (key.ctrl && key.name === 'u'))
        detailScroll?.scrollBy(-Math.max(4, dims().height - 12))
      else if (key.name === 'pagedown' || (key.ctrl && key.name === 'd'))
        detailScroll?.scrollBy(Math.max(4, dims().height - 12))
      else if (key.name === 'up' || key.name === 'k') detailScroll?.scrollBy(-2)
      else if (key.name === 'down' || key.name === 'j') detailScroll?.scrollBy(2)
      else if (key.name === 'g' && key.shift) detailScroll?.scrollTo(Number.MAX_SAFE_INTEGER)
      else if (key.name === 'g') detailScroll?.scrollTo(0)
      return
    }

    if ((key.name === 'return' || key.name === 'right' || key.name === 'l') && selected() !== undefined) {
      setMode('detail')
    } else if (key.name === 'up' || key.name === 'k') moveSelection(-1)
    else if (key.name === 'down' || key.name === 'j') moveSelection(1)
    else if (key.name === 'g' && key.shift) {
      const options = rows()
      setSelectedId(options.at(-1)?.item.id)
    } else if (key.name === 'g') setSelectedId(rows()[0]?.item.id)
    else if (key.name === 's') setSort(current => cycleDashboardValue(AGENTS_SORT_ORDER, current))
    else if (key.name === 'f') setFilter(current => cycleDashboardValue(AGENTS_FILTER_ORDER, current))
  })

  return (
    <box
      ref={element => (rootRef = element)}
      focusable
      border
      style={{ borderColor: theme().color.accent, flexDirection: 'column', flexGrow: 1, minHeight: 0 }}
    >
      <Show
        when={props.diffPair}
        fallback={
          <>
            <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
              <text wrapMode="none">
                <span style={{ fg: replayMode() ? theme().color.border : theme().color.primary }}>
                  <b>{title()}</b>
                </span>
                <span style={{ fg: theme().color.muted }}>{metaLine() ? `   ${metaLine()}` : ''}</span>
                <span style={{ fg: theme().color.muted }}>{dims().width >= 88 ? '  ' : ''}</span>
                <Show when={dims().width >= 88}>
                  <DelegationSummary delegation={delegation()} pressure={pressure()} />
                </Show>
              </text>
              <Show when={dims().width >= 100 && modelMix()}>
                {mix => (
                  <text fg={theme().color.muted} wrapMode="none">
                    models · {truncRight(mix(), Math.max(8, dims().width - 13))}
                  </text>
                )}
              </Show>
            </box>

            <Show
              when={rows().length > 0}
              fallback={
                <box style={{ flexDirection: 'column', flexGrow: 1, paddingLeft: 1 }}>
                  <text fg={theme().color.muted}>
                    No subagents this turn. Trigger delegate_task to populate the tree.
                  </text>
                </box>
              }
            >
              <Show
                when={mode() === 'list'}
                fallback={
                  <box style={{ flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingLeft: 1 }}>
                    <Show when={selected()}>
                      {node => (
                        <AgentDetail
                          bindScroll={scroll => (detailScroll = scroll)}
                          node={node()}
                          onToggleSection={toggleSection}
                          rowNumber={selectedIndex() + 1}
                          sectionOpen={sectionOpen}
                          width={Math.max(20, dims().width - 5)}
                        />
                      )}
                    </Show>
                  </box>
                }
              >
                <box style={{ flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingLeft: 1, paddingRight: 1 }}>
                  <Show when={showTimeline()}>
                    <AgentsTimeline
                      maxRows={6}
                      nodes={rows()}
                      nowMs={displayNowMs()}
                      selectedId={selected()?.item.id}
                      width={Math.max(30, dims().width - 4)}
                    />
                  </Show>
                  <box style={{ flexDirection: 'column', flexGrow: 0, flexShrink: 0, overflow: 'hidden' }}>
                    <For each={visible().rows}>
                      {(node, offset) => {
                        const absoluteIndex = () => visible().start + offset()
                        return (
                          <AgentListRow
                            active={node.item.id === selected()?.item.id}
                            absoluteIndex={absoluteIndex()}
                            node={node}
                            onSelect={() => setSelectedId(node.item.id)}
                            peak={peak()}
                            width={Math.max(20, dims().width - 5)}
                          />
                        )
                      }}
                    </For>
                  </box>
                </box>
              </Show>
            </Show>

            <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
              <Show when={flash()}>
                {message => (
                  <text fg={theme().color.accent} wrapMode="none">
                    {truncRight(message(), Math.max(8, dims().width - 4))}
                  </text>
                )}
              </Show>
              <text fg={theme().color.muted} wrapMode="none">
                {mode() === 'list' ? listFooter() : detailFooter()}
              </text>
            </box>
          </>
        }
      >
        {pair => <DiffSurface pair={pair()} width={dims().width} />}
      </Show>
    </box>
  )
}
