/**
 * The session's standing /goal as one dock row (Ink `app/goalStatus.ts`).
 * Session-local presentation only; `/goal` stays the control surface and the
 * transcript carries the verdict once the goal is done or cleared.
 */
import type { GoalSnapshot } from '../boundary/schema/SessionControl.ts'

export interface GoalLine {
  readonly detail: string
  readonly glyph: '⊙' | '⏳' | '⏸'
  readonly label: string
  readonly title: string
}

const clock = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** `⊙ goal · 3/20 turns · <title>` for an active goal, `⏳ goal parked` / `⏸ goal paused`
 * with the reason while held, `null` once it is done or cleared. */
export function goalLine(goal: GoalSnapshot | null | undefined): GoalLine | null {
  if (!goal || (goal.status !== 'active' && goal.status !== 'paused')) return null

  const turns = `${goal.turns_used}/${goal.max_turns} turns`
  const barrier = goal.status === 'active' ? goal.wait_barrier : null

  if (barrier) {
    const until =
      barrier.type === 'until' ? `until ${clock(barrier.until_at)}` : `on ${barrier.type} ${String(barrier.target)}`
    const reason = barrier.reason ? ` · ${barrier.reason}` : ''
    return { detail: `${until}${reason} · ${turns}`, glyph: '⏳', label: 'goal parked', title: goal.title }
  }

  if (goal.status === 'paused') {
    const reason = goal.paused_reason ? `${goal.paused_reason} · ` : ''
    return { detail: `${reason}${turns}`, glyph: '⏸', label: 'goal paused', title: goal.title }
  }

  return { detail: turns, glyph: '⊙', label: 'goal', title: goal.title }
}
