/** Busy-submit policy orchestrator. Transport-free: the entry injects decoded
 * steer/interrupt capabilities, while this module owns the synchronous busy
 * latch routing and user-visible best-effort outcomes. */
import type { GatewayError } from '../boundary/errors.ts'
import type { BusyInputMode } from './busyQueue.ts'

export type SteerDelivery = 'accepted' | 'fallback' | 'retained' | 'uncertain'

export interface AutomaticQueueDrainGate {
  /** False means every retained row requires an explicit user send/delete. */
  readonly canDrain: () => boolean
  readonly halt: () => void
  readonly reset: () => void
  /** End the explicit-only provenance epoch at a real empty-queue boundary. */
  readonly resetIfEmpty: (queueCount: number) => void
}

/** Conservative ambiguity gate for the current string-only queue model.
 *
 * The queue cannot yet tag one row as delivery-uncertain. Once any ambiguous
 * body is retained, keep the whole existing queue explicit-only until it is
 * empty. Sending some other row must not reopen automatic drain and silently
 * replay the uncertain body. Observing an empty queue safely starts a fresh
 * provenance epoch; explicit `/queue --clear` may reset it directly too.
 */
export function createAutomaticQueueDrainGate(): AutomaticQueueDrainGate {
  let explicitOnly = false
  return {
    canDrain: () => !explicitOnly,
    halt: () => {
      explicitOnly = true
    },
    reset: () => {
      explicitOnly = false
    },
    resetIfEmpty: queueCount => {
      if (queueCount <= 0) explicitOnly = false
    }
  }
}

export interface QueueEditDrainGate {
  /** Remember that an otherwise-ready automatic drain settled behind edit. */
  readonly defer: () => void
  /** Consume one real deferred drain; idle edit/cancel returns false. */
  readonly release: () => boolean
  readonly reset: () => void
}

/** Queue inspection must not become submission. Only an authoritative drain
 * attempt that reached the queue-edit blocker earns one release when editing
 * ends; opening an idle row with Up and cancelling with Esc earns nothing. */
export function createQueueEditDrainGate(): QueueEditDrainGate {
  let deferred = false
  return {
    defer: () => {
      deferred = true
    },
    release: () => {
      if (!deferred) return false
      deferred = false
      return true
    },
    reset: () => {
      deferred = false
    }
  }
}

export type PendingPromptBoundary =
  | 'rpc-ack'
  | 'message.start'
  | 'message.complete'
  | 'error'
  | 'gateway.exited'
  | 'interrupt.success'
export type PendingPromptDecision = 'keep' | 'accept' | 'retain' | 'cancel'

/** Process-local best-effort prompt lifecycle. An RPC ACK only says the server
 * accepted the request handler; deferred agent startup may still be cancelled
 * before `message.start`, so the body remains pending across that window. */
export function pendingPromptDecision(boundary: PendingPromptBoundary): PendingPromptDecision {
  if (boundary === 'rpc-ack') return 'keep'
  if (boundary === 'message.start' || boundary === 'message.complete') return 'accept'
  if (boundary === 'error' || boundary === 'gateway.exited') return 'retain'
  return 'cancel'
}

/** Apply only non-retention boundaries to the process-local pending body.
 * Retention needs the caller to move the body into its bounded queue first. */
export function pendingPromptAfterBoundary<T>(current: T | undefined, boundary: PendingPromptBoundary): T | undefined {
  const decision = pendingPromptDecision(boundary)
  return decision === 'keep' || decision === 'retain' ? current : undefined
}

/** Identify the one stale busy snapshot a deferred-build cancellation can
 * publish after its interrupt ACK. Session fencing prevents suppressing a real
 * running state from any successor conversation. */
export function cancelledPreStartInfoIsStale(
  cancelledSessionId: string | undefined,
  liveSessionId: string | undefined,
  eventSessionId: string | undefined,
  running: unknown
): boolean {
  return (
    running === true &&
    cancelledSessionId !== undefined &&
    cancelledSessionId === liveSessionId &&
    eventSessionId === cancelledSessionId
  )
}

export interface PreStartCancellationFenceUpdate {
  readonly confirmedIdle: boolean
  readonly sessionId: string | undefined
  readonly suppressRunning: boolean
}

/** Advance the narrow deferred-build cancellation fence. Do not clear it merely
 * because the user asks to send again: the old build may still publish its
 * stale busy snapshot after a 4009 rejection. A real start/terminal event or
 * confirmed idle state is the safe boundary. */
export function advancePreStartCancellationFence(
  cancelledSessionId: string | undefined,
  liveSessionId: string | undefined,
  eventSessionId: string | undefined,
  eventType: string,
  running?: unknown
): PreStartCancellationFenceUpdate {
  if (
    cancelledSessionId === undefined ||
    cancelledSessionId !== liveSessionId ||
    eventSessionId !== cancelledSessionId
  ) {
    return { confirmedIdle: false, sessionId: cancelledSessionId, suppressRunning: false }
  }
  if (eventType === 'message.start' || eventType === 'message.complete' || eventType === 'error') {
    return { confirmedIdle: false, sessionId: undefined, suppressRunning: false }
  }
  if (eventType === 'session.info' && running === false) {
    return { confirmedIdle: true, sessionId: undefined, suppressRunning: false }
  }
  return {
    confirmedIdle: false,
    sessionId: cancelledSessionId,
    suppressRunning: cancelledPreStartInfoIsStale(cancelledSessionId, liveSessionId, eventSessionId, running)
  }
}

/** A stale deferred-build snapshot must not change the current optimistic
 * spinner state. The cancelled turn is already false; an explicit replacement
 * may already be true while it waits for its own message.start. */
export function runningAfterPreStartFence(suppress: boolean, current: boolean | undefined, incoming: unknown): unknown {
  return suppress ? current === true : incoming
}

export interface PendingSteerSettlement {
  readonly front: boolean
  outcome?: unknown
}

/** Remove only the insertion-ordered prefix whose outcomes are known. A later
 * response can settle first, but may not overtake an earlier request. */
export function takeSettledSteerPrefix<K, T extends PendingSteerSettlement>(pending: Map<K, T>): T[] {
  const settled: T[] = []
  for (;;) {
    const next = pending.entries().next()
    if (next.done || next.value[1].outcome === undefined) return settled
    pending.delete(next.value[0])
    settled.push(next.value[1])
  }
}

/** Processing order for queue retention. Tail insertions append in issuance
 * order; front insertions must be applied in reverse so repeated `unshift`
 * leaves the final queue in issuance order. */
export function steerRetentionOrder<T extends { readonly front: boolean }>(settled: readonly T[]): T[] {
  const front = settled.filter(request => request.front).reverse()
  const tail = settled.filter(request => !request.front)
  return [...front, ...tail]
}

/** A front steer represents a temporarily removed queue row. Allowing another
 * front steer before it settles loses the original insertion position across
 * separate settlement batches, so serialize this narrow path. Tail steers stay
 * concurrent. */
export function steerSlotAvailable(front: boolean, pending: Iterable<{ readonly front: boolean }>): boolean {
  if (!front) return true
  for (const request of pending) if (request.front) return false
  return true
}

export interface BusySubmitHost {
  readonly mode: () => BusyInputMode
  readonly sessionId: () => string | undefined
  readonly enqueue: (text: string, front: boolean) => boolean
  readonly interrupt: () => void
  /** Synchronous guard for the bounded set of in-flight steer requests. */
  readonly canSteer: (text: string, front: boolean) => boolean
  /** The entry resolves definite rejection into `fallback` and ambiguous
   * transport delivery into `uncertain`; neither result is auto-replayed. */
  readonly steer: (sessionId: string, text: string, front: boolean) => Promise<SteerDelivery>
  readonly haltAutomaticDrain: () => void
  readonly pushSystem: (text: string) => void
  readonly setStatus: (text: string) => void
}

/** JSON-RPC error means the server returned a definite rejection. A timeout or
 * dead transport cannot prove whether bytes were accepted, so retry stays an
 * explicit user decision. */
export function deliveryFailureIsUncertain(error: GatewayError): boolean {
  return error.reason !== 'rpc-error'
}

export function submitWhileBusy(host: BusySubmitHost, text: string, front = false): boolean {
  const mode = host.mode()
  if (mode === 'queue') return host.enqueue(text, front)

  const sid = host.sessionId()
  if (!sid) return host.enqueue(text, front)

  if (mode === 'interrupt') {
    if (!host.enqueue(text, front)) return false
    host.setStatus('interrupting…')
    host.interrupt()
    return true
  }

  if (!host.canSteer(text, front)) {
    const accepted = host.enqueue(text, front)
    if (accepted) host.pushSystem('steer backlog full — message queued for next turn')
    return accepted
  }

  let request: Promise<SteerDelivery>
  try {
    request = host.steer(sid, text, front)
  } catch {
    const accepted = host.enqueue(text, front)
    if (accepted) host.pushSystem('steer failed — message queued for next turn')
    return accepted
  }

  void request.then(
    outcome => {
      if (outcome === 'fallback') {
        host.pushSystem('steer rejected — message queued for next turn')
      } else if (outcome === 'uncertain') {
        host.haltAutomaticDrain()
        host.pushSystem('steer delivery uncertain — message retained; send it explicitly to retry')
      } else if (outcome === 'retained') {
        host.pushSystem('steer fallback queue is full — input remains retained')
      }
    },
    () => {
      // The production adapter totalizes typed gateway failures. Keep this
      // defensive boundary for an unexpected promise defect without guessing
      // that the server rejected the bytes.
      if (host.enqueue(text, front)) {
        host.haltAutomaticDrain()
        host.pushSystem('steer delivery uncertain — message retained; send it explicitly to retry')
      } else {
        host.pushSystem('steer delivery uncertain and queue is full — input remains retained')
      }
    }
  )
  return true
}
