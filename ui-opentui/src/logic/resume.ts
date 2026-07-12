/**
 * Resume snapshot mapper (spec §1 lifecycle; gotcha §8 #5). Maps the
 * `session.resume` response `messages` (tui_gateway `_history_to_messages`) into
 * the store's `Message[]`. Each history entry is either `{role, text}` (user/
 * assistant/system) or `{role:'tool', name, context}` (NO text — render it).
 *
 * Tool rows are folded into the PRECEDING assistant turn's ordered `parts[]`
 * (state:'complete', summary=context) so a resumed transcript renders inline like
 * a live one. Resumed assistant text is given a single text part so it renders
 * through the native markdown path. IDs are `r*` (distinct from live `p*`).
 */
import type { Message, Part, SessionItem, ToolPartState } from './store.ts'
import { stripOmittedNote, stripToolEnvelope } from './toolOutput.ts'

function readStr(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = (value as { [k: string]: unknown })[key]
  return typeof v === 'string' ? v : undefined
}

function readContent(value: unknown): string {
  const text = readStr(value, 'text')
  if (text !== undefined) return text
  if (!value || typeof value !== 'object') return ''
  const content = (value as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (typeof part === 'string' ? part : (readStr(part, 'text') ?? '')))
    .filter(Boolean)
    .join('\n')
}

interface RawToolCall {
  readonly name: string
  readonly args?: unknown
}

function rememberToolCalls(raw: unknown, calls: Map<string, RawToolCall>): void {
  if (!raw || typeof raw !== 'object') return
  const toolCalls = (raw as { tool_calls?: unknown }).tool_calls
  if (!Array.isArray(toolCalls)) return
  for (const call of toolCalls) {
    const callId = readStr(call, 'id')
    if (!callId || !call || typeof call !== 'object') continue
    const fn = (call as { function?: unknown }).function
    const name = readStr(fn, 'name')
    if (!name) continue
    const encoded = readStr(fn, 'arguments')
    let args: unknown = encoded
    if (encoded) {
      try {
        args = JSON.parse(encoded)
      } catch {
        args = encoded
      }
    }
    calls.set(callId, { name, args })
  }
}

function readNum(value: unknown, key: string): number {
  if (!value || typeof value !== 'object') return 0
  const v = (value as { [k: string]: unknown })[key]
  return typeof v === 'number' ? v : 0
}

/**
 * Read an OPTIONAL finite numeric field (the per-message `timestamp` key, unix
 * seconds — see SessionPeek.ts `timestamp: opt(Schema.NullOr(Schema.Unknown))`).
 * Returns undefined when absent/null/non-finite so we NEVER fabricate a stamp.
 * (Distinct from `readNum`, which defaults missing → 0 for counts.)
 */
function readOptNum(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = (value as { [k: string]: unknown })[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Map a `session.list` result into switcher rows (loose-typed read). */
export function mapSessionList(result: unknown): SessionItem[] {
  if (!result || typeof result !== 'object') return []
  const sessions = (result as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions)) return []
  const out: SessionItem[] = []
  for (const s of sessions) {
    const id = readStr(s, 'id')
    if (!id) continue
    out.push({
      id,
      messageCount: readNum(s, 'message_count'),
      preview: readStr(s, 'preview') ?? '',
      title: readStr(s, 'title') ?? ''
    })
  }
  return out
}

export function mapResumeHistory(history: unknown): Message[] {
  if (!Array.isArray(history)) return []
  const out: Message[] = []
  let seq = 0
  const id = () => `r${++seq}`
  let currentAssistant: Message | undefined
  const toolCalls = new Map<string, RawToolCall>()

  for (const raw of history) {
    const role = readStr(raw, 'role')
    // Optional stored send/receive time (unix seconds). Carried onto the produced
    // Message so /timestamps can render [HH:MM]; undefined when the entry lacks it.
    const ts = readOptNum(raw, 'timestamp')

    if (role === 'tool') {
      const call = toolCalls.get(readStr(raw, 'tool_call_id') ?? '')
      const name = readStr(raw, 'name') ?? call?.name ?? 'tool'
      const context = readStr(raw, 'context')
      const tool: ToolPartState = { type: 'tool', id: id(), name, state: 'complete' }
      // Match the live tool part exactly (item 1): primary-arg preview in the
      // header, plus the (capped) output so resumed tools are collapsible too.
      if (context) tool.argsPreview = context
      const rawResult = readStr(raw, 'result_text') ?? readContent(raw)
      if (rawResult) {
        const { body, omittedNote } = stripOmittedNote(rawResult)
        const resultText = stripToolEnvelope(body)
        if (resultText) {
          tool.resultText = resultText
          tool.lineCount = resultText.replace(/\s+$/, '').split('\n').length
        }
        if (omittedNote) tool.omittedNote = omittedNote
      }
      const args = (raw as { args?: unknown }).args ?? call?.args
      if (args !== undefined) {
        try {
          tool.argsText = typeof args === 'string' ? args : JSON.stringify(args, null, 2)
        } catch {
          /* unstringifiable — leave unset */
        }
      }
      if (!currentAssistant) {
        currentAssistant = { role: 'assistant', text: '', parts: [] }
        if (ts !== undefined) currentAssistant.timestamp = ts
        out.push(currentAssistant)
      }
      ;(currentAssistant.parts ??= []).push(tool)
      continue
    }

    const text = readContent(raw)
    if (role === 'assistant') {
      rememberToolCalls(raw, toolCalls)
      const parts: Part[] = text ? [{ type: 'text', id: id(), text }] : []
      currentAssistant = { role: 'assistant', text, parts }
      if (ts !== undefined) currentAssistant.timestamp = ts
      out.push(currentAssistant)
    } else if (role === 'user' || role === 'system') {
      const msg: Message = { role, text }
      if (ts !== undefined) msg.timestamp = ts
      out.push(msg)
      currentAssistant = undefined
    }
  }

  return out
}
