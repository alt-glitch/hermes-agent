import { createMemo, For, Show } from 'solid-js'
import stringWidth from 'string-width'

import { fmtDuration, normalizeSubagentStatus, type SubagentNode } from '../../../logic/subagentTree.ts'
import { truncRightCells } from '../../../logic/truncate.ts'
import { useTheme } from '../../theme.tsx'
import type { DashboardAgent } from './model.ts'

export function agentEndTime(agent: DashboardAgent, nowMs: number): number | undefined {
  const status = normalizeSubagentStatus(agent.status)
  if (status === 'running' || status === 'queued') return nowMs
  // Completion receipt may be delayed; the backend's measured duration wins.
  if (agent.startedAt !== undefined && agent.durationSeconds !== undefined)
    return agent.startedAt + Math.max(0, agent.durationSeconds) * 1000
  return agent.endedAt
}

export function agentElapsed(agent: DashboardAgent, nowMs: number): number | undefined {
  const end = agentEndTime(agent, nowMs)
  if (end !== undefined && agent.startedAt !== undefined) return Math.max(0, (end - agent.startedAt) / 1000)
  return agent.durationSeconds === undefined ? undefined : Math.max(0, agent.durationSeconds)
}

export function AgentsTimeline(props: {
  readonly maxRows: number
  readonly nodes: readonly SubagentNode<DashboardAgent>[]
  readonly nowMs: number
  readonly selectedId: string | undefined
  readonly width: number
}) {
  const theme = useTheme()
  const byId = createMemo(() => new Map(props.nodes.map(node => [node.item.id, node])))
  const bounds = createMemo(() => {
    const timed = props.nodes.flatMap(({ item }) => {
      const end = agentEndTime(item, props.nowMs)
      return item.startedAt === undefined || end === undefined || end < item.startedAt ? [] : [[item.startedAt, end]]
    })
    const start = Math.min(...timed.map(pair => pair[0] ?? 0))
    const end = Math.max(...timed.map(pair => pair[1] ?? 0))
    return { start, end, span: Math.max(1, end - start) }
  })
  const shown = createMemo(() => {
    const selected = Math.max(
      0,
      props.nodes.findIndex(node => node.item.id === props.selectedId)
    )
    const start = Math.max(0, Math.min(props.nodes.length - props.maxRows, selected - Math.floor(props.maxRows / 2)))
    return props.nodes.slice(start, start + props.maxRows).map(node => node.item.id)
  })
  const labelWidth = () => Math.max(12, Math.min(32, Math.floor(props.width * 0.35)))
  const barWidth = () => Math.max(3, props.width - labelWidth() - 11)
  const label = (agent: DashboardAgent) => {
    const text = truncRightCells(
      `${'  '.repeat(Math.min(4, agent.depth))}${agent.depth > 0 ? '↳ ' : ''}${agent.taskLabel || agent.goal}`,
      labelWidth()
    )
    return text + ' '.repeat(Math.max(0, labelWidth() - stringWidth(text)))
  }
  const lane = (agent: DashboardAgent) => {
    const endAt = agentEndTime(agent, props.nowMs)
    const status = normalizeSubagentStatus(agent.status)
    const glyph = status === 'completed' ? '✓' : status === 'running' || status === 'queued' ? '●' : '✗'
    if (agent.startedAt === undefined || endAt === undefined || endAt < agent.startedAt)
      return `${glyph} timing unknown`
    const width = barWidth()
    const scale = (value: number) =>
      Math.max(0, Math.min(width - 1, Math.round(((value - bounds().start) / bounds().span) * (width - 1))))
    const start = scale(agent.startedAt)
    const end = Math.max(start, scale(endAt))
    return ' '.repeat(start) + (end > start ? '╺' + '━'.repeat(end - start - 1) : '') + glyph
  }
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <text fg={theme().color.label} wrapMode="none">
        Timeline ·{' '}
        {Number.isFinite(bounds().end) ? fmtDuration((bounds().end - bounds().start) / 1000) : 'timing unknown'}
        {props.nodes.length > props.maxRows ? ` · ${String(shown().length)}/${String(props.nodes.length)} lanes` : ''}
      </text>
      <For each={shown()}>
        {id => (
          <Show when={byId().get(id)}>
            {node => (
              <text
                id={`agent-lane-${id}`}
                wrapMode="none"
                fg={id === props.selectedId ? theme().color.accent : theme().color.muted}
              >
                {label(node().item)} {lane(node().item).padEnd(barWidth())}{' '}
                {agentElapsed(node().item, props.nowMs) === undefined
                  ? '?'
                  : fmtDuration(agentElapsed(node().item, props.nowMs) ?? 0)}
              </text>
            )}
          </Show>
        )}
      </For>
      <Show when={Number.isFinite(bounds().end)}>
        <text fg={theme().color.muted} wrapMode="none">
          {' '.repeat(labelWidth() + 1)}0{'─'.repeat(Math.max(0, barWidth() - 2))}┤{' '}
          {fmtDuration((bounds().end - bounds().start) / 1000)}
        </text>
      </Show>
    </box>
  )
}
