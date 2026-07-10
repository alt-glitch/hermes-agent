import type { GatewayEvent } from '../boundary/schema/GatewayEvent.ts'

/**
 * Decide whether a decoded gateway event belongs to the active live session.
 *
 * Gateway lifecycle events are process-scoped and must always pass so recovery
 * can run. Events without a session id are likewise global/back-compatible.
 * A scoped event, however, is accepted only when there is an active session and
 * its id matches exactly. This is deliberately evaluated at the entry boundary,
 * before either the Solid reducer or any recovery side effect sees the event.
 */
export function eventBelongsToSession(event: GatewayEvent, activeSessionId: string | undefined): boolean {
  if (event.type.startsWith('gateway.')) return true
  const eventSessionId = event.session_id?.trim()
  if (!eventSessionId) return true
  return activeSessionId !== undefined && eventSessionId === activeSessionId
}

/**
 * During a transactional resume, admit every decoded event into the store's
 * buffer. The transaction filters that buffer by the returned live SID on
 * commit (or by the prior live SID on rollback). Filtering here would lose
 * target events emitted before the resume response updates transport identity.
 */
export function eventMayEnterStore(
  event: GatewayEvent,
  activeSessionId: string | undefined,
  buffering: boolean
): boolean {
  return buffering || eventBelongsToSession(event, activeSessionId)
}
