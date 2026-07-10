import { describe, expect, test } from 'vitest'

import { planTransitionDrain, SESSION_TRANSITION_QUEUE_LIMIT } from '../logic/transitionQueue.ts'

describe('session transition submission queue', () => {
  test('starts exactly one item and serializes every remainder through the turn queue', () => {
    const first = { kind: 'skill', command: '/dogfood', body: 'skill body' } as const
    expect(
      planTransitionDrain([
        first,
        { kind: 'prompt', text: 'second' },
        { kind: 'skill', command: '/review', body: 'third body' }
      ])
    ).toEqual({ first, queued: ['second', 'third body'] })
  })

  test('empty input is a no-op and the queue has a constrained-host bound', () => {
    expect(planTransitionDrain([])).toEqual({ first: undefined, queued: [] })
    expect(SESSION_TRANSITION_QUEUE_LIMIT).toBe(20)
  })
})
