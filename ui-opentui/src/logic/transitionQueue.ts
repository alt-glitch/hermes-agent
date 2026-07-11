/** Inputs accepted while create/resume owns the session transition lock. */
export type TransitionSubmission =
  | { readonly kind: 'prompt'; readonly text: string }
  | { readonly kind: 'skill'; readonly command: string; readonly body: string }

export const SESSION_TRANSITION_QUEUE_LIMIT = 20
export const SESSION_TRANSITION_QUEUE_MAX_CHARS = 4 * 1024 * 1024

export function transitionSubmissionText(item: TransitionSubmission): string {
  return item.kind === 'prompt' ? item.text : item.body
}

function transitionSubmissionChars(item: TransitionSubmission): number {
  return transitionSubmissionText(item).length + (item.kind === 'skill' ? item.command.length : 0)
}

export interface TransitionQueueReservation {
  readonly chars: number
  readonly count: number
}

/** Capacity held recovery input must reserve in the normal prompt queue.
 * Commands are transition-only metadata; only the model body moves into the
 * normal queue, so this intentionally counts transitionSubmissionText(). */
export function transitionQueueReservation(pending: readonly TransitionSubmission[]): TransitionQueueReservation {
  return {
    chars: pending.reduce((total, item) => total + transitionSubmissionText(item).length, 0),
    count: pending.length
  }
}

export function transitionQueueAccepts(pending: readonly TransitionSubmission[], next: TransitionSubmission): boolean {
  if (pending.length >= SESSION_TRANSITION_QUEUE_LIMIT) return false
  let chars = transitionSubmissionChars(next)
  for (const item of pending) chars += transitionSubmissionChars(item)
  return chars <= SESSION_TRANSITION_QUEUE_MAX_CHARS
}

/** Held input may only drain into the transition it was authored for. */
export function transitionOwnerAccepts(heldOwner: string | undefined, activeOwner: string | undefined): boolean {
  return heldOwner === undefined || (activeOwner !== undefined && heldOwner === activeOwner)
}

/** Recovery with a durable session targets that exact lineage. A detached
 * crash can only be adopted by the next fresh-session transition. */
export function recoveryTransitionOwner(resumeId: string | undefined): string {
  return resumeId ? `resume:${resumeId}` : 'new'
}

/** Same-lineage recovery preserves the pre-crash ownership key even when the
 * gateway resolves a compressed parent id to a newer continuation tip. */
export function recoveryLineageOwner(current: string | undefined, resolved: string): string {
  return current ?? resolved
}

/** A lazy fresh session has no state.db row until its first prompt. If its
 * gateway dies before then, same-session resume cannot succeed; adopting a new
 * lazy session is lossless because there is no durable transcript to cross. */
export function recoveryTargetIsMissing(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.toLowerCase().includes('session not found')
}

/** A different (or unspecified picker) target must not adopt held input. */
export function heldTransitionBlocks(
  count: number,
  heldOwner: string | undefined,
  requestedOwner: string | undefined
): boolean {
  return count > 0 && (requestedOwner === undefined || heldOwner !== requestedOwner)
}

export interface TransitionDrainPlan {
  readonly first: TransitionSubmission | undefined
  /** Remaining model inputs for the store's one-per-confirmed-turn queue. */
  readonly queued: string[]
}

/**
 * Exactly one submission may start immediately after adoption. Everything else
 * must enter the existing turn queue; sending the whole batch in one tick races
 * message.start and causes server-busy (4009) drops.
 */
export function planTransitionDrain(pending: readonly TransitionSubmission[]): TransitionDrainPlan {
  return {
    first: pending[0],
    queued: pending.slice(1).map(transitionSubmissionText)
  }
}
