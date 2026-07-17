import type { ScrollBoxRenderable } from '@opentui/core'
import { createMemo, For, Show, type JSX } from 'solid-js'

import type { DelegationPressure, DelegationState } from '../../../logic/agentStatus.ts'
import type { SpawnDiffResult, SpawnSnapshot } from '../../../logic/spawnHistory.ts'
import {
  fmtCost,
  fmtDuration,
  fmtTokens,
  hotnessBucket,
  normalizeSubagentStatus,
  type SubagentAggregate,
  type SubagentNode
} from '../../../logic/subagentTree.ts'
import type { Theme } from '../../../logic/theme.ts'
import { truncRight } from '../../../logic/truncate.ts'
import { useTheme } from '../../theme.tsx'
import type { DashboardAgent, DashboardOutputEntry } from './model.ts'
import { snapshotDashboardAgents } from './model.ts'

interface StatusVisual {
  readonly color: string
  readonly glyph: string
}

function statusVisual(status: string, theme: Theme): StatusVisual {
  switch (normalizeSubagentStatus(status)) {
    case 'running':
      return { color: theme.color.accent, glyph: '●' }
    case 'queued':
      return { color: theme.color.muted, glyph: '○' }
    case 'completed':
      return { color: theme.color.statusGood, glyph: '✓' }
    case 'interrupted':
      return { color: theme.color.warn, glyph: '■' }
    case 'failed':
      return { color: theme.color.error, glyph: '✗' }
    case 'timeout':
      return { color: theme.color.warn, glyph: '⌛' }
    case 'error':
      return { color: theme.color.error, glyph: '⚠' }
  }
}

function rowId(index: number): string {
  return String(index + 1).padStart(2, ' ')
}

function elapsedSeconds(agent: DashboardAgent, nowMs: number): number | undefined {
  if (agent.durationSeconds !== undefined) return Math.max(0, agent.durationSeconds)
  if (agent.startedAt === undefined) return undefined
  const status = normalizeSubagentStatus(agent.status)
  return status === 'running' || status === 'queued' ? Math.max(0, (nowMs - agent.startedAt) / 1000) : undefined
}

export function AgentListRow(props: {
  readonly active: boolean
  readonly absoluteIndex: number
  readonly node: SubagentNode<DashboardAgent>
  readonly onSelect: () => void
  readonly peak: number
  readonly width: number
}) {
  const theme = useTheme()
  const visual = createMemo(() => statusVisual(props.node.item.status, theme()))
  const heat = createMemo(() => {
    const palette = [
      theme().color.border,
      theme().color.accent,
      theme().color.primary,
      theme().color.warn,
      theme().color.error
    ]
    const bucket = hotnessBucket(props.node.aggregate.hotness, props.peak, palette.length)
    return bucket >= 2 ? palette[bucket] : undefined
  })
  const line = createMemo(() => props.node.item.tools?.at(-1) ?? props.node.item.lastTool)
  const toolShort = createMemo(() => {
    const value = line()
    if (!value) return ''
    const paren = value.indexOf('(')
    return truncRight((paren > 0 ? value.slice(0, paren) : value).trim(), 14)
  })
  const goalBudget = createMemo(() => Math.max(8, props.width - 30 - props.node.item.depth * 2))
  const tools = createMemo(() =>
    props.node.aggregate.totalTools > 0 ? ` ·${String(props.node.aggregate.totalTools)}t` : ''
  )
  const kids = createMemo(() => (props.node.children.length > 0 ? ` ·${String(props.node.children.length)}↓` : ''))

  return (
    <text
      bg={props.active ? theme().color.selectionBg : 'transparent'}
      fg={props.active ? theme().color.accent : theme().color.text}
      onMouseDown={props.onSelect}
      wrapMode="none"
    >
      <span style={{ fg: props.active ? theme().color.accent : theme().color.muted }}>
        {' '}
        {rowId(props.absoluteIndex)}{' '}
      </span>
      <span style={{ fg: theme().color.muted }}>{'  '.repeat(Math.max(0, props.node.item.depth))}</span>
      <Show when={heat()}>{color => <span style={{ fg: color() }}>▍</span>}</Show>
      <span style={{ fg: props.active ? theme().color.accent : visual().color }}>{visual().glyph} </span>
      <span style={{ fg: props.active ? theme().color.accent : theme().color.text }}>
        {truncRight(props.node.item.goal || 'subagent', goalBudget())}
      </span>
      <span style={{ fg: props.active ? theme().color.accent : theme().color.muted }}>
        {tools()}
        {kids()}
        {toolShort() ? ` · ${toolShort()}` : ''}
      </span>
    </text>
  )
}

interface TimelineSpan {
  readonly endAt: number
  readonly node: SubagentNode<DashboardAgent>
  readonly startAt: number
}

export function AgentsTimeline(props: {
  readonly maxRows: number
  readonly nodes: readonly SubagentNode<DashboardAgent>[]
  readonly nowMs: number
  readonly selectedId: string | undefined
  readonly width: number
}) {
  const theme = useTheme()
  const spans = createMemo<readonly TimelineSpan[]>(() =>
    props.nodes.flatMap(node => {
      const startAt = node.item.startedAt
      if (startAt === undefined) return []
      const endAt =
        node.item.durationSeconds === undefined ? props.nowMs : startAt + Math.max(0, node.item.durationSeconds) * 1000
      return endAt < startAt ? [] : [{ endAt, node, startAt }]
    })
  )
  const globalStart = createMemo(() => Math.min(...spans().map(span => span.startAt)))
  const globalEnd = createMemo(() => Math.max(...spans().map(span => span.endAt)))
  const totalSpan = createMemo(() => Math.max(1, globalEnd() - globalStart()))
  const barWidth = createMemo(() => Math.max(10, props.width - 18))
  const selectedSpanIndex = createMemo(() => {
    const selected = props.selectedId
    const index = selected === undefined ? -1 : spans().findIndex(span => span.node.item.id === selected)
    return index < 0 ? 0 : index
  })
  const windowStart = createMemo(() =>
    Math.max(
      0,
      Math.min(
        Math.max(0, spans().length - props.maxRows),
        selectedSpanIndex() - Math.floor(Math.max(1, props.maxRows) / 2)
      )
    )
  )
  const shown = createMemo(() => spans().slice(windowStart(), windowStart() + Math.max(1, props.maxRows)))
  const duration = createMemo(() => Math.max(0, (globalEnd() - globalStart()) / 1000))
  const lane = (span: TimelineSpan, endGlyph: string): string => {
    const width = barWidth()
    const start = Math.min(width - 1, Math.floor(((span.startAt - globalStart()) / totalSpan()) * (width - 1)))
    const end = Math.max(
      start,
      Math.min(width - 1, Math.ceil(((span.endAt - globalStart()) / totalSpan()) * (width - 1)))
    )
    const chars = Array.from({ length: width }, () => ' ')
    if (start === end) {
      chars[start] = endGlyph
      return chars.join('')
    }
    chars[start] = '╺'
    for (let column = start + 1; column < end; column += 1) chars[column] = '━'
    chars[end] = endGlyph
    return chars.join('')
  }
  const ruler = createMemo(() =>
    Array.from({ length: barWidth() }, (_, column) => {
      if (column > 0 && column % 10 === 0) return '┼'
      if (column > 0 && column % 5 === 0) return '·'
      return '─'
    }).join('')
  )
  const rulerLabels = createMemo(() => {
    if (duration() <= 0) return ''
    const width = barWidth()
    const step = duration() < 20 && width > 20 ? 5 : 10
    const chars = Array.from({ length: width }, () => ' ')
    for (let column = 0; column < width; column += step) {
      const seconds = (column / Math.max(1, width - 1)) * duration()
      const label = column === 0 ? '0' : seconds >= 1 ? `${String(Math.round(seconds))}s` : `${seconds.toFixed(1)}s`
      for (let offset = 0; offset < label.length && column + offset < width; offset += 1) {
        chars[column + offset] = label[offset] ?? ' '
      }
    }
    return chars.join('')
  })

  return (
    <Show when={spans().length > 0}>
      <box style={{ flexDirection: 'column', flexShrink: 0, marginBottom: 1 }}>
        <text fg={theme().color.muted} wrapMode="none">
          Timeline · {fmtDuration(duration())}
          {spans().length > props.maxRows
            ? ` · ${String(windowStart() + 1)}-${String(Math.min(spans().length, windowStart() + props.maxRows))}/${String(spans().length)}`
            : ''}
        </text>
        <For each={shown()}>
          {span => {
            const active = () => span.node.item.id === props.selectedId
            const visual = () => statusVisual(span.node.item.status, theme())
            const elapsed = () => elapsedSeconds(span.node.item, props.nowMs)
            return (
              <text wrapMode="none">
                <span style={{ fg: active() ? theme().color.accent : theme().color.muted }}>
                  {rowId(props.nodes.findIndex(node => node.item.id === span.node.item.id))}
                  {'  '}
                </span>
                <span style={{ fg: active() ? theme().color.accent : visual().color }}>
                  {lane(span, visual().glyph)}
                </span>
                <span style={{ fg: theme().color.muted }}>
                  {elapsed() === undefined ? '' : `  ${fmtDuration(elapsed() ?? 0)}`}
                </span>
              </text>
            )
          }}
        </For>
        <text fg={theme().color.muted} wrapMode="none">
          {'    '}
          {ruler()}
        </text>
        <Show when={rulerLabels()}>
          {labels => (
            <text fg={theme().color.muted} wrapMode="none">
              {'    '}
              {labels()}
            </text>
          )}
        </Show>
      </box>
    </Show>
  )
}

function Field(props: { readonly name: string; readonly value: string; readonly width: number }) {
  const theme = useTheme()
  const budget = () => Math.max(8, props.width - props.name.length - 5)
  return (
    <text wrapMode="none">
      <span style={{ fg: theme().color.label }}>{props.name} · </span>
      <span style={{ fg: theme().color.text }}>{truncRight(props.value, budget())}</span>
    </text>
  )
}

function Section(props: {
  readonly children: JSX.Element
  readonly count?: number
  readonly onToggle: () => void
  readonly open: boolean
  readonly title: string
}) {
  const theme = useTheme()
  return (
    <box style={{ flexDirection: 'column', marginTop: 1 }}>
      <text fg={theme().color.label} onMouseDown={props.onToggle} wrapMode="none">
        <span style={{ fg: theme().color.accent }}>{props.open ? '▾ ' : '▸ '}</span>
        {props.title}
        {props.count === undefined ? '' : ` (${String(props.count)})`}
      </text>
      <Show when={props.open}>{props.children}</Show>
    </box>
  )
}

function ToolLines(props: { readonly agent: DashboardAgent }): readonly string[] {
  if ((props.agent.tools?.length ?? 0) > 0) return props.agent.tools ?? []
  return (props.agent.outputTail ?? []).map(entry => entry.tool).filter(Boolean)
}

function OutputLine(props: { readonly entry: DashboardOutputEntry }) {
  const theme = useTheme()
  return (
    <text fg={props.entry.isError ? theme().color.error : theme().color.text} wrapMode="word">
      <span style={{ fg: props.entry.isError ? theme().color.error : theme().color.accent }}>{props.entry.tool}</span>{' '}
      {props.entry.preview}
    </text>
  )
}

export function AgentDetail(props: {
  readonly bindScroll: (scroll: ScrollBoxRenderable) => void
  readonly node: SubagentNode<DashboardAgent>
  readonly onToggleSection: (title: string) => void
  readonly rowNumber: number
  readonly sectionOpen: (title: string, defaultOpen: boolean) => boolean
  readonly width: number
}) {
  const theme = useTheme()
  const agent = () => props.node.item
  const visual = () => statusVisual(agent().status, theme())
  const inputTokens = () => agent().inputTokens ?? 0
  const outputTokens = () => agent().outputTokens ?? 0
  const localTokens = () => inputTokens() + outputTokens()
  const subtreeTokens = () => props.node.aggregate.inputTokens + props.node.aggregate.outputTokens - localTokens()
  const filesRead = () => agent().filesRead ?? []
  const filesWritten = () => agent().filesWritten ?? []
  const outputTail = () => agent().outputTail ?? []
  const tools = () => ToolLines({ agent: agent() })
  const progress = () => agent().notes ?? []
  const latestThought = () => agent().thought ?? agent().thinking?.at(-1)
  const trace = () => agent().trace ?? []
  const filesOverflow = () => Math.max(0, filesRead().length - 8) + Math.max(0, filesWritten().length - 8)

  return (
    <scrollbox ref={props.bindScroll} style={{ flexGrow: 1, minHeight: 0, paddingBottom: 3, paddingRight: 1 }}>
      <text fg={theme().color.text} wrapMode="word">
        <span style={{ fg: theme().color.accent }}>#{String(props.rowNumber)} </span>
        <span style={{ fg: visual().color }}>{visual().glyph} </span>
        <b>{agent().goal}</b>
      </text>

      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        <Field
          name="depth"
          value={`${String(agent().depth)} · ${normalizeSubagentStatus(agent().status)}`}
          width={props.width}
        />
        <Show when={agent().model}>{model => <Field name="model" value={model()} width={props.width} />}</Show>
        <Show when={(agent().toolsets?.length ?? 0) > 0}>
          <Field name="toolsets" value={(agent().toolsets ?? []).join(', ')} width={props.width} />
        </Show>
        <Field
          name="tools"
          value={`${String(agent().toolCount ?? 0)} (subtree ${String(props.node.aggregate.totalTools)})`}
          width={props.width}
        />
        <Field
          name="subtree"
          value={`${String(props.node.aggregate.descendantCount)} agent${props.node.aggregate.descendantCount === 1 ? '' : 's'} · d${String(props.node.aggregate.maxDepthFromHere)} · ⚡${String(props.node.aggregate.activeCount)}`}
          width={props.width}
        />
        <Show when={agent().durationSeconds !== undefined}>
          <Field name="elapsed" value={fmtDuration(agent().durationSeconds ?? 0)} width={props.width} />
        </Show>
        <Show when={agent().iteration !== undefined}>
          <Field name="iteration" value={String(agent().iteration)} width={props.width} />
        </Show>
        <Show when={agent().apiCalls !== undefined}>
          <Field name="api calls" value={String(agent().apiCalls)} width={props.width} />
        </Show>
        <Show when={latestThought()}>{thought => <Field name="thinking" value={thought()} width={props.width} />}</Show>
      </box>

      <Show when={localTokens() > 0 || (agent().costUsd ?? 0) > 0}>
        <Section
          open={props.sectionOpen('Budget', true)}
          onToggle={() => props.onToggleSection('Budget')}
          title="Budget"
        >
          <Field
            name="tokens"
            value={`${fmtTokens(inputTokens())} in · ${fmtTokens(outputTokens())} out${(agent().reasoningTokens ?? 0) > 0 ? ` · ${fmtTokens(agent().reasoningTokens ?? 0)} reasoning` : ''}`}
            width={props.width}
          />
          <Show when={subtreeTokens() > 0}>
            <Field name="subtree tokens" value={`+${fmtTokens(subtreeTokens())}`} width={props.width} />
          </Show>
          <Show when={(agent().costUsd ?? 0) > 0}>
            <Field name="cost" value={fmtCost(agent().costUsd ?? 0)} width={props.width} />
          </Show>
        </Section>
      </Show>

      <Show when={filesRead().length + filesWritten().length > 0}>
        <Section
          count={filesRead().length + filesWritten().length}
          open={props.sectionOpen('Files', false)}
          onToggle={() => props.onToggleSection('Files')}
          title="Files"
        >
          <For each={filesWritten().slice(0, 8)}>
            {path => (
              <text fg={theme().color.statusGood} wrapMode="none">
                +{truncRight(path, Math.max(8, props.width - 3))}
              </text>
            )}
          </For>
          <For each={filesRead().slice(0, 8)}>
            {path => (
              <text fg={theme().color.text} wrapMode="none">
                <span style={{ fg: theme().color.muted }}>· </span>
                {truncRight(path, Math.max(8, props.width - 3))}
              </text>
            )}
          </For>
          <Show when={filesOverflow() > 0}>
            <text fg={theme().color.muted}>…+{String(filesOverflow())} more</text>
          </Show>
        </Section>
      </Show>

      <Show when={tools().length > 0}>
        <Section
          count={tools().length}
          open={props.sectionOpen('Tool calls', true)}
          onToggle={() => props.onToggleSection('Tool calls')}
          title="Tool calls"
        >
          <For each={tools().slice(-16)}>
            {line => (
              <text fg={theme().color.text} wrapMode="word">
                <span style={{ fg: theme().color.muted }}>· </span>
                {line}
              </text>
            )}
          </For>
          <Show when={tools().length > 16}>
            <text fg={theme().color.muted}>…{String(tools().length - 16)} earlier calls hidden</text>
          </Show>
        </Section>
      </Show>

      <Show when={outputTail().length > 0}>
        <Section
          count={outputTail().length}
          open={props.sectionOpen('Output', true)}
          onToggle={() => props.onToggleSection('Output')}
          title="Output"
        >
          <For each={outputTail().slice(-8)}>{entry => <OutputLine entry={entry} />}</For>
          <Show when={outputTail().length > 8}>
            <text fg={theme().color.muted}>…{String(outputTail().length - 8)} earlier outputs hidden</text>
          </Show>
        </Section>
      </Show>

      <Show when={trace().length > 0}>
        <Section
          count={trace().length}
          open={props.sectionOpen('Live trace', true)}
          onToggle={() => props.onToggleSection('Live trace')}
          title="Live trace"
        >
          <For each={trace().slice(-20)}>
            {entry => {
              const glyph =
                entry.kind === 'tool'
                  ? '⚡'
                  : entry.kind === 'summary'
                    ? '✓'
                    : entry.kind === 'start'
                      ? '▶'
                      : entry.kind === 'reply'
                        ? '❯'
                        : '·'
              const color =
                entry.kind === 'tool'
                  ? theme().color.accent
                  : entry.kind === 'summary'
                    ? theme().color.ok
                    : entry.kind === 'start'
                      ? theme().color.label
                      : entry.kind === 'reply'
                        ? theme().color.text
                        : theme().color.muted
              return (
                <text
                  fg={entry.kind === 'summary' || entry.kind === 'reply' ? theme().color.text : theme().color.muted}
                  wrapMode="word"
                >
                  <span style={{ fg: color }}>{glyph} </span>
                  {entry.text}
                </text>
              )
            }}
          </For>
          <Show when={trace().length > 20}>
            <text fg={theme().color.muted}>…{String(trace().length - 20)} earlier events hidden</text>
          </Show>
        </Section>
      </Show>

      <Show when={progress().length > 0}>
        <Section
          count={progress().length}
          open={props.sectionOpen('Progress', false)}
          onToggle={() => props.onToggleSection('Progress')}
          title="Progress"
        >
          <For each={progress().slice(-6)}>
            {line => (
              <text fg={theme().color.text} wrapMode="word">
                <span style={{ fg: theme().color.label }}>· </span>
                {line}
              </text>
            )}
          </For>
        </Section>
      </Show>

      <Show when={agent().summary}>
        {summary => (
          <Section
            open={props.sectionOpen('Summary', true)}
            onToggle={() => props.onToggleSection('Summary')}
            title="Summary"
          >
            <text fg={theme().color.text} wrapMode="word">
              {summary()}
            </text>
          </Section>
        )}
      </Show>
    </scrollbox>
  )
}

function metricDelta(name: string, before: number, after: number, format: (value: number) => string): string {
  const delta = after - before
  const sign = delta === 0 ? '' : delta > 0 ? '+' : '-'
  return `${name}: ${format(before)} → ${format(after)} (${sign}${format(Math.abs(delta)) || '0'})`
}

function SnapshotPane(props: {
  readonly label: string
  readonly snapshot: SpawnSnapshot
  readonly totals: SubagentAggregate
  readonly width: number
}) {
  const theme = useTheme()
  const agents = createMemo(() => snapshotDashboardAgents(props.snapshot))
  const top = createMemo(() => {
    const known = new Set(agents().map(agent => agent.id))
    return agents()
      .filter(agent => !agent.parentId || !known.has(agent.parentId))
      .slice(0, 6)
  })
  return (
    <box style={{ flexDirection: 'column', minWidth: 0, width: props.width }}>
      <text fg={theme().color.text}>
        <b>{props.label}</b>
      </text>
      <text fg={theme().color.muted} wrapMode="none">
        {truncRight(props.snapshot.label, Math.max(8, props.width - 1))}
      </text>
      <text fg={theme().color.muted} wrapMode="none">
        {truncRight(
          `d${String(props.totals.maxDepthFromHere)} · ${String(props.totals.descendantCount)} agents · ${String(props.totals.totalTools)} tools · ${fmtDuration(props.totals.totalDuration)}`,
          Math.max(8, props.width - 1)
        )}
      </text>
      <For each={top()}>
        {agent => {
          const visual = () => statusVisual(agent.status, theme())
          return (
            <text fg={theme().color.muted} wrapMode="none">
              <span style={{ fg: visual().color }}>{visual().glyph} </span>
              {truncRight(agent.goal, Math.max(8, props.width - 3))}
            </text>
          )
        }}
      </For>
    </box>
  )
}

export function AgentsDiffView(props: {
  readonly baseline: SpawnSnapshot
  readonly candidate: SpawnSnapshot
  readonly diff: SpawnDiffResult
  readonly totalsA: SubagentAggregate
  readonly totalsB: SubagentAggregate
  readonly width: number
}) {
  const theme = useTheme()
  const wide = () => props.width >= 84
  const paneWidth = () => (wide() ? Math.max(30, Math.floor((props.width - 6) / 2)) : Math.max(30, props.width - 4))
  const rounded = (value: number) => String(Math.round(value))
  const tokenSum = (value: SubagentAggregate) => value.inputTokens + value.outputTokens
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingLeft: 1, paddingRight: 1 }}>
      <text fg={theme().color.border}>
        <b>Replay diff</b>
      </text>
      <text fg={theme().color.muted}>baseline vs candidate · Esc/q close</text>
      <box style={{ flexDirection: wide() ? 'row' : 'column', flexShrink: 0, marginTop: 1 }}>
        <SnapshotPane label="A · baseline" snapshot={props.baseline} totals={props.totalsA} width={paneWidth()} />
        <box style={wide() ? { width: 2 } : { height: 1 }} />
        <SnapshotPane label="B · candidate" snapshot={props.candidate} totals={props.totalsB} width={paneWidth()} />
      </box>
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        <text fg={theme().color.accent}>
          <b>Δ</b>
        </text>
        <text fg={theme().color.text}>
          {metricDelta('agents', props.totalsA.descendantCount, props.totalsB.descendantCount, rounded)}
        </text>
        <text fg={theme().color.text}>
          {metricDelta('tools', props.totalsA.totalTools, props.totalsB.totalTools, rounded)}
        </text>
        <text fg={theme().color.text}>
          {metricDelta('depth', props.totalsA.maxDepthFromHere, props.totalsB.maxDepthFromHere, rounded)}
        </text>
        <text fg={theme().color.text}>
          {metricDelta(
            'duration',
            props.totalsA.totalDuration,
            props.totalsB.totalDuration,
            value => `${value.toFixed(1)}s`
          )}
        </text>
        <text fg={theme().color.text}>
          {metricDelta('tokens', tokenSum(props.totalsA), tokenSum(props.totalsB), fmtTokens)}
        </text>
        <text fg={theme().color.muted}>
          agents · +{String(props.diff.added.length)} / −{String(props.diff.removed.length)} / Δ
          {String(props.diff.changed.length)}
        </text>
      </box>
    </box>
  )
}

export function DelegationSummary(props: {
  readonly delegation: DelegationState
  readonly pressure: DelegationPressure
}) {
  const theme = useTheme()
  const color = () =>
    props.pressure.level === 'error'
      ? theme().color.error
      : props.pressure.level === 'warn'
        ? theme().color.warn
        : theme().color.muted
  return (
    <Show when={props.delegation.maxSpawnDepth !== null || props.delegation.paused}>
      <span style={{ fg: color() }}>
        {props.delegation.paused ? '⏸ paused · ' : ''}caps d{String(props.delegation.maxSpawnDepth ?? '?')}/
        {String(props.delegation.maxConcurrentChildren ?? '?')}
      </span>
    </Show>
  )
}
