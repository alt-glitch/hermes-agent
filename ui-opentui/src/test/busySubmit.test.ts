import { describe, expect, test, vi } from 'vitest'

import { GatewayError } from '../boundary/errors.ts'
import {
  advancePreStartCancellationFence,
  cancelledPreStartInfoIsStale,
  createAutomaticQueueDrainGate,
  createPreAdmissionRetryTimer,
  createQueueEditDrainGate,
  deliveryFailureIsUncertain,
  preAdmissionRetryDelay,
  pendingPromptAfterBoundary,
  pendingPromptBoundaryMatches,
  promptLifecycleMatchesSubmission,
  pendingPromptDecision,
  runningAfterPreStartFence,
  steerRetentionOrder,
  steerSlotAvailable,
  submitWhileBusy,
  takeSettledSteerPrefix,
  type BusySubmitHost
} from '../logic/busySubmit.ts'
import type { BusyInputMode } from '../logic/busyQueue.ts'

function host(overrides: Partial<BusySubmitHost> = {}) {
  const mode = { value: 'queue' as BusyInputMode }
  const sid = { value: 'sid-1' as string | undefined }
  const queued: string[] = []
  const notes: string[] = []
  const statuses: string[] = []
  const interrupts = vi.fn()
  const haltAutomaticDrain = vi.fn()
  const steer = vi.fn(async () => 'accepted' as const)
  const value: BusySubmitHost = {
    mode: () => mode.value,
    sessionId: () => sid.value,
    enqueue: (text, front) => {
      if (front) queued.unshift(text)
      else queued.push(text)
      return true
    },
    interrupt: interrupts,
    canSteer: () => true,
    steer,
    haltAutomaticDrain,
    pushSystem: text => notes.push(text),
    setStatus: text => statuses.push(text),
    ...overrides
  }
  return { haltAutomaticDrain, interrupts, mode, notes, queued, sid, statuses, steer, value }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('busy submit policy', () => {
  test('an explicit clean-row send cannot reopen drain for an uncertain sibling', () => {
    const gate = createAutomaticQueueDrainGate()

    gate.halt()
    expect(gate.canDrain()).toBe(false)

    // The user explicitly sends the clean second row. The ambiguity-retained
    // first row remains, so the next turn completion must not auto-send it.
    gate.resetIfEmpty(1)
    expect(gate.canDrain()).toBe(false)

    // A mixed steer settlement synchronously enqueues both retained bodies
    // before it checks the gate. A fallback sibling therefore cannot clear the
    // uncertain sibling's halt during that same settlement batch.
    gate.resetIfEmpty(2)
    expect(gate.canDrain()).toBe(false)

    // Once every row from that provenance epoch is explicitly sent/deleted,
    // new ordinary queue traffic can drain again.
    gate.resetIfEmpty(0)
    expect(gate.canDrain()).toBe(true)

    gate.halt()
    gate.reset()
    expect(gate.canDrain()).toBe(true)
  })

  test('ending queue edit releases only a drain that actually settled behind it', () => {
    const gate = createQueueEditDrainGate()

    expect(gate.release()).toBe(false)
    gate.defer()
    expect(gate.release()).toBe(true)
    expect(gate.release()).toBe(false)

    gate.defer()
    gate.reset()
    expect(gate.release()).toBe(false)
  })

  test('an ACK keeps pre-start prompt ownership so interrupt can still cancel it', () => {
    expect(pendingPromptDecision('rpc-ack')).toBe('keep')
    expect(pendingPromptDecision('interrupt.success')).toBe('cancel')
    expect(pendingPromptDecision('message.start')).toBe('accept')
    expect(pendingPromptDecision('message.complete')).toBe('accept')
    expect(pendingPromptDecision('error')).toBe('retain')
    expect(pendingPromptDecision('gateway.exited')).toBe('retain')

    const attempt = { text: 'cancel me' }
    const afterAck = pendingPromptAfterBoundary(attempt, 'rpc-ack')
    expect(afterAck).toBe(attempt)
    expect(pendingPromptAfterBoundary(afterAck, 'interrupt.success')).toBeUndefined()
    expect(cancelledPreStartInfoIsStale('s1', 's1', 's1', true)).toBe(true)
    expect(cancelledPreStartInfoIsStale('s1', 's2', 's1', true)).toBe(false)

    // A background turn may start before this prompt's RPC returns `queued`.
    // Its lifecycle must not discard the sole crash-recovery copy.
    expect(promptLifecycleMatchesSubmission('user-send', { client_submission_ids: ['background'] })).toBe(false)
    expect(pendingPromptBoundaryMatches('user-send', 'message.start', undefined)).toBe(false)
    expect(
      pendingPromptBoundaryMatches('user-send', 'message.complete', {
        client_submission_ids: ['background']
      })
    ).toBe(false)
    expect(pendingPromptAfterBoundary(attempt, 'rpc-ack')).toBe(attempt)
    expect(pendingPromptDecision('gateway.exited')).toBe('retain')

    // The queued turn's own correlated start is the first acceptance proof.
    expect(
      pendingPromptBoundaryMatches('user-send', 'message.start', {
        client_submission_ids: ['first-merged-send', 'user-send']
      })
    ).toBe(true)
    expect(
      pendingPromptBoundaryMatches('user-send', 'error', {
        client_submission_ids: ['user-send']
      })
    ).toBe(true)
    expect(cancelledPreStartInfoIsStale('s1', 's1', 's1', false)).toBe(false)

    const staleInfo = advancePreStartCancellationFence('s1', 's1', 's1', 'session.info', true)
    expect(staleInfo).toEqual({ confirmedIdle: false, sessionId: 's1', suppressRunning: true })
    expect(runningAfterPreStartFence(staleInfo.suppressRunning, false, true)).toBe(false)
    expect(runningAfterPreStartFence(staleInfo.suppressRunning, true, true)).toBe(true)
    expect(advancePreStartCancellationFence(staleInfo.sessionId, 's1', 's1', 'message.start')).toEqual({
      confirmedIdle: false,
      sessionId: undefined,
      suppressRunning: false
    })
    expect(advancePreStartCancellationFence('s1', 's2', 's2', 'session.info', true)).toEqual({
      confirmedIdle: false,
      sessionId: 's1',
      suppressRunning: false
    })
  })

  test('out-of-order front steer failures retain final issuance order', () => {
    interface Request {
      readonly front: boolean
      outcome?: 'rejected'
      readonly text: string
    }
    const first: Request = { front: true, text: 'first' }
    const second: Request = { front: true, outcome: 'rejected', text: 'second' }
    const pending = new Map([
      [1, first],
      [2, second]
    ])

    expect(takeSettledSteerPrefix(pending)).toEqual([])
    first.outcome = 'rejected'
    const settled = takeSettledSteerPrefix(pending)
    expect(settled.map(request => request.text)).toEqual(['first', 'second'])

    const queue = ['existing']
    for (const request of steerRetentionOrder(settled)) queue.unshift(request.text)
    expect(queue).toEqual(['first', 'second', 'existing'])
    expect(pending.size).toBe(0)
  })

  test('a second front steer is restored until the first settles, preserving in-order fallbacks', () => {
    const pending = [{ front: true }]
    expect(steerSlotAvailable(true, pending)).toBe(false)
    expect(steerSlotAvailable(false, pending)).toBe(true)

    const h = host({ canSteer: (_text, front) => steerSlotAvailable(front, pending) })
    expect(submitWhileBusy(h.value, 'C')).toBe(true)
    h.mode.value = 'steer'
    expect(submitWhileBusy(h.value, 'B', true)).toBe(true)
    expect(h.steer).not.toHaveBeenCalled()
    expect(h.queued).toEqual(['B', 'C'])

    // The earlier removed row rejects later and reclaims the head. Because B
    // never left concurrently, the original [A,B,C] order is restored.
    h.queued.unshift('A')
    expect(h.queued).toEqual(['A', 'B', 'C'])
  })

  test('queue appends; edited fallback can reinsert at the head', () => {
    const h = host()
    expect(submitWhileBusy(h.value, 'tail')).toBe(true)
    expect(submitWhileBusy(h.value, 'head', true)).toBe(true)
    expect(h.queued).toEqual(['head', 'tail'])
    expect(h.steer).not.toHaveBeenCalled()
  })

  test('interrupt queues first, marks status, then interrupts exactly once', () => {
    const h = host()
    h.mode.value = 'interrupt'
    expect(submitWhileBusy(h.value, 'next')).toBe(true)
    expect(h.queued).toEqual(['next'])
    expect(h.statuses).toEqual(['interrupting…'])
    expect(h.interrupts).toHaveBeenCalledTimes(1)
  })

  test('accepted steer does not create a separate queued turn', async () => {
    const h = host()
    h.mode.value = 'steer'
    expect(submitWhileBusy(h.value, 'inject')).toBe(true)
    await tick()
    expect(h.steer).toHaveBeenCalledWith('sid-1', 'inject', false)
    expect(h.queued).toEqual([])
    expect(h.notes).toEqual([])
  })

  test('definite steer rejection reports the fallback already retained by the entry', async () => {
    const queued: string[] = []
    const h = host({
      steer: async (_sid, text, front) => {
        if (front) queued.unshift(text)
        else queued.push(text)
        return 'fallback'
      }
    })
    h.mode.value = 'steer'
    expect(submitWhileBusy(h.value, 'queued')).toBe(true)
    await tick()
    expect(queued).toEqual(['queued'])
    expect(h.notes).toEqual(['steer rejected — message queued for next turn'])
    expect(h.haltAutomaticDrain).not.toHaveBeenCalled()
  })

  test('ambiguous steer delivery retains text and halts automatic draining', async () => {
    const queued: string[] = []
    const h = host({
      steer: async (_sid, text, front) => {
        if (front) queued.unshift(text)
        else queued.push(text)
        return 'uncertain'
      }
    })
    h.mode.value = 'steer'
    expect(submitWhileBusy(h.value, 'retry explicitly')).toBe(true)
    await tick()
    expect(queued).toEqual(['retry explicitly'])
    expect(h.haltAutomaticDrain).toHaveBeenCalledTimes(1)
    expect(h.notes).toEqual(['steer delivery uncertain — message retained; send it explicitly to retry'])
  })

  test('a rejected queue insertion returns false so the composer remains intact', () => {
    const h = host({ enqueue: () => false })
    expect(submitWhileBusy(h.value, 'too large')).toBe(false)
  })

  test('a saturated steer backlog falls back synchronously through the bounded queue', () => {
    const h = host({ canSteer: () => false })
    h.mode.value = 'steer'
    expect(submitWhileBusy(h.value, 'bounded')).toBe(true)
    expect(h.queued).toEqual(['bounded'])
    expect(h.steer).not.toHaveBeenCalled()
    expect(h.notes).toEqual(['steer backlog full — message queued for next turn'])
  })

  test('an unexpected rejected promise retains text and halts automatic draining', async () => {
    const h = host({ steer: async () => Promise.reject(new Error('defect')) })
    h.mode.value = 'steer'
    expect(submitWhileBusy(h.value, 'do not lose')).toBe(true)
    await tick()
    expect(h.queued).toEqual(['do not lose'])
    expect(h.haltAutomaticDrain).toHaveBeenCalledTimes(1)
    expect(h.notes).toEqual(['steer delivery uncertain — message retained; send it explicitly to retry'])
  })

  test('only timeout/transport-down gateway failures are delivery-uncertain', () => {
    expect(
      deliveryFailureIsUncertain(new GatewayError({ message: 'timeout', method: 'prompt.submit', reason: 'timeout' }))
    ).toBe(true)
    expect(
      deliveryFailureIsUncertain(
        new GatewayError({ message: 'down', method: 'prompt.submit', reason: 'transport-down' })
      )
    ).toBe(true)
    expect(
      deliveryFailureIsUncertain(new GatewayError({ message: 'busy', method: 'prompt.submit', reason: 'rpc-error' }))
    ).toBe(false)
  })

  test('only structured MCP pre-admission rejection is automatically retryable', () => {
    expect(
      preAdmissionRetryDelay(
        new GatewayError({
          code: 4009,
          data: { kind: 'mcp_reload_in_progress', retry_after_ms: 25 },
          message: 'reloading',
          method: 'prompt.submit',
          reason: 'rpc-error'
        })
      )
    ).toBe(100)
    expect(
      preAdmissionRetryDelay(
        new GatewayError({ code: 4009, message: 'session busy', method: 'prompt.submit', reason: 'rpc-error' })
      )
    ).toBeUndefined()
    expect(
      preAdmissionRetryDelay(new GatewayError({ message: 'timeout', method: 'prompt.submit', reason: 'timeout' }))
    ).toBeUndefined()
  })

  test('synchronous cancellation owns a scheduled pre-admission retry', () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn()
      const retry = createPreAdmissionRetryTimer()
      retry.schedule(retry.epoch(), run, 250)

      retry.cancel()
      vi.advanceTimersByTime(250)

      expect(run).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test('late rejection cannot re-arm retry after cancellation', () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn()
      const retry = createPreAdmissionRetryTimer()
      const requestEpoch = retry.epoch()

      retry.cancel()
      expect(retry.schedule(requestEpoch, run, 250)).toBe(false)
      vi.advanceTimersByTime(250)

      expect(run).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
