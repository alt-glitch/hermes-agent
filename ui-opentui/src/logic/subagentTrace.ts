import type { SubagentInfo, TraceEntry } from './store.ts'

export const SUBAGENT_TRACE_LIMIT = 200
export const SUBAGENT_TRACE_TEXT_LIMIT = 65_536
export const SUBAGENT_SUMMARY_LIMIT = 32_768

export function appendSubagentTrace(agent: SubagentInfo, kind: TraceEntry['kind'], text: string): void {
  const id = agent.traceSequence ?? 0
  agent.traceSequence = id + 1
  ;(agent.trace ??= []).push({ id, kind, text })
}

/** Reconcile only the current reply; identical earlier messages are independent. */
export function finishSubagentTrace(agent: SubagentInfo, summary: string): void {
  const last = agent.trace?.at(-1)
  if (last?.kind === 'reply' && (summary.startsWith(last.text) || (last.truncated && summary.endsWith(last.text)))) {
    last.text = summary
    delete last.truncated
  } else if (last?.kind !== 'summary' || last.text !== summary) {
    appendSubagentTrace(agent, 'summary', summary)
  }
}

/** Bound bodies as well as entry count, keeping the latest context and its IDs. */
export function trimSubagentTrace(agent: SubagentInfo): void {
  const trace = agent.trace ?? []
  let remaining = SUBAGENT_TRACE_TEXT_LIMIT
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const entry = trace[index]
    if (entry === undefined) continue
    if (remaining === 0 || trace.length - index > SUBAGENT_TRACE_LIMIT) {
      agent.traceDropped = (agent.traceDropped ?? 0) + index + 1
      agent.traceTruncated = true
      trace.splice(0, index + 1)
      break
    }
    if (entry.text.length > remaining) {
      entry.text = entry.text.slice(-remaining)
      entry.truncated = true
      agent.traceTruncated = true
    }
    remaining -= entry.text.length
  }
  if (agent.summary !== undefined && agent.summary.length > SUBAGENT_SUMMARY_LIMIT) {
    agent.summary = agent.summary.slice(-SUBAGENT_SUMMARY_LIMIT)
    agent.traceTruncated = true
  }
}
