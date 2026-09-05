import { createMemo, For, Show } from 'solid-js'

import { Markdown } from '../../markdown.tsx'
import { useTheme } from '../../theme.tsx'
import type { DashboardAgent } from './model.ts'

/** Completion is an authoritative final reply, not a second summary panel.
 * Only the last reply can duplicate it: equal earlier messages remain ordered. */
export function agentMessages(agent: DashboardAgent) {
  const trace = agent.trace ?? []
  const entries = trace.flatMap((entry, index) =>
    entry.kind === 'reply' || entry.kind === 'reasoning'
      ? [
          {
            entry,
            key:
              entry.id === undefined
                ? `${agent.id}:legacy:${String((agent.traceDropped ?? 0) + index)}`
                : `${agent.id}:entry:${String(entry.id)}`
          }
        ]
      : []
  )
  const replies = entries.filter(message => message.entry.kind === 'reply')
  const summary = trace.findLast(entry => entry.kind === 'summary')?.text || agent.summary
  const lastReply = replies.at(-1)
  const represented =
    summary !== undefined &&
    (lastReply?.entry.text.trim().startsWith(summary.trim()) === true ||
      (agent.traceTruncated === true && lastReply?.entry.text.endsWith(summary) === true))
  const appendSummary = Boolean(summary?.trim() && !represented)
  return { appendSummary, entries, replies, summary }
}

export function AgentMessages(props: {
  readonly agent: DashboardAgent
  readonly replay: boolean
  readonly reasoningOpen: boolean
  readonly onToggleReasoning: () => void
}) {
  const theme = useTheme()
  const messages = createMemo(() => agentMessages(props.agent))
  const byKey = createMemo(() => new Map(messages().entries.map(message => [message.key, message.entry])))
  const keys = createMemo(() => messages().entries.map(message => message.key))
  const streaming = () => !props.replay && ['running', 'queued'].includes(props.agent.status)
  return (
    <box id="agent-messages" flexDirection="column" flexShrink={0} minWidth={0}>
      <text fg={theme().color.label}>Messages</text>
      <Show when={(props.agent.traceDropped ?? 0) > 0 || props.agent.traceTruncated}>
        <text fg={theme().color.warn}>
          Earlier content unavailable · {String(props.agent.traceDropped ?? 0)} events omitted
          {props.agent.traceTruncated ? ' · retained text truncated' : ''}
        </text>
      </Show>
      <For each={keys()}>
        {key => (
          <Show when={byKey().get(key)}>
            {entry => (
              <box flexDirection="column" flexShrink={0} minWidth={0} marginTop={1}>
                <Show
                  when={entry().kind === 'reasoning'}
                  fallback={
                    <>
                      <text fg={theme().color.muted}>
                        ❯ {entry() === props.agent.trace?.at(-1) && streaming() ? 'Assistant · streaming' : 'Assistant'}
                      </text>
                      <Markdown text={entry().text} streaming={streaming() && entry() === props.agent.trace?.at(-1)} />
                    </>
                  }
                >
                  <text fg={theme().color.label} onMouseDown={props.onToggleReasoning}>
                    {props.reasoningOpen ? '▾' : '▸'} Reasoning · model-provided · r to toggle
                  </text>
                  <Show when={props.reasoningOpen}>
                    <Markdown
                      text={entry().text}
                      fg={theme().color.muted}
                      streaming={streaming() && entry() === props.agent.trace?.at(-1)}
                    />
                  </Show>
                </Show>
                <Show when={entry().truncated}>
                  <text fg={theme().color.warn}>Message truncated in retained history.</text>
                </Show>
              </box>
            )}
          </Show>
        )}
      </For>
      <Show when={messages().appendSummary}>
        <box flexDirection="column" flexShrink={0} minWidth={0} marginTop={1}>
          <text fg={theme().color.muted}>❯ Final reply</text>
          <Markdown text={messages().summary ?? ''} />
        </box>
      </Show>
      <Show when={messages().replies.length === 0 && !messages().appendSummary}>
        <text fg={theme().color.muted}>
          {streaming() ? 'Waiting for assistant messages…' : 'No assistant messages retained for this agent.'}
        </text>
      </Show>
    </box>
  )
}
