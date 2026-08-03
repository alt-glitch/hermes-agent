import { describe, expect, test, vi } from 'vitest'

import { GatewayError } from '../boundary/errors.ts'
import {
  acceptedSteerNotice,
  advancePreStartCancellationFence,
  cancelledPreStartInfoIsStale,
  classifyBusyPromptSubmitResponse,
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
  const redirect = vi.fn(async () => 'redirected' as const)
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
    canRedirect: () => true,
    redirect,
    canSteer: () => true,
    steer,
    haltAutomaticDrain,
    pushSystem: text => notes.push(text),
    setStatus: text => statuses.push(text),
    ...overrides
  }
  return { haltAutomaticDrain, interrupts, mode, notes, queued, redirect, sid, statuses, steer, value }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('busy submit policy', () => {
  test('accepted steer feedback is immediate and bounded while the tool is running', () => {
    expect(acceptedSteerNotice('check the failing branch')).toBe(
      'steer accepted — waiting for next tool boundary: "check the failing branch"'
    )
    expect(acceptedSteerNotice('x'.repeat(80))).toBe(
      `steer accepted — waiting for next tool boundary: "${'x'.repeat(50)}…"`
    )
  })

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

  test('redirected and queued corrections keep one copy until their own terminal lifecycle', () => {
    const redirected = { text: 'correct active turn' }
    const afterRedirectAck = pendingPromptAfterBoundary(redirected, 'rpc-ack')
    expect(afterRedirectAck).toBe(redirected)
    expect(
      pendingPromptBoundaryMatches('redirect-1', 'message.complete', {
        client_submission_ids: ['other-send']
      })
    ).toBe(false)
    expect(afterRedirectAck).toBe(redirected)
    expect(
      pendingPromptBoundaryMatches('redirect-1', 'message.complete', {
        client_submission_ids: ['active-send', 'redirect-1']
      })
    ).toBe(true)
    expect(pendingPromptAfterBoundary(afterRedirectAck, 'message.complete')).toBeUndefined()

    const queued = { text: 'send after build' }
    const afterQueueAck = pendingPromptAfterBoundary(queued, 'rpc-ack')
    expect(afterQueueAck).toBe(queued)
    expect(pendingPromptBoundaryMatches('queued-1', 'message.start', undefined)).toBe(false)
    expect(
      pendingPromptBoundaryMatches('queued-1', 'message.start', {
        client_submission_ids: ['queued-1']
      })
    ).toBe(true)
    expect(pendingPromptAfterBoundary(afterQueueAck, 'message.start')).toBeUndefined()

    expect(
      pendingPromptBoundaryMatches('failed-1', 'error', {
        client_submission_ids: ['failed-1']
      })
    ).toBe(true)
    expect(pendingPromptDecision('error')).toBe('retain')
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
    expect(h.redirect).not.toHaveBeenCalled()
    expect(h.steer).not.toHaveBeenCalled()
  })

  test('interrupt redirects a text correction through the active prompt submission', async () => {
    const h = host()
    h.mode.value = 'interrupt'
    expect(submitWhileBusy(h.value, 'next')).toBe(true)
    await tick()
    expect(h.redirect).toHaveBeenCalledWith('sid-1', 'next', false)
    expect(h.queued).toEqual([])
    expect(h.statuses).toEqual([])
    expect(h.interrupts).not.toHaveBeenCalled()
  })

  test('interrupt keeps a build-window queued correction on the redirect path', async () => {
    const h = host({ redirect: async () => 'queued' })
    h.mode.value = 'interrupt'
    expect(submitWhileBusy(h.value, 'after build')).toBe(true)
    await tick()
    expect(h.queued).toEqual([])
    expect(h.interrupts).not.toHaveBeenCalled()
    expect(h.notes).toEqual([])
  })

  test('definite redirect RPC failure uses the legacy enqueue and interrupt fallback', async () => {
    const fallbackQueue: string[] = []
    const fallbackInterrupt = vi.fn()
    const h = host({
      redirect: async (_sid, text, front) => {
        if (front) fallbackQueue.unshift(text)
        else fallbackQueue.push(text)
        fallbackInterrupt()
        return 'fallback'
      }
    })
    h.mode.value = 'interrupt'
    expect(submitWhileBusy(h.value, 'survive old gateway')).toBe(true)
    await tick()
    expect(fallbackQueue).toEqual(['survive old gateway'])
    expect(fallbackInterrupt).toHaveBeenCalledTimes(1)
    expect(h.statuses).toEqual(['interrupting…'])
    expect(h.queued).toEqual([])
  })

  test('media-bearing interrupt input cannot take the text redirect path', () => {
    const h = host({ canRedirect: () => false })
    h.mode.value = 'interrupt'
    expect(submitWhileBusy(h.value, 'caption with attached image')).toBe(true)
    expect(h.redirect).not.toHaveBeenCalled()
    expect(h.queued).toEqual(['caption with attached image'])
    expect(h.statuses).toEqual(['interrupting…'])
    expect(h.interrupts).toHaveBeenCalledTimes(1)
  })

  test('busy prompt response accepts only redirected and queued statuses', () => {
    expect(classifyBusyPromptSubmitResponse({ status: 'redirected' })).toBe('redirected')
    expect(classifyBusyPromptSubmitResponse({ status: 'queued' })).toBe('queued')
    expect(classifyBusyPromptSubmitResponse({ status: 'streaming' })).toBe('rejected')
    expect(classifyBusyPromptSubmitResponse(undefined)).toBe('rejected')
  })

  test('a consumed voice-stop ack is neither an admission nor a rejection', () => {
    // {voice_stopped:true} (upstream ba13132298) means the gateway ended the
    // voice chat with a typed bare stop phrase; NO turn starts, so it must not
    // be totalized into the interrupt + enqueue rejection fallback.
    expect(classifyBusyPromptSubmitResponse({ voice_stopped: true })).toBe('voice-stopped')
    // Genuine non-admissions still reject so real failures keep the fallback.
    expect(classifyBusyPromptSubmitResponse({ voice_stopped: false })).toBe('rejected')
    expect(classifyBusyPromptSubmitResponse({ voice_stopped: 'yes' })).toBe('rejected')
    expect(classifyBusyPromptSubmitResponse({ status: 'streaming', voice_stopped: false })).toBe('rejected')
  })

  test('interrupt: a consumed voice-stop redirect neither requeues, interrupts, nor notifies', async () => {
    // The entry maps a `voice-stopped` classification to a `consumed` delivery
    // (drop the optimistic row, keep the live turn). submitWhileBusy must treat
    // that terminal ack as a clean no-op.
    const redirect = vi.fn(async () => 'consumed' as const)
    const h = host({ redirect })
    h.mode.value = 'interrupt'
    expect(submitWhileBusy(h.value, 'stop')).toBe(true)
    await tick()
    expect(redirect).toHaveBeenCalledWith('sid-1', 'stop', false)
    expect(h.queued).toEqual([])
    expect(h.interrupts).not.toHaveBeenCalled()
    expect(h.notes).toEqual([])
    expect(h.statuses).toEqual([])
  })

  test('interrupt: the entry redirect consumes a voice stop but still falls back on a genuine rejection', async () => {
    // Faithfully model the entry's redirect: classify the raw prompt.submit
    // response, consume a voice stop, and only interrupt + enqueue on a real
    // rejection. This pins both branches of the fix at once.
    const requeued: string[] = []
    const interruptedFor: string[] = []
    const redirect = (response: unknown) =>
      host({
        interrupt: () => interruptedFor.push('x'),
        redirect: async (_sid, text, front) => {
          const disposition = classifyBusyPromptSubmitResponse(response)
          if (disposition === 'voice-stopped') return 'consumed'
          if (front) requeued.unshift(text)
          else requeued.push(text)
          interruptedFor.push(text)
          return 'fallback'
        }
      })

    const stopHost = redirect({ voice_stopped: true })
    stopHost.mode.value = 'interrupt'
    expect(submitWhileBusy(stopHost.value, 'stop')).toBe(true)
    await tick()
    expect(requeued).toEqual([])
    expect(interruptedFor).toEqual([])

    const failHost = redirect({ status: 'streaming' })
    failHost.mode.value = 'interrupt'
    expect(submitWhileBusy(failHost.value, 'real correction')).toBe(true)
    await tick()
    expect(requeued).toEqual(['real correction'])
    expect(interruptedFor).toEqual(['real correction'])
  })

  test('queue: a queued voice-stop phrase is consumed on drain, never run as a normal prompt', () => {
    const h = host()
    // While busy the client cannot know a typed phrase is a stop phrase without
    // a round-trip, so queue mode enqueues it. This preserved behavior stands.
    expect(submitWhileBusy(h.value, 'stop')).toBe(true)
    expect(h.queued).toEqual(['stop'])

    // On drain the entry submits the row and classifies the ack. A
    // {voice_stopped:true} ack is consumed: the row leaves the queue and is
    // NOT resubmitted or re-run as a model prompt.
    const drained = h.queued.shift()
    expect(drained).toBe('stop')
    const submittedAsPrompt: string[] = []
    const disposition = classifyBusyPromptSubmitResponse({ voice_stopped: true })
    if (disposition !== 'voice-stopped' && drained !== undefined) submittedAsPrompt.push(drained)
    expect(disposition).toBe('voice-stopped')
    expect(submittedAsPrompt).toEqual([])
    expect(h.queued).toEqual([])
    expect(h.interrupts).not.toHaveBeenCalled()
    expect(h.notes).toEqual([])
  })

  test('accepted steer does not create a separate queued turn', async () => {
    const h = host()
    h.mode.value = 'steer'
    expect(submitWhileBusy(h.value, 'inject')).toBe(true)
    await tick()
    expect(h.steer).toHaveBeenCalledWith('sid-1', 'inject', false)
    expect(h.redirect).not.toHaveBeenCalled()
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
