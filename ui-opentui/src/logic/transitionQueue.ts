/** Inputs accepted while create/resume owns the session transition lock. */
export type TransitionSubmission =
  | { readonly kind: 'prompt'; readonly text: string }
  | { readonly kind: 'skill'; readonly command: string; readonly body: string }

export const SESSION_TRANSITION_QUEUE_LIMIT = 20

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
    queued: pending.slice(1).map(item => (item.kind === 'prompt' ? item.text : item.body))
  }
}
