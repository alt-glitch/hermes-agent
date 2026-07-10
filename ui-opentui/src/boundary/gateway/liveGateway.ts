/**
 * liveGateway — the GatewayService layer backed by the real Python `tui_gateway`
 * (spec v4 §2/§3.2). Adapts RawGatewayClient to GatewayServiceShape:
 *   - decodes each raw event ONCE with the GatewayEvent Schema
 *     (decodeUnknownOption → unrecognized/malformed events skipped, never crash),
 *   - coalesces decoded events on a 16ms debounce flushed inside Solid `batch()`
 *     so a burst of deltas is ONE repaint (opencode sdk.tsx:54-80),
 *   - tracks the session id (set from session.create/resume result) for
 *     approval.respond {session_id},
 *   - maps request failures to a typed GatewayError (never throws).
 *
 * The 16ms batch + `batch()` call is the boundary handing decoded events to
 * Solid — one of the two approved Effect<->Solid contact points (spec v4 §1).
 */
import { Effect, Layer, Option, Schema } from 'effect'
import { batch } from 'solid-js'

import { backoffMs, planGatewayRecovery } from '../../logic/gatewayRecovery.ts'
import { GatewayError } from '../errors.ts'
import { getLog } from '../log.ts'
import { GatewayEventSchema, type GatewayEvent } from '../schema/GatewayEvent.ts'
import { GatewayService, type GatewayServiceShape } from './GatewayService.ts'
import { RawGatewayClient } from './client.ts'

const COALESCE_MS = 16

const decodeEvent = Schema.decodeUnknownOption(GatewayEventSchema)

/**
 * Advance the transport's authoritative live-session id after a successful RPC.
 * `session.close` is as important as create/resume: retaining a closed id makes
 * every later prompt/approval target a dead session if replacement creation
 * fails. Closing some other live session must not disturb the active one.
 */
export function trackedSessionIdAfterRequest(
  current: string | undefined,
  method: string,
  params: unknown,
  result: unknown
): string | undefined {
  if ((method === 'session.create' || method === 'session.resume') && result && typeof result === 'object') {
    const sid = (result as { session_id?: unknown }).session_id
    return typeof sid === 'string' && sid.trim() ? sid.trim() : current
  }
  if (method === 'session.close' && params && typeof params === 'object') {
    const target = (params as { session_id?: unknown }).session_id
    if (typeof target === 'string' && target === current) return undefined
  }
  return current
}

function makeLiveGateway(): { service: GatewayServiceShape; stop: () => void } {
  const log = getLog()
  const handlers = new Set<(event: GatewayEvent) => void>()
  let sessionId: string | undefined

  // Auto-heal recovery state (driver below). `recoverSid` is the resume target
  // carried across a respawn that died before gateway.ready; `recoveryAttempts`
  // is the sliding crash-loop budget window; `restartTimer` is the pending
  // backoff respawn (cleared on teardown so it can't fire post-stop).
  let recoverSid: string | undefined
  let recoveryAttempts: number[] = []
  let restartTimer: ReturnType<typeof setTimeout> | undefined

  // 16ms event coalescing → one batched repaint (opencode sdk.tsx model).
  let queue: GatewayEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  const flush = () => {
    timer = undefined
    if (queue.length === 0) return
    const events = queue
    queue = []
    last = Date.now()
    batch(() => {
      for (const event of events) {
        for (const handler of handlers) handler(event)
      }
    })
  }

  const enqueue = (event: GatewayEvent) => {
    queue.push(event)
    if (timer) return
    // If we flushed recently (<16ms ago) batch with near-future events; else flush now.
    if (Date.now() - last < COALESCE_MS) {
      timer = setTimeout(flush, COALESCE_MS)
    } else {
      flush()
    }
  }

  const onRawEvent = (params: unknown) => {
    const decoded = decodeEvent(params)
    if (Option.isNone(decoded)) {
      const t = (params as { type?: unknown } | null)?.type
      log.debug('gateway', 'skipped undecodable event', { type: typeof t === 'string' ? t : '(none)' })
      return
    }
    enqueue(decoded.value)
  }

  // Recovery driver: on a child exit, clear the frozen spinner (via the store's
  // gateway.exited case), then — under the crash-loop budget — respawn the child
  // on exponential backoff. The post-respawn gateway.ready triggers the re-resume
  // (driven from entry's subscribe callback). Hoisted so it can be passed to
  // `new RawGatewayClient` below while itself referencing the `client` const —
  // `client` is assigned by the time onExit ever fires at runtime.
  function onExit(reason: string): void {
    log.warn('gateway', 'transport exited', { reason })
    // Clears the frozen spinner + shows status (store handles gateway.exited).
    enqueue({ type: 'gateway.exited', payload: { reason } })
    const exitedSessionId = sessionId
    // The ephemeral id belonged to the dead Python process. Recovery resumes by
    // the store's persisted key; retaining this id makes the new gateway waste a
    // guaranteed-failing session.close and misroutes any early UI action.
    sessionId = undefined
    const plan = planGatewayRecovery(exitedSessionId ?? null, recoverSid ?? null, recoveryAttempts, Date.now())
    recoveryAttempts = plan.attempts
    if (!plan.recover) {
      enqueue({ type: 'error', payload: { message: 'gateway exited repeatedly — restart the TUI to retry' } })
      return
    }
    recoverSid = plan.sid ?? undefined
    const attempt = recoveryAttempts.length
    const delay = backoffMs(attempt)
    enqueue({ type: 'gateway.recovering', payload: { attempt, delay_ms: delay } })
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      client.start()
    }, delay)
  }

  const client = new RawGatewayClient({
    log,
    onEvent: onRawEvent,
    onExit
  })

  const service: GatewayServiceShape = {
    subscribe: handler =>
      Effect.sync(() => {
        handlers.add(handler)
        // Lazily spawn on first subscription so the child + its gateway.ready land.
        client.start()
        return () => {
          handlers.delete(handler)
        }
      }),

    request: <A>(method: string, params: unknown) =>
      Effect.tryPromise({
        try: () => client.request<A>(method, params),
        catch: cause => {
          const message = cause instanceof Error ? cause.message : String(cause)
          const reason = message.startsWith('timeout:')
            ? ('timeout' as const)
            : message.includes('not running') || message.includes('stopping')
              ? ('transport-down' as const)
              : ('rpc-error' as const)
          return new GatewayError({ method, reason, message })
        }
      }).pipe(
        // Keep the live routing id aligned with create/resume/close so prompts,
        // approvals, interrupts, and crash recovery never target a closed SID.
        Effect.tap(result =>
          Effect.sync(() => {
            const previous = sessionId
            sessionId = trackedSessionIdAfterRequest(sessionId, method, params, result)
            if ((method === 'session.create' || method === 'session.resume') && sessionId !== previous) {
              recoverSid = undefined
            } else if (method === 'session.close' && previous !== undefined && sessionId === undefined) {
              recoverSid = undefined
            }
          })
        )
      ),

    sessionId: () => sessionId
  }

  // Clear a pending coalesce timer on teardown so a queued flush() can't fire
  // batch()/handlers into a torn-down store after the layer scope releases.
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    // Also kill any pending backoff respawn so it can't fire after teardown.
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = undefined
    client.stop()
  }
  return { service, stop }
}

/**
 * The live GatewayService layer (spawns + talks to the real Python tui_gateway).
 * Scoped so the child process is stopped (stdin EOF → exit) on scope teardown —
 * no orphaned gateway children when the renderer is destroyed.
 */
export const liveGatewayLayer: Layer.Layer<GatewayService> = Layer.effect(
  GatewayService,
  Effect.acquireRelease(Effect.sync(makeLiveGateway), ({ stop }) => Effect.sync(stop)).pipe(
    Effect.map(({ service }) => service)
  )
)
