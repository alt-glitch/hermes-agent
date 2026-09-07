import { applySessionControlUpdate } from '@/store/session-control'

import type { GatewayEventContext } from './types'

export function handleControlEvent(ctx: GatewayEventContext): boolean {
  const { event, payload, sessionId } = ctx

  if (event.type !== 'session.control.update') {
    return false
  }

  // A socket from the previous gateway can deliver after the store was cleared.
  if (!sessionId || !ctx.fromActiveSource()) {
    return true
  }

  const control = payload && typeof payload === 'object' ? (payload as { control?: unknown }).control : undefined
  applySessionControlUpdate(sessionId, control, (event as { seq?: unknown }).seq)

  return true
}
