/** Busy-submit policy orchestrator. Transport-free: the entry injects decoded
 * steer/interrupt capabilities, while this module owns the synchronous busy
 * latch routing and user-visible best-effort outcomes. */
import type { GatewayError } from '../boundary/errors.ts'
import type { BusyInputMode } from './busyQueue.ts'

export type SteerDelivery = 'accepted' | 'fallback' | 'retained' | 'uncertain'
export type InterruptCorrectionDelivery = 'redirected' | 'queued' | 'consumed' | 'fallback' | 'retained' | 'uncertain'

/** Busy prompt.submit has two positive admission outcomes plus one terminal
 * non-turn acknowledgement. A `{voice_stopped:true}` response (upstream
 * ba13132298) means the gateway consumed a typed bare voice stop phrase and
 * ended the voice chat: the request succeeded but NO turn starts, so it must
 * NOT be totalized into the rejection/interrupt+enqueue fallback — that would
 * requeue the literal phrase and interrupt the live turn. Anything else is a
 * definite non-admission response and must use the legacy fallback. */
export function classifyBusyPromptSubmitResponse(
  response: unknown
): 'redirected' | 'queued' | 'voice-stopped' | 'rejected' {
  if (response === null || typeof response !== 'object') return 'rejected'
  if ((response as { readonly voice_stopped?: unknown }).voice_stopped === true) return 'voice-stopped'
  if (!('status' in response)) return 'rejected'
  const status = response.status
  if (status === 'redirected' || status === 'queued') return status
  return 'rejected'
}

/** Immediate, bounded feedback while an accepted steer waits for the current
 * tool/API boundary. The correlation-backed row is retired by the store only
 * when a lifecycle event carries this steer submission id. */
export function acceptedSteerNotice(text: string): string {
  const preview = `${text.slice(0, 50)}${text.length > 50 ? '…' : ''}`
  return `steer accepted — waiting for next tool boundary: "${preview}"`
}

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

/** True only when a turn lifecycle event names this exact client submission.
 *
 * Same-session lifecycle events are not sufficient proof: a background/goal
 * turn can win the gateway lock immediately before `prompt.submit`, causing
 * the user's request to be acknowledged as queued. Retain the recovery copy
 * through those unrelated events and release it only when the queued turn
 * itself starts (or completes). Legacy/uncorrelated events deliberately fail
 * closed; a gateway exit then offers an explicit retry instead of losing text.
 */
export function promptLifecycleMatchesSubmission(submissionId: string, payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false
  const ids = (payload as { readonly client_submission_ids?: unknown }).client_submission_ids
  return Array.isArray(ids) && ids.some(value => value === submissionId)
}

/** Whether this boundary is allowed to settle the pending body. Transport and
 * user-cancel boundaries are inherently local; turn/error events need proof. */
export function pendingPromptBoundaryMatches(
  submissionId: string,
  boundary: PendingPromptBoundary,
  payload?: unknown
): boolean {
  if (boundary === 'message.start' || boundary === 'message.complete' || boundary === 'error') {
    return promptLifecycleMatchesSubmission(submissionId, payload)
  }
  return true
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
  /** False for media-bearing input and while another correction owns the one
   * bounded, correlation-backed recovery slot. */
  readonly canRedirect: (text: string, front: boolean) => boolean
  /** Submit a text correction through prompt.submit. The entry preserves one
   * recovery copy until a correlated terminal lifecycle event; definite RPC
   * rejection is totalized into the legacy interrupt + enqueue fallback. */
  readonly redirect: (sessionId: string, text: string, front: boolean) => Promise<InterruptCorrectionDelivery>
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

/** Return a bounded delay only for a server-proven rejection before prompt
 * admission. Retrying any timeout/transport failure risks duplicating a turn.
 *
 * `attempt` counts prior reload rejections for this submission: real reloads
 * can run for minutes (full teardown + rediscovery serialized behind slow or
 * parked servers), so the delay backs off exponentially from the server's
 * hint toward a 2s ceiling instead of polling the admission fence at 4Hz. */
export function preAdmissionRetryDelay(error: GatewayError, attempt = 0): number | undefined {
  if (error.reason !== 'rpc-error' || error.code !== 4009 || error.data === null || typeof error.data !== 'object') {
    return undefined
  }
  const data = error.data as { readonly kind?: unknown; readonly retry_after_ms?: unknown }
  if (data.kind !== 'mcp_reload_in_progress') return undefined
  const requested =
    typeof data.retry_after_ms === 'number' && Number.isFinite(data.retry_after_ms) ? data.retry_after_ms : 250
  const backoff = requested * 2 ** Math.min(Math.max(attempt, 0), 10)
  return Math.min(2_000, Math.max(100, Math.round(backoff)))
}

export interface PreAdmissionRetryTimer {
  readonly epoch: () => number
  readonly cancel: () => void
  readonly schedule: (epoch: number, run: () => void, delayMs: number) => boolean
}

/** One process-local retry epoch. Cancellation synchronously invalidates both
 * an armed timer and any in-flight request continuation that could otherwise
 * re-arm after Ctrl+C writes its interrupt RPC. */
export function createPreAdmissionRetryTimer(): PreAdmissionRetryTimer {
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  const clear = (): void => {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }
  const cancel = (): void => {
    generation += 1
    clear()
  }
  return {
    epoch: () => generation,
    cancel,
    schedule(epoch, run, delayMs) {
      if (epoch !== generation) return false
      clear()
      timer = setTimeout(() => {
        timer = undefined
        if (epoch !== generation) return
        run()
      }, delayMs)
      timer.unref()
      return true
    }
  }
}

export function submitWhileBusy(host: BusySubmitHost, text: string, front = false): boolean {
  const mode = host.mode()
  if (mode === 'queue') return host.enqueue(text, front)

  const sid = host.sessionId()
  if (!sid) return host.enqueue(text, front)

  if (mode === 'interrupt') {
    if (!host.canRedirect(text, front)) {
      if (!host.enqueue(text, front)) return false
      host.setStatus('interrupting…')
      host.interrupt()
      return true
    }

    let request: Promise<InterruptCorrectionDelivery>
    try {
      request = host.redirect(sid, text, front)
    } catch {
      if (!host.enqueue(text, front)) return false
      host.setStatus('interrupting…')
      host.interrupt()
      return true
    }

    void request.then(
      outcome => {
        if (outcome === 'fallback') {
          host.setStatus('interrupting…')
        } else if (outcome === 'uncertain') {
          host.haltAutomaticDrain()
          host.pushSystem('correction delivery uncertain — message retained; send it explicitly to retry')
        } else if (outcome === 'retained') {
          host.pushSystem('correction fallback queue is full — input remains retained')
        }
      },
      () => {
        // Production totalizes typed gateway failures. Fail closed if an
        // unexpected promise defect escapes: retain locally and require an
        // explicit retry rather than risking a duplicate active-turn send.
        if (host.enqueue(text, front)) {
          host.haltAutomaticDrain()
          host.pushSystem('correction delivery uncertain — message retained; send it explicitly to retry')
        } else {
          host.pushSystem('correction delivery uncertain and queue is full — input remains retained')
        }
      }
    )
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
