import { describe, expect, test } from 'vitest'

import { BUSY_QUEUE_MAX_CHARS, BUSY_QUEUE_MAX_ITEMS, queueAccepts } from '../logic/busyQueue.ts'

import {
  heldTransitionBlocks,
  planTransitionDrain,
  recoveryTransitionOwner,
  recoveryLineageOwner,
  recoveryTargetIsMissing,
  SESSION_TRANSITION_QUEUE_LIMIT,
  SESSION_TRANSITION_QUEUE_MAX_CHARS,
  transitionOwnerAccepts,
  transitionQueueAccepts,
  transitionQueueReservation
} from '../logic/transitionQueue.ts'

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

  test('bounds aggregate retained prompt, skill body, and skill command characters', () => {
    expect(
      transitionQueueAccepts([], {
        kind: 'prompt',
        text: 'x'.repeat(SESSION_TRANSITION_QUEUE_MAX_CHARS)
      })
    ).toBe(true)
    expect(
      transitionQueueAccepts([], {
        body: '',
        command: `/${'x'.repeat(SESSION_TRANSITION_QUEUE_MAX_CHARS)}`,
        kind: 'skill'
      })
    ).toBe(false)
  })

  test('failed target A input can retry A but never drains into target B', () => {
    expect(transitionOwnerAccepts('resume:A', 'resume:A')).toBe(true)
    expect(transitionOwnerAccepts('resume:A', 'resume:B')).toBe(false)
    expect(heldTransitionBlocks(1, 'resume:A', 'resume:A')).toBe(false)
    expect(heldTransitionBlocks(1, 'resume:A', 'resume:B')).toBe(true)
    expect(heldTransitionBlocks(1, 'resume:A', undefined)).toBe(true)
    expect(heldTransitionBlocks(0, 'resume:A', 'resume:B')).toBe(false)
  })

  test('detached recovery input belongs to the next fresh session', () => {
    expect(recoveryTransitionOwner(undefined)).toBe('new')
    expect(recoveryTransitionOwner('db-1')).toBe('resume:db-1')
  })

  test('same-lineage recovery keeps a pre-compression transition owner stable', () => {
    expect(recoveryLineageOwner('parent-before-compression', 'continuation-tip')).toBe('parent-before-compression')
    expect(recoveryLineageOwner(undefined, 'continuation-tip')).toBe('continuation-tip')
  })

  test('only a definitive missing lazy-session row permits fresh adoption', () => {
    expect(recoveryTargetIsMissing(new Error('session.resume failed: session not found'))).toBe(true)
    expect(recoveryTargetIsMissing(new Error('state.db temporarily locked'))).toBe(false)
    expect(recoveryTargetIsMissing('network down')).toBe(false)
  })

  test('held recovery input reserves normal-queue rows and model-body characters', () => {
    expect(
      transitionQueueReservation([
        { kind: 'prompt', text: 'older' },
        { kind: 'skill', command: '/review', body: 'skill body' }
      ])
    ).toEqual({ count: 2, chars: 'older'.length + 'skill body'.length })
  })

  test('a held item makes bounded progress under continuous new input at both caps', () => {
    const held = [{ kind: 'prompt', text: 'held-before-new' }] as const
    const reservation = transitionQueueReservation(held)
    const fullRows = Array.from({ length: BUSY_QUEUE_MAX_ITEMS }, (_, index) => `old-${index}`)

    // Full means the held item cannot promote yet. After one old row drains,
    // its reserved slot rejects a newer submission, then admits the held body.
    expect(queueAccepts(fullRows, held[0].text)).toBe(false)
    const afterRowDrain = fullRows.slice(1)
    expect(queueAccepts(afterRowDrain, 'newer', undefined, reservation.count, reservation.chars)).toBe(false)
    expect(queueAccepts(afterRowDrain, held[0].text)).toBe(true)

    const almostFullChars = ['x'.repeat(BUSY_QUEUE_MAX_CHARS - held[0].text.length)]
    expect(queueAccepts(almostFullChars, 'n', undefined, reservation.count, reservation.chars)).toBe(false)
    expect(queueAccepts(almostFullChars, held[0].text)).toBe(true)
  })
})
