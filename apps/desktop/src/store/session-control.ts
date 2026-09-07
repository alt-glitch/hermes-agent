import { atom } from 'nanostores'

import { $gateway } from './gateway'
import { refreshSessionGoal } from './goals'
import { isSessionGone, isSessionGoneForBackgroundPolling, markSessionGone } from './runtime-gone'
import {
  acceptSessionControlEvent,
  acceptSessionControlSnapshot,
  advanceSessionControlRequest,
  clearAllSessionControlReconciliation,
  clearSessionControlReconciliation,
  currentSessionControlEventVersion,
  isCurrentSessionControlRequest,
  type SessionControlRequestToken
} from './session-control-reconciliation'
import {
  parseSessionControlActionResponse,
  parseSessionControlEventSequence,
  parseSessionControlReadResponse,
  parseSessionControlSnapshot
} from './session-control-wire'
import { ambientRequestFor } from './session-gone-latch'
import { requestForOwnedSession } from './session-states'

export { parseSessionControlSnapshot } from './session-control-wire'

export type SessionControlGoalStatus = 'active' | 'done' | 'paused'
export type SessionControlLoopMode = 'interval' | 'self_paced'
export type SessionControlLoopStatus = 'active' | 'done' | 'paused'
export type SessionControlHeartbeatStatus = 'active' | 'paused'

export interface SessionControlGoalContract {
  boundaries: string
  constraints: string
  outcome: string
  stop_when: string
  verification: string
}

export interface SessionControlGate {
  attempts: number
  command: string
  last_exit_code: number | null
  max_retries: number
  timeout_seconds: number
}

export type SessionControlWaitBarrier =
  | { reason: string; type: 'until'; until_at: number }
  | { reason: string; target: string; type: 'session' }
  | { reason: string; target: number; type: 'pid' }

export interface SessionControlGoal {
  contract: SessionControlGoalContract
  gates: SessionControlGate[]
  last_reason?: string
  last_verdict?: 'blocked' | 'continue' | 'done' | 'skipped' | 'wait'
  max_turns: number
  paused_reason?: string
  status: SessionControlGoalStatus
  subgoals: string[]
  title: string
  turns_used: number
  updated_at?: number
  wait_barrier?: SessionControlWaitBarrier
  created_at?: number
}

export interface SessionControlLoop {
  awaiting_response: boolean
  created_at: number
  current_delay: number
  deferred_by_goal: boolean
  interval_seconds: number
  last_fired_at: number
  last_stop_reason?: string
  max_ticks: number
  mode: SessionControlLoopMode
  next_due_at: number
  paused_reason?: string
  prompt: string
  status: SessionControlLoopStatus
  ticks_fired: number
  times: number
  until: string
}

export interface SessionControlHeartbeat {
  created_at: number
  fire_count: number
  interval_seconds: number
  last_fired_at: number
  prompt: string
  status: SessionControlHeartbeatStatus
}

export interface SessionControlSnapshot {
  goal: SessionControlGoal | null
  heartbeat: SessionControlHeartbeat | null
  loop: SessionControlLoop | null
  revision: string
  updated_at: number
}

export type SessionControlAction =
  | 'goal.clear'
  | 'goal.pause'
  | 'goal.resume'
  | 'goal.unwait'
  | 'heartbeat.clear'
  | 'heartbeat.pause'
  | 'heartbeat.resume'
  | 'loop.pause'
  | 'loop.resume'
  | 'loop.stop'
  | 'subgoal.add'
  | 'subgoal.clear'
  | 'subgoal.remove'

export type SessionControlActionArgs = { index: number } | { text: string }

export interface SessionControlDispatch {
  display: string | null
  message: string | null
  notice: string | null
  output: string | null
  type: 'exec' | 'send'
}

export interface SessionControlEntry {
  capability: 'unknown' | 'supported' | 'unsupported'
  error: string | null
  loading: boolean
  pendingAction: SessionControlAction | null
  snapshot: SessionControlSnapshot | null
}

interface RefreshOptions {
  background?: boolean
}

type UnknownRecord = Record<string, unknown>
const ERROR_LIMIT = 240

export const $sessionControlBySession = atom<Record<string, SessionControlEntry>>({})

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function emptyEntry(): SessionControlEntry {
  return { capability: 'unknown', error: null, loading: false, pendingAction: null, snapshot: null }
}

function sameEntry(first: SessionControlEntry, second: SessionControlEntry): boolean {
  return (
    first.capability === second.capability &&
    first.error === second.error &&
    first.loading === second.loading &&
    first.pendingAction === second.pendingAction &&
    first.snapshot === second.snapshot
  )
}

function publishEntry(sessionId: string, next: SessionControlEntry): SessionControlEntry {
  const entries = $sessionControlBySession.get()
  const current = entries[sessionId]

  if (current && sameEntry(current, next)) {
    return current
  }

  $sessionControlBySession.set({ ...entries, [sessionId]: next })

  return next
}

function applyParsedSnapshot(
  sessionId: string,
  snapshot: SessionControlSnapshot,
  eventSeq?: number
): SessionControlEntry {
  const applySnapshot = acceptSessionControlSnapshot(sessionId, eventSeq)

  const current = $sessionControlBySession.get()[sessionId] ?? emptyEntry()
  const nextSnapshot = !applySnapshot || current.snapshot?.revision === snapshot.revision ? current.snapshot : snapshot

  return publishEntry(sessionId, {
    capability: 'supported',
    error: null,
    loading: false,
    pendingAction: null,
    snapshot: nextSnapshot
  })
}

/** Applies a valid read/action snapshot and marks its session as supported. */
export function applySessionControlSnapshot(
  sessionId: string,
  rawSnapshot: unknown,
  rawEventSeq?: unknown
): SessionControlEntry | undefined {
  if (!sessionId) {
    return undefined
  }

  const snapshot = parseSessionControlSnapshot(rawSnapshot)

  return snapshot ? applyParsedSnapshot(sessionId, snapshot, parseSessionControlEventSequence(rawEventSeq)) : undefined
}

/** Applies an event update; invalid updates are deliberately a claimed no-op. */
export function applySessionControlUpdate(
  sessionId: string,
  rawSnapshot: unknown,
  rawEventSeq?: unknown
): SessionControlEntry | undefined {
  if (!sessionId) {
    return undefined
  }

  const snapshot = parseSessionControlSnapshot(rawSnapshot)

  if (!snapshot) {
    return undefined
  }

  const current = $sessionControlBySession.get()[sessionId] ?? emptyEntry()
  const actionIsPending = current.pendingAction !== null
  const eventSeq = parseSessionControlEventSequence(rawEventSeq)

  if (!acceptSessionControlEvent(sessionId, eventSeq)) {
    return current
  }

  if (!actionIsPending) {
    advanceSessionControlRequest(sessionId)
  }

  const nextSnapshot = current.snapshot?.revision === snapshot.revision ? current.snapshot : snapshot

  return publishEntry(sessionId, {
    ...current,
    capability: 'supported',
    error: null,
    loading: actionIsPending ? current.loading : false,
    pendingAction: actionIsPending ? current.pendingAction : null,
    snapshot: nextSnapshot
  })
}

/** Drops one runtime session's entry when the session record is closed/deleted. */
export function clearSessionControl(sessionId: string): void {
  if (!sessionId) {
    return
  }

  clearSessionControlReconciliation(sessionId)
  const entries = $sessionControlBySession.get()

  if (!(sessionId in entries)) {
    return
  }

  const { [sessionId]: _removed, ...remaining } = entries
  $sessionControlBySession.set(remaining)
}

/**
 * Wipes every entry — the gateway-switch seam. Entries are keyed by runtime
 * session id and a different backend mints new ids, so nothing here can be
 * reused; in-flight reads/actions from the old backend are invalidated by the
 * version bump so a late response cannot repopulate the map.
 */
export function clearAllSessionControl(): void {
  clearAllSessionControlReconciliation()
  $sessionControlBySession.set({})
}

function beginRead(sessionId: string, background: boolean): SessionControlRequestToken {
  const token = advanceSessionControlRequest(sessionId)
  const current = $sessionControlBySession.get()[sessionId] ?? emptyEntry()

  publishEntry(sessionId, {
    ...current,
    error: null,
    loading: background ? current.loading : true
  })

  return token
}

function beginAction(sessionId: string, action: SessionControlAction): SessionControlRequestToken {
  const token = advanceSessionControlRequest(sessionId)
  const current = $sessionControlBySession.get()[sessionId] ?? emptyEntry()

  publishEntry(sessionId, {
    ...current,
    error: null,
    loading: true,
    pendingAction: action
  })

  return token
}

function boundedError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : isRecord(error) && typeof error.message === 'string'
        ? error.message
        : 'Session control request failed'

  return message.trim().slice(0, ERROR_LIMIT) || 'Session control request failed'
}

function publishFailure(
  sessionId: string,
  token: SessionControlRequestToken,
  error: unknown,
  clearPendingAction: boolean
): void {
  if (!isCurrentSessionControlRequest(sessionId, token)) {
    return
  }

  const current = $sessionControlBySession.get()[sessionId] ?? emptyEntry()
  publishEntry(sessionId, {
    ...current,
    error: boundedError(error),
    loading: false,
    pendingAction: clearPendingAction ? null : current.pendingAction
  })
}

function finishGoneRequest(sessionId: string, token: SessionControlRequestToken, clearPendingAction: boolean): void {
  if (!isCurrentSessionControlRequest(sessionId, token)) {
    return
  }

  markSessionGone(sessionId)
  const current = $sessionControlBySession.get()[sessionId] ?? emptyEntry()
  publishEntry(sessionId, {
    ...current,
    loading: false,
    pendingAction: clearPendingAction ? null : current.pendingAction
  })
}

function markUnsupported(sessionId: string, token: SessionControlRequestToken): boolean {
  if (!isCurrentSessionControlRequest(sessionId, token)) {
    return false
  }

  const current = $sessionControlBySession.get()[sessionId] ?? emptyEntry()

  if (current.capability === 'unsupported') {
    return false
  }

  advanceSessionControlRequest(sessionId)
  publishEntry(sessionId, {
    ...current,
    capability: 'unsupported',
    error: null,
    loading: false,
    pendingAction: null
  })

  return true
}

function isMethodNotFound(error: unknown): boolean {
  if (isRecord(error) && error.code === -32601) {
    return true
  }

  const message =
    error instanceof Error ? error.message : isRecord(error) && typeof error.message === 'string' ? error.message : ''

  return message.toLowerCase().includes('method not found') || message.toLowerCase().includes('method-not-found')
}

/** Hydrates one session's structured controls; background refreshes never flash a loading state. */
export async function refreshSessionControl(
  sessionId: string,
  options: RefreshOptions = {}
): Promise<SessionControlEntry | undefined> {
  const existing = $sessionControlBySession.get()[sessionId]

  if (!sessionId || existing?.capability === 'unsupported' || isSessionGone(sessionId)) {
    return existing
  }

  const gateway = $gateway.get()

  if (!gateway) {
    return existing
  }

  const token = beginRead(sessionId, Boolean(options.background))

  try {
    const response = await requestForOwnedSession<unknown>(
      sessionId,
      ambientRequestFor(gateway),
      'session.control.read',
      { session_id: sessionId }
    )

    if (!isCurrentSessionControlRequest(sessionId, token)) {
      return $sessionControlBySession.get()[sessionId]
    }

    const parsed = parseSessionControlReadResponse(response)

    if (!parsed) {
      publishFailure(sessionId, token, new Error('Invalid session.control.read response'), false)

      return $sessionControlBySession.get()[sessionId]
    }

    return applyParsedSnapshot(sessionId, parsed.snapshot, parsed.eventSeq)
  } catch (error) {
    if (!isCurrentSessionControlRequest(sessionId, token)) {
      return $sessionControlBySession.get()[sessionId]
    }

    if (isMethodNotFound(error)) {
      const transitioned = markUnsupported(sessionId, token)

      if (transitioned) {
        await refreshSessionGoal(sessionId)
      }

      return $sessionControlBySession.get()[sessionId]
    }

    if (isSessionGoneForBackgroundPolling(error)) {
      finishGoneRequest(sessionId, token, false)

      return $sessionControlBySession.get()[sessionId]
    }

    publishFailure(sessionId, token, error, false)

    return $sessionControlBySession.get()[sessionId]
  }
}

/** Runs an allowlisted backend control action; callers own any composer/UI dispatch. */
export async function runSessionControlAction(
  sessionId: string,
  action: SessionControlAction,
  args?: SessionControlActionArgs
): Promise<SessionControlDispatch> {
  if (!sessionId) {
    throw new Error('A session id is required for session control')
  }

  if (isSessionGone(sessionId)) {
    throw new Error('Session not found')
  }

  const gateway = $gateway.get()

  if (!gateway) {
    throw new Error('Session control gateway is unavailable')
  }

  const eventVersion = currentSessionControlEventVersion(sessionId)
  const token = beginAction(sessionId, action)

  try {
    const response = await requestForOwnedSession<unknown>(sessionId, ambientRequestFor(gateway), 'session.control', {
      action,
      args: args ?? {},
      session_id: sessionId
    })

    const parsed = parseSessionControlActionResponse(response)

    if (!parsed) {
      const error = new Error('Invalid session.control action response')
      publishFailure(sessionId, token, error, true)
      throw error
    }

    if (isCurrentSessionControlRequest(sessionId, token)) {
      applyParsedSnapshot(sessionId, parsed.snapshot, parsed.eventSeq)
    }

    return parsed.dispatch
  } catch (error) {
    if (isMethodNotFound(error)) {
      const transitioned =
        eventVersion === currentSessionControlEventVersion(sessionId) ? markUnsupported(sessionId, token) : false

      if (transitioned) {
        await refreshSessionGoal(sessionId)
      } else {
        publishFailure(sessionId, token, error, true)
      }
    } else if (isSessionGoneForBackgroundPolling(error)) {
      finishGoneRequest(sessionId, token, true)
    } else {
      publishFailure(sessionId, token, error, true)
    }

    throw error
  }
}

/** Refreshes only sessions already proven to support the structured-control RPC. */
export async function refreshSupportedSessionControlAfterTurn(sessionId: string): Promise<void> {
  if (!sessionId || $sessionControlBySession.get()[sessionId]?.capability !== 'supported') {
    return
  }

  await refreshSessionControl(sessionId, { background: true })
}
