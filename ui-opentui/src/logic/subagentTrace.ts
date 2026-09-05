import type { SubagentInfo, TraceEntry } from './store.ts'

export const SUBAGENT_TRACE_LIMIT = 200
export const SUBAGENT_TRACE_TEXT_LIMIT = 65_536
export const SUBAGENT_SUMMARY_LIMIT = 32_768

function retainedTail(text: string, limit: number): string {
  let start = Math.max(0, text.length - limit)
  const code = text.charCodeAt(start)
  // Never leave half a supplementary character at the retention boundary.
  if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start += 1
  return text.slice(start)
}

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
      entry.text = retainedTail(entry.text, remaining)
      entry.truncated = true
      agent.traceTruncated = true
      const dropped = index + (entry.text.length === 0 ? 1 : 0)
      agent.traceDropped = (agent.traceDropped ?? 0) + dropped
      trace.splice(0, dropped)
      break
    }
    remaining -= entry.text.length
  }
  if (agent.summary !== undefined && agent.summary.length > SUBAGENT_SUMMARY_LIMIT) {
    agent.summary = retainedTail(agent.summary, SUBAGENT_SUMMARY_LIMIT)
    agent.traceTruncated = true
  }
}
