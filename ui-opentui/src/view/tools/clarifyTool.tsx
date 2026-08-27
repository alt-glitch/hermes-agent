/**
 * ClarifyTool — renderer for `clarify` (feedback item 4: "c'mon lol i see
 * output in json xD" — the settled clarify part rendered its raw JSON result,
 * a north-star violation).
 *
 * Wire shapes (verified live + tools/clarify_tool.py):
 *   single → args   {"question": "…", "choices": ["…"]?}
 *            result {"question": "…", "choices_offered": ["…"]|null, "user_response": "…"}
 *   batch  → result {"responses": [{"question": "…", "choices_offered": ["…"]|null,
 *                                   "user_response": "…"|["…"]}, …],
 *                    "timed_out": true?}
 * A batch row's empty user_response is a deliberate skip (rendered as such);
 * the top-level timed_out flag marks blanks as the user walking away instead.
 * Multi-select answers arrive as string arrays — joined for display.
 *
 * Collapsed: compact `question: answer` (single) / answered-count (batch).
 * Expanded (the user's sketch):
 *   User answered:
 *   · <question>: <answer>
 * One `·` line per Q/A. NEVER JSON: when no Q/A can be extracted there is no
 * body (header only).
 */
import { createMemo, For, Show } from 'solid-js'

import type { ToolPartState } from '../../logic/store.ts'
import { truncate } from '../../logic/toolOutput.ts'
import { useTheme } from '../theme.tsx'
import { defaultSubtitle, structuredResult } from './defaultTool.tsx'
import type { ToolBodyProps, ToolRenderer } from './registry.tsx'

export interface ClarifyQA {
  question: string
  /** Empty string = the user skipped this question (batch only). */
  answer: string
}

/** Normalize one user_response: multi-select arrays join to a readable list. */
function answerText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean)
      .join(', ')
  }
  return ''
}

/** The Q/A pairs from the settled result: every batch row (skips included, so
 *  the record stays complete), or the single pair, else []. */
export function clarifyQA(part: ToolPartState): ClarifyQA[] {
  const r = structuredResult(part)
  if (!r) return []
  const responses = r['responses']
  if (Array.isArray(responses)) {
    return responses.flatMap(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return []
      const record = row as Record<string, unknown>
      const question = typeof record['question'] === 'string' ? record['question'].trim() : ''
      return question ? [{ answer: answerText(record['user_response']), question }] : []
    })
  }
  const question = typeof r['question'] === 'string' ? r['question'].trim() : ''
  const answer = typeof r['user_response'] === 'string' ? r['user_response'].trim() : ''
  if (!question || !answer) return []
  return [{ answer, question }]
}

/** True when the settled batch result carries the timed_out marker (blank
 *  answers are the user walking away, not deliberate skips). */
export function clarifyTimedOut(part: ToolPartState): boolean {
  return structuredResult(part)?.['timed_out'] === true
}

/** True for the batch result shape (empty answers stay visible as skips). */
function isBatchResult(part: ToolPartState): boolean {
  return Array.isArray(structuredResult(part)?.['responses'])
}

const qaLine = (pair: ClarifyQA): string => `· ${pair.question}: ${pair.answer || '(skipped)'}`

/** Expanded body: `User answered:` + one `· question: answer` row per pair. */
export function ClarifyToolBody(props: ToolBodyProps) {
  const theme = useTheme()
  const qa = createMemo(() => clarifyQA(props.part))
  return (
    <Show when={qa().length > 0}>
      <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        {/* section label — chrome, not content */}
        <text selectable={false}>
          <span style={{ fg: theme().color.label }}>User answered:</span>
        </text>
        <For each={qa()}>
          {pair => (
            <text selectionBg={theme().color.selectionBg}>
              <span style={{ fg: theme().color.muted }}>{'· '}</span>
              <span style={{ fg: pair.answer ? theme().color.text : theme().color.muted }}>
                {truncate(`${pair.question}: ${pair.answer || '(skipped)'}`, Math.max(1, props.width - 2))}
              </span>
            </text>
          )}
        </For>
        <Show when={clarifyTimedOut(props.part)}>
          <text selectable={false}>
            <span style={{ fg: theme().color.muted, italic: true }}>(timed out)</span>
          </text>
        </Show>
      </box>
    </Show>
  )
}

export const clarifyRenderer: ToolRenderer = {
  Body: ClarifyToolBody,
  // Only the extracted Q/A is worth expanding — never the JSON result.
  expandable: part => clarifyQA(part).length > 0,
  // Honest "(N lines)": label + one row per pair (+ the timed-out marker).
  lines: part => {
    const qa = clarifyQA(part)
    if (qa.length === 0) return []
    return ['User answered:', ...qa.map(qaLine), ...(clarifyTimedOut(part) ? ['(timed out)'] : [])]
  },
  // Collapsed: compact `question: answer` once settled (single) / the batch
  // answered-count; the question while running.
  subtitle: part => {
    const qa = clarifyQA(part)
    if (isBatchResult(part) && qa.length > 0) {
      const answered = qa.filter(pair => pair.answer !== '').length
      return `${answered}/${qa.length} answered${clarifyTimedOut(part) ? ' · timed out' : ''}`
    }
    const first = qa[0]
    if (first) return `${first.question}: ${first.answer}`.replace(/\s+/g, ' ').trim()
    return defaultSubtitle(part)
  }
}
