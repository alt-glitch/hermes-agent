/**
 * Batch (multi-question) clarify — pure helpers shared by the store reducer and
 * the ClarifyPrompt view (Ink parity: ui-tui text.ts clarifyBatchRevisitState /
 * formatAbandonedClarifyBatch + createGatewayEventHandler's entry filter).
 *
 * Wire contract (tui_gateway `_clarify_block` / `_respond`):
 *   clarify.request  → payload.questions[{qid, question, choices, multi_select}]
 *                      (+ payload.answers{qid: answer} on a reconnect replay)
 *   clarify.respond  → {request_id, question_id, answer} locks ONE answer; the
 *                      prompt stays open until every qid is locked. A respond
 *                      WITHOUT question_id cancels the whole batch.
 *
 * multi_select is preserved on state (it rides the wire) but the prompt does
 * not render checkbox UX yet — same deliberate gap as Ink.
 */

/** One normalized batch question held on the active clarify prompt. */
export interface ClarifyBatchQuestion {
  qid: string
  question: string
  choices: string[] | null
  multiSelect: boolean
}

/** The raw wire shape of one batch entry (all fields optional at the boundary). */
export interface ClarifyBatchQuestionWire {
  readonly qid?: string
  readonly question?: string
  readonly choices?: readonly string[] | null
  readonly multi_select?: boolean
}

/**
 * Filter + normalize the wire question list: entries without a non-blank qid
 * AND question are dropped (Ink parity — a fully malformed list falls back to
 * the single-question payload fields). Choices collapse to null when empty.
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
  answer: string | undefined
): { custom: string; selected: number } {
  if (answer === undefined || answer === '') return { custom: '', selected: 0 }
  const choiceIndex = choices.indexOf(answer)
  if (choiceIndex >= 0) return { custom: '', selected: choiceIndex }
  return { custom: answer, selected: choices.length }
}

/**
 * Persistent transcript record for a batch clarify that was abandoned (server
 * timeout) or cancelled: every question on its own line, answered ones keeping
 * their locked answer — partials survive the deadline server-side, so the
 * record must show what was actually sent.
 */
export function formatAbandonedClarifyBatch(
  questions: readonly Pick<ClarifyBatchQuestion, 'qid' | 'question'>[],
  answers: Readonly<Record<string, string>>,
  reason: string
): string {
  const lines = questions.map(q => {
    const answer = answers[q.qid]
    return answer ? `  ✓ ${q.question} → ${answer}` : `  · ${q.question} (no answer)`
  })
  return [`ask (${questions.length} questions)`, ...lines, `  (${reason})`].join('\n')
}
