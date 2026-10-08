/**
 * Batch (multi-question) clarify — pure helpers shared by the store reducer and
 * the ClarifyPrompt view (Ink parity: ui-tui text.ts clarifyBatchRevisitState /
 * formatAbandonedClarifyBatch + createGatewayEventHandler's entry filter).
 *
 * Wire contract (tui_gateway `_clarify_block`, contracts/server_requests.py):
 *   `clarify` server request → params.questions[{qid, question, choices, multi_select}]
 *   clarify.lock RPC         → {request_id, question_id, answer} locks ONE answer; the
 *                              prompt stays open until every qid is locked. The request's
 *                              JSON-RPC response WITHOUT `answers` cancels the whole batch.
 *
 * A multi_select answer is locked as a raw JSON array string (`["A","B"]`, Ink parity
 * 5eea87882a): the tool parses it back into a list, revisiting restores the picks, and
 * only display lines format it (clarifyAnswerText).
 */

/** One normalized batch question held on the active clarify prompt. */
export interface ClarifyBatchQuestion {
  qid: string
  question: string
  choices: string[] | null
  multiSelect: boolean
}

/** The raw wire shape of one batch entry (contracts/server_requests.py ClarifyQuestion). */
export interface ClarifyBatchQuestionWire {
  readonly qid?: string
  readonly question?: string
  readonly choices?: readonly string[] | null
  readonly multi_select?: boolean
}

/**
 * Filter + normalize the wire question list: entries without a non-blank qid
 * AND question are dropped (Ink parity; the decoder refuses a list with none
 * left). Choices collapse to null when empty.
 */
export function normalizeClarifyQuestions(
  raw: readonly ClarifyBatchQuestionWire[] | undefined
): ClarifyBatchQuestion[] {
  const out: ClarifyBatchQuestion[] = []
  for (const q of raw ?? []) {
    if (typeof q.qid !== 'string' || q.qid === '') continue
    if (typeof q.question !== 'string' || q.question.trim() === '') continue
    out.push({
      choices: q.choices && q.choices.length > 0 ? [...q.choices] : null,
      multiSelect: q.multi_select === true,
      qid: q.qid,
      question: q.question.trim()
    })
  }
  return out
}

/** The replayed locks (`params.answers`, reconnect only) as the local answers map. The wire's null
 *  (skipped) reads as '' — the same empty lock this prompt records for a skip (Ink parity). */
export function lockedClarifyAnswers(
  raw: Readonly<Record<string, string | null>> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [qid, answer] of Object.entries(raw ?? {})) out[qid] = answer ?? ''
  return out
}

/** Qids not yet locked (mirrors the gateway's `remaining` respond field —
 *  completion is exactly "every qid has a locked answer", empty ones included). */
export function remainingClarifyQids(
  questions: readonly ClarifyBatchQuestion[],
  answers: Readonly<Record<string, string>>
): string[] {
  return questions.filter(q => answers[q.qid] === undefined).map(q => q.qid)
}

/**
 * Cursor/draft restore for re-visiting an answered batch question (Tab or
 * Shift-Tab): a choice answer puts the cursor back on its row; an answer that
 * matches no choice was typed via the inline input, so the cursor lands on the
 * input row (index = choices.length) with the text staged for editing.
 * Unanswered/empty answers restore to a clean cursor.
 */
export function clarifyRevisitState(
  choices: readonly string[],
  answer: string | undefined,
  multiSelect = false
): { custom: string; picked: string[]; selected: number } {
  if (answer === undefined || answer === '') return { custom: '', picked: [], selected: 0 }
  // A multi-select lock is a JSON array: its choice items become picks again and the
  // rest (typed "Other" text) is staged on the input row.
  const items = multiSelect ? clarifyAnswerItems(answer) : null
  if (items) {
    const custom = items.filter(item => !choices.includes(item)).join(', ')
    return { custom, picked: items.filter(item => choices.includes(item)), selected: custom ? choices.length : 0 }
  }
  const choiceIndex = choices.indexOf(answer)
  if (choiceIndex >= 0) return { custom: '', picked: [], selected: choiceIndex }
  return { custom: answer, picked: [], selected: choices.length }
}

/** The items of a multi-select lock (a JSON array string), or null when it is not one. */
export function clarifyAnswerItems(answer: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(answer)
    return Array.isArray(parsed) ? parsed.map(String) : null
  } catch {
    return null
  }
}

/** The multi-select answer a set of picks plus typed text locks: a JSON array, or '' (skip) when empty. */
export function clarifyMultiAnswer(picked: readonly string[], typed: readonly string[]): string {
  const values = [...picked, ...typed.map(v => v.trim()).filter(Boolean)]
  return values.length ? JSON.stringify(values) : ''
}

/** A locked answer as display text: a multi-select JSON array reads `A, B`. */
export function clarifyAnswerText(answer: string, multiSelect = false): string {
  const items = multiSelect ? clarifyAnswerItems(answer) : null
  return items ? items.join(', ') : answer
}

/**
 * Persistent transcript record for a batch clarify that was abandoned (server
 * timeout) or cancelled: every question on its own line, answered ones keeping
 * their locked answer — partials survive the deadline server-side, so the
 * record must show what was actually sent.
 */
export function formatAbandonedClarifyBatch(
  questions: readonly (Pick<ClarifyBatchQuestion, 'qid' | 'question'> & { readonly multiSelect?: boolean })[],
  answers: Readonly<Record<string, string>>,
  reason: string
): string {
  const lines = questions.map(q => {
    const answer = answers[q.qid]
    return answer ? `  ✓ ${q.question} → ${clarifyAnswerText(answer, q.multiSelect)}` : `  · ${q.question} (no answer)`
  })
  return [`ask (${questions.length} questions)`, ...lines, `  (${reason})`].join('\n')
}
