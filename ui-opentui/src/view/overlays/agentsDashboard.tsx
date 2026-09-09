/**
 * Production native /agents surface. Transport remains outside the view:
 * callers supply immutable live/history state plus pause/kill callbacks.
 */
import { type BoxRenderable, type ScrollBoxRenderable, type TextareaRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'

import {
  createDelegationState,
  delegationPressure,
  isActiveSubagentStatus,
  type DelegationState
} from '../../logic/agentStatus.ts'
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

type DashboardMode = 'detail' | 'list' | 'steer' | 'tail'
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
  readonly onLoadTail?: (
    id: string
  ) => Promise<{ readonly available: boolean; readonly text: string; readonly truncated: boolean }>
  readonly onSteerAgent?: (id: string, text: string) => Promise<string>
  /** Subagent id to preselect on open (Enter from the agents tray). */
  readonly preselect?: string
}

const EMPTY_HISTORY: SpawnHistoryState = Object.freeze({ snapshots: Object.freeze([]) })
const EMPTY_DELEGATION: DelegationState = createDelegationState()

function AgentTail(props: {
  readonly id: string
  readonly load: AgentsDashboardProps['onLoadTail']
  readonly onUpdate: () => void
}) {
  const theme = useTheme()
  const [text, setText] = createSignal('Loading live transcript…')
  createEffect(
    on(
      () => props.id,
      id => {
        setText('Loading live transcript…')
        let alive = true
        let pending = false
        const refresh = async (): Promise<void> => {
          if (pending || props.load === undefined) return
          pending = true
          try {
            const result = await props.load(id)
            if (!alive) return
            setText(
              result.available
                ? `${result.truncated ? '[last 16 KiB]\n' : ''}${result.text}`
                : 'Live transcript unavailable; the child may have finished. Streamed progress remains in Details.'
            )
            queueMicrotask(props.onUpdate)
          } catch {
            if (alive) setText('Could not refresh the live transcript.')
          } finally {
            pending = false
          }
        }
        void refresh()
        const timer = setInterval(() => void refresh(), 1_500)
        onCleanup(() => {
          alive = false
          clearInterval(timer)
        })
      }
    )
  )
  return (
    <box style={{ flexDirection: 'column', paddingRight: 1 }}>
      <text fg={theme().color.accent}>
        <b>Live transcript · {props.id}</b>
      </text>
      <text fg={theme().color.text} wrapMode="word">
        {text()}
      </text>
    </box>
  )
}

function AgentSteer(props: {
  readonly id: string
  readonly onPending: (pending: boolean) => void
  readonly steer: AgentsDashboardProps['onSteerAgent']
}) {
  const theme = useTheme()
  const [feedback, setFeedback] = createSignal(
    'Guidance queues at the next tool boundary; current work is not interrupted.'
  )
  const [pending, setPending] = createSignal(false)
  let input: TextareaRenderable | undefined
  onMount(() => input?.focus())

  const submit = (): void => {
    const text = input?.plainText.trim() ?? ''
    if (!text || pending() || props.steer === undefined) return
    setPending(true)
    props.onPending(true)
    setFeedback('Queueing…')
    void props
      .steer(props.id, text)
      .then(message => {
        setFeedback(message)
        input?.setText('')
      })
      .catch(cause => setFeedback(cause instanceof Error ? cause.message : 'steer failed'))
      .finally(() => {
        setPending(false)
        props.onPending(false)
      })
  }

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingRight: 1 }}>
      <text fg={theme().color.accent}>
        <b>Steer · {props.id}</b>
      </text>
      <text fg={theme().color.muted}>{feedback()}</text>
      <box style={{ flexDirection: 'row', marginTop: 1 }}>
        <text fg={theme().color.primary}>❯ </text>
        <textarea
          ref={element => (input = element)}
          maxHeight={6}
          placeholder="Guidance for this child"
          placeholderColor={theme().color.muted}
          textColor={theme().color.text}
          cursorColor={theme().color.accent}
          keyBindings={[
            { action: 'submit', name: 'return' },
            { action: 'newline', name: 'return', shift: true }
          ]}
          onSubmit={submit}
          style={{ flexGrow: 1, minWidth: 0 }}
        />
      </box>
      <text fg={theme().color.muted}>
        Enter queue · Shift+Enter newline · Esc back · main composer draft is preserved
      </text>
    </box>
  )
}

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
  const initialHistoryIndex = Math.max(
    0,
    Math.min(props.history?.snapshots.length ?? 0, Math.floor(props.initialHistoryIndex ?? 0))
  )
  const [lastTurn, setLastTurn] = createSignal(initialHistoryIndex === 0 && props.subagents.length === 0)
  // Retain the inspected snapshot itself: prepending or pruning history must
  // never replace the run under the user's cursor.
  const [replaySnapshot, setReplaySnapshot] = createSignal<SpawnSnapshot | undefined>(
    initialHistoryIndex > 0
      ? props.history?.snapshots[initialHistoryIndex - 1]
      : props.subagents.length === 0
        ? props.history?.snapshots[0]
        : undefined
  )
  const [flash, setFlash] = createSignal('')
  const [actionPending, setActionPending] = createSignal(false)
  const [steerPending, setSteerPending] = createSignal(false)
  const [nowMs, setNowMs] = createSignal(Date.now())
  const [following, setFollowing] = createSignal(true)
  const [dashboardHeight, setDashboardHeight] = createSignal(dims().height)
  const [masterHeight, setMasterHeight] = createSignal(0)
  const [sections, setSections] = createSignal<Readonly<Record<string, boolean>>>({})
  const [showKeys, setShowKeys] = createSignal(false)
  let rootRef: BoxRenderable | undefined
  let masterRef: BoxRenderable | undefined
  let detailScroll: ScrollBoxRenderable | undefined
  let helpScroll: ScrollBoxRenderable | undefined
  let previousLiveCount = props.subagents.length

  const history = () => props.history ?? EMPTY_HISTORY
  const delegation = () => props.delegation ?? EMPTY_DELEGATION
  const historyIndex = createMemo(() => {
    const snapshot = replaySnapshot()
    return snapshot === undefined ? 0 : history().snapshots.findIndex(item => item.id === snapshot.id) + 1
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
  const wide = () => dims().width >= 110
  const listWidth = () => (wide() ? Math.min(52, Math.floor(dims().width * 0.4)) : Math.max(12, dims().width - 4))
  const showTimeline = () => dims().width >= 78 && dims().height >= 26
  const timelineRows = () => Math.min(4, rows().length)
  const listCapacity = () => Math.max(1, Math.floor((masterHeight() - 1) / 2))
  // Terminal dimensions include chrome owned by the parent. Size help from the
  // dashboard's settled rows, reserving its border, title, detail viewport and footer.
  const helpHeight = () => Math.max(1, Math.min(8, dashboardHeight() - 8))
  const visibleFlash = () => (showKeys() ? '' : flash())
  const nodesById = createMemo(() => new Map(rows().map(node => [node.item.id, node])))
  const visible = createMemo(() => dashboardWindow(rows(), selectedIndex(), listCapacity()))
  const visibleIds = createMemo(() => visible().rows.map(node => node.item.id))
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
    if (lastTurn() && history().snapshots[0]?.id === snapshot.id) return 'Last turn'
    if (historyIndex() === 0) return 'Retained replay'
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
    const full = `↑↓/jk move · g/G top/bottom · Enter/→ detail · t tail · e steer${locked} · s sort:${AGENTS_SORT_LABEL[sort()]} · f filter:${AGENTS_FILTER_LABEL[filter()]}${historyHint} · ? keys · q close`
    const medium = `↑↓ move · Enter detail · t tail · e steer · s/f view${locked} · ? keys · q close`
    const compact = `↑↓ move · Enter open · ? keys · q close${replayMode() ? ' · controls locked' : ''}`
    const tiny = `↑↓ · Enter open · ? keys · q close`
    const available = Math.max(8, dims().width - 4)
    const footer =
      full.length + 2 <= available
        ? full
        : medium.length + 2 <= available
          ? medium
          : compact.length <= available
            ? compact
            : tiny
    return truncRight(footer, available)
  })
  const detailFooter = createMemo(() => {
    const controls = replayMode()
      ? ' · controls locked'
      : ` · x kill · X subtree · p ${delegation().paused ? 'resume' : 'pause'}`
    const full = `↑↓ scroll · PgUp/PgDn · G/L bottom · Esc/← back · r reasoning · a activity · t tools${controls} · ? keys · q close`
    const compact = `↑↓ scroll · L bottom · Esc back · ? keys · q close`
    const tiny = `Esc back · ? keys · q close`
    const available = Math.max(8, dims().width - 4)
    return full.length + 2 <= available ? full : truncRight(compact.length <= available ? compact : tiny, available)
  })

  function closeWithCleanup(): void {
    props.onClearDiff?.()
    props.onClose()
  }

  function backOrClose(): void {
    if (mode() === 'steer' && steerPending()) return
    if (showKeys()) setShowKeys(false)
    else if (props.diffPair !== undefined) closeWithCleanup()
    else if (mode() === 'steer' || mode() === 'tail') setMode('detail')
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
      setMode('list')
      return
    }
    const current = selectedId()
    if (current === undefined || !options.some(node => node.item.id === current)) {
      setSelectedId(options[0]?.item.id)
    }
  })

  createEffect(() => {
    const liveCount = props.subagents.length
    const archiveCount = history().snapshots.length
    if (!replayMode() && previousLiveCount > 0 && liveCount === 0 && archiveCount > 0) {
      setReplaySnapshot(history().snapshots[0])
      setLastTurn(true)
      setMode('list')
      setSelectedId(undefined)
      setFlash('turn finished · inspect freely · q to close')
    }
    previousLiveCount = liveCount
  })

  createEffect(
    on([selectedId, () => replaySnapshot()?.id], () => {
      setFollowing(!replayMode())
      setSections({})
      detailScroll?.scrollTo(replayMode() ? 0 : Number.MAX_SAFE_INTEGER)
    })
  )

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
    const next = Math.max(0, Math.min(history().snapshots.length, historyIndex() + delta))
    const snapshot = next === 0 ? undefined : history().snapshots[next - 1]
    if (snapshot === replaySnapshot()) return
    setReplaySnapshot(snapshot)
    setLastTurn(false)
    setMode('list')
    setSelectedId(undefined)
    setFlash(next === 0 ? 'live turn' : `replay · ${String(next)}/${String(history().snapshots.length)}`)
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
    if (actionPending()) {
      setFlash('control request pending — navigation remains available')
      return
    }
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
    if (node === undefined) {
      setFlash('no agent selected')
      return
    }
    if (!replayMode() && !isActiveSubagentStatus(node.item.status)) {
      setFlash('agent already finished — messages remain available')
      return
    }
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
    if (node === undefined) {
      setFlash('no agent selected')
      return
    }
    if (!replayMode() && node.aggregate.activeCount === 0) {
      setFlash('subtree already finished — messages remain available')
      return
    }
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
    setFollowing(false)
    setSections(current => ({ ...current, [name]: !(current[name] ?? false) }))
  }

  function returnLive(): void {
    setFollowing(!replayMode())
    detailScroll?.scrollTo(Number.MAX_SAFE_INTEGER)
  }

  function scrollDetail(delta: number): void {
    setFollowing(false)
    detailScroll?.scrollBy(delta)
  }

  useKeyboard(key => {
    if (mode() === 'steer') return
    if (key.ctrl || key.meta) {
      if (key.ctrl && !key.meta && (key.name === 'u' || key.name === 'd')) {
        const delta = (key.name === 'u' ? -1 : 1) * Math.max(4, dims().height - 12)
        if (showKeys()) helpScroll?.scrollBy(delta)
        else if (mode() === 'detail') scrollDetail(delta)
      }
      return
    }
    const sequence = key.sequence
    if (sequence === 'q') {
      closeWithCleanup()
      return
    }
    if (props.diffPair !== undefined) return
    if (sequence === '?') {
      setShowKeys(current => !current)
      return
    }
    if (showKeys()) {
      if (key.name === 'up' || key.name === 'k') helpScroll?.scrollBy(-1)
      else if (key.name === 'down' || key.name === 'j') helpScroll?.scrollBy(1)
      else if (key.name === 'pageup') helpScroll?.scrollBy(-5)
      else if (key.name === 'pagedown') helpScroll?.scrollBy(5)
      else if (key.name === 'home' || (key.name === 'g' && !key.shift)) helpScroll?.scrollTo(0)
      else if (key.name === 'end' || (key.name === 'g' && key.shift)) helpScroll?.scrollTo(Number.MAX_SAFE_INTEGER)
      return
    }

    if (sequence === '<' || sequence === '[') {
      stepHistory(1)
      return
    }
    if (sequence === '>' || sequence === ']') {
      stepHistory(-1)
      return
    }
    if (key.name === 'p') {
      togglePause()
      return
    }
    if (mode() === 'list' && key.name === 'e' && selected() !== undefined && !replayMode()) {
      key.preventDefault()
      if (selected()?.item.acceptingSteer === false) setFlash('child no longer accepts guidance')
      else setMode('steer')
      return
    }
    if (mode() === 'list' && key.name === 't' && selected() !== undefined && !replayMode()) {
      key.preventDefault()
      setMode('tail')
      return
    }
    if (mode() === 'list' && key.name === 'd' && selected() !== undefined) {
      key.preventDefault()
      setMode('detail')
      return
    }
    if (key.name === 'x' && key.shift) {
      killSubtree()
      return
    }
    if (key.name === 'x') {
      killOne()
      return
    }

    if (key.name === 'tab') {
      if (selected() !== undefined) setMode(current => (current === 'list' ? 'detail' : 'list'))
      return
    }
    if (key.name === 'l' && key.shift) {
      if (selected() === undefined) return
      setMode('detail')
      returnLive()
      return
    }
    if (mode() === 'detail' || mode() === 'tail') {
      const sectionKeys: Readonly<Record<string, string>> = {
        r: 'Reasoning',
        a: 'Activity',
        t: 'Tool calls',
        o: 'Output',
        b: 'Budget',
        d: 'Details',
        f: 'Files',
        n: 'Progress',
        e: 'Live trace'
      }
      const section = sectionKeys[key.name]
      if (section !== undefined) {
        toggleSection(section)
        return
      }
      if (key.name === 'left' || key.name === 'h') setMode('list')
      else if (key.name === 'pageup') scrollDetail(-Math.max(4, dims().height - 12))
      else if (key.name === 'pagedown') scrollDetail(Math.max(4, dims().height - 12))
      else if (key.name === 'up' || key.name === 'k') scrollDetail(-2)
      else if (key.name === 'down' || key.name === 'j') scrollDetail(2)
      else if (key.name === 'end' || (key.name === 'g' && key.shift)) returnLive()
      else if (key.name === 'home' || key.name === 'g') {
        setFollowing(false)
        detailScroll?.scrollTo(0)
      }
      return
    }

    if ((key.name === 'return' || key.name === 'right' || key.name === 'l') && selected() !== undefined) {
      setMode('detail')
    } else if (key.name === 'up' || key.name === 'k') moveSelection(-1)
    else if (key.name === 'down' || key.name === 'j') moveSelection(1)
    else if (key.name === 'pageup') moveSelection(-listCapacity())
    else if (key.name === 'pagedown') moveSelection(listCapacity())
    else if (key.name === 'end' || (key.name === 'g' && key.shift)) {
      const options = rows()
      setSelectedId(options.at(-1)?.item.id)
    } else if (key.name === 'home' || key.name === 'g') setSelectedId(rows()[0]?.item.id)
    else if (key.name === 's') setSort(current => cycleDashboardValue(AGENTS_SORT_ORDER, current))
    else if (key.name === 'f') setFilter(current => cycleDashboardValue(AGENTS_FILTER_ORDER, current))
  })

  return (
    <box
      ref={element => (rootRef = element)}
      onSizeChange={() => {
        const root = rootRef
        queueMicrotask(() => {
          if (root !== undefined && !root.isDestroyed) setDashboardHeight(root.height)
        })
      }}
      focusable
      border
      style={{ borderColor: theme().color.accent, flexDirection: 'column', flexGrow: 1, minHeight: 0 }}
    >
      <Show
        when={props.diffPair}
        fallback={
          <>
            <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
              <Show when={showKeys()}>
                <scrollbox
                  id="agents-key-help"
                  ref={element => {
                    helpScroll = element
                    element.focusable = false
                  }}
                  height={helpHeight()}
                  flexShrink={0}
                  scrollX={false}
                >
                  <text wrapMode="word" fg={theme().color.text}>
                    {
                      'Keys · Tab: list/detail · ↑↓/jk: move/scroll · PgUp/PgDn: page · Home/g: top · End/G: bottom\n[ older · ] newer/live · Enter/→/l: detail · Esc/←/h: back · q: close\nDetail: r reasoning · a activity · t tools · o output · b budget · d details · e trace · f files · n progress · L follow/bottom\nList: s sort · f filter · x kill agent · X kill subtree · p pause/resume spawning (does not pause running agents)'
                    }
                  </text>
                </scrollbox>
              </Show>
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
                    {agents().length === 0
                      ? 'No subagents this turn. Trigger delegate_task to populate the tree.'
                      : `No agents match filter: ${AGENTS_FILTER_LABEL[filter()]}. Press f to change filter.`}
                  </text>
                </box>
              }
            >
              <Show when={showTimeline()}>
                <AgentsTimeline
                  maxRows={timelineRows()}
                  nodes={rows()}
                  nowMs={displayNowMs()}
                  selectedId={selectedId()}
                  width={Math.max(20, dims().width - 4)}
                />
              </Show>
              <box flexDirection="row" flexGrow={1} minHeight={0} minWidth={0}>
                <box
                  id="agents-master"
                  ref={element => (masterRef = element)}
                  onSizeChange={() => {
                    const master = masterRef
                    // Updating Solid's mounted window during native layout invalidates
                    // the layout traversal. Read its settled size after this pass.
                    queueMicrotask(() => {
                      if (master !== undefined && !master.isDestroyed) setMasterHeight(master.height)
                    })
                  }}
                  visible={wide() || mode() === 'list'}
                  flexDirection="column"
                  flexGrow={wide() ? 0 : 1}
                  flexShrink={0}
                  minHeight={0}
                  width={listWidth()}
                  paddingLeft={1}
                  paddingRight={1}
                  overflow="hidden"
                  onMouseScroll={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    setMode('list')
                    if (event.scroll?.direction === 'up') moveSelection(-1)
                    else if (event.scroll?.direction === 'down') moveSelection(1)
                  }}
                >
                  <For each={visibleIds()}>
                    {(id, offset) => (
                      <Show when={nodesById().get(id)}>
                        {node => (
                          <AgentListRow
                            active={id === selectedId()}
                            absoluteIndex={visible().start + offset()}
                            node={node()}
                            nowMs={displayNowMs()}
                            onSelect={() => {
                              setSelectedId(id)
                              setMode('list')
                            }}
                            peak={peak()}
                            width={Math.max(10, listWidth() - 2)}
                          />
                        )}
                      </Show>
                    )}
                  </For>
                  <Show when={rows().length > listCapacity()}>
                    <text fg={theme().color.muted} wrapMode="none">
                      {String(visible().start + 1)}–{String(visible().start + visible().rows.length)} /{' '}
                      {String(rows().length)} · wheel / ↑↓
                    </text>
                  </Show>
                </box>
                <box
                  id="agents-detail"
                  visible={wide() || mode() !== 'list'}
                  flexDirection="column"
                  flexGrow={1}
                  minHeight={0}
                  minWidth={0}
                  paddingLeft={1}
                  border={wide() ? ['left'] : []}
                  borderColor={theme().color.border}
                >
                  <Show when={!wide()}>
                    <text
                      height={1}
                      flexShrink={0}
                      wrapMode="none"
                      fg={theme().color.accent}
                      onMouseDown={() => setMode('list')}
                    >
                      ← Back to agents
                    </text>
                  </Show>
                  <Show when={selected()}>
                    {node => (
                      <Show
                        when={mode() === 'tail' && !replayMode()}
                        fallback={
                          <Show
                            when={mode() === 'steer' && !replayMode()}
                            fallback={
                              <AgentDetail
                                bindScroll={scroll => {
                                  detailScroll = scroll
                                  scroll.focusable = false
                                }}
                                node={node()}
                                nowMs={displayNowMs()}
                                replay={replayMode()}
                                showAgentHeading={!showKeys() || dashboardHeight() > 9}
                                following={following()}
                                onPauseFollow={() => {
                                  setFollowing(false)
                                  setMode('detail')
                                }}
                                onReturnLive={returnLive}
                                onFocus={() => setMode('detail')}
                                onToggleSection={toggleSection}
                                rowNumber={selectedIndex() + 1}
                                sectionOpen={sectionOpen}
                                width={Math.max(10, dims().width - (wide() ? listWidth() : 0) - 6)}
                              />
                            }
                          >
                            <AgentSteer id={node().item.id} onPending={setSteerPending} steer={props.onSteerAgent} />
                          </Show>
                        }
                      >
                        <scrollbox
                          ref={scroll => {
                            detailScroll = scroll
                            scroll.focusable = false
                          }}
                          flexGrow={1}
                          minHeight={0}
                          scrollX={false}
                        >
                          <AgentTail
                            id={node().item.id}
                            load={props.onLoadTail}
                            onUpdate={() => detailScroll?.scrollTo(Number.MAX_SAFE_INTEGER)}
                          />
                        </scrollbox>
                      </Show>
                    )}
                  </Show>
                </box>
              </box>
            </Show>

            <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
              <Show when={visibleFlash()}>
                {message => (
                  <text fg={theme().color.accent} wrapMode="none">
                    {truncRight(message(), Math.max(8, dims().width - 4))}
                  </text>
                )}
              </Show>
              <text fg={theme().color.muted} wrapMode="none">
                {showKeys()
                  ? '↑↓ scroll keys · Esc back · q close'
                  : mode() === 'list'
                    ? listFooter()
                    : mode() === 'steer'
                      ? 'Enter queue · Esc back · main composer draft preserved'
                      : detailFooter()}
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
