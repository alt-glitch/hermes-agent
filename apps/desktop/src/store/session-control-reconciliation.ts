interface SessionReconciliation {
  eventFence: number | undefined
  eventVersion: number
  requestVersion: number
}

export interface SessionControlRequestToken {
  epoch: number
  version: number
}

let epoch = 0
const reconciliationBySession = new Map<string, SessionReconciliation>()

function reconciliationFor(sessionId: string): SessionReconciliation {
  const current = reconciliationBySession.get(sessionId)

  if (current) {
    return current
  }

  const created: SessionReconciliation = {
    eventFence: undefined,
    eventVersion: 0,
    requestVersion: 0
  }

  reconciliationBySession.set(sessionId, created)

  return created
}

export function advanceSessionControlRequest(sessionId: string): SessionControlRequestToken {
  const reconciliation = reconciliationFor(sessionId)
  reconciliation.requestVersion += 1

  return { epoch, version: reconciliation.requestVersion }
}

export function isCurrentSessionControlRequest(sessionId: string, token: SessionControlRequestToken): boolean {
  return token.epoch === epoch && (reconciliationBySession.get(sessionId)?.requestVersion ?? 0) === token.version
}

export function currentSessionControlEventVersion(sessionId: string): number {
  return reconciliationBySession.get(sessionId)?.eventVersion ?? 0
}

/** Records an accepted event, returning false without mutation when its sequence is fenced out. */
export function acceptSessionControlEvent(sessionId: string, eventSeq: number | undefined): boolean {
  const current = reconciliationBySession.get(sessionId)

  if (eventSeq !== undefined && current?.eventFence !== undefined && eventSeq <= current.eventFence) {
    return false
  }

  const reconciliation = current ?? reconciliationFor(sessionId)
  reconciliation.eventVersion += 1

  if (eventSeq !== undefined) {
    reconciliation.eventFence = eventSeq
  }

  return true
}

export function recordSessionControlSnapshot(sessionId: string, eventSeq: number | undefined): void {
  const reconciliation = reconciliationFor(sessionId)
  reconciliation.requestVersion += 1

  if (eventSeq !== undefined) {
    reconciliation.eventFence = eventSeq
  }
}

export function clearSessionControlReconciliation(sessionId: string): void {
  const reconciliation = reconciliationFor(sessionId)
  reconciliation.requestVersion += 1
  reconciliation.eventFence = undefined
}

export function clearAllSessionControlReconciliation(): void {
  epoch += 1
  reconciliationBySession.clear()
}
