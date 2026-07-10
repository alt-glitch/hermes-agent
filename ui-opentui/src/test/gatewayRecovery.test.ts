/**
 * Recovery-budget policy test (LOGIC side, pure). The crash-loop bound: attempts
 * are capped within a sliding window, stale attempts are pruned, and a detached
 * UI still respawns without a resume target. Plus exponential backoff (1s→30s cap).
 */
import { describe, expect, test } from 'vitest'

import {
  backoffMs,
  GATEWAY_RECOVERY_LIMIT,
  GATEWAY_RECOVERY_WINDOW_MS,
  planGatewayRecovery
} from '../logic/gatewayRecovery.ts'

describe('planGatewayRecovery — crash-loop budget', () => {
  test('allows GATEWAY_RECOVERY_LIMIT attempts within the window, refuses the next', () => {
    const sid = 'sess-1'
    let attempts: number[] = []
    const now = 1_000_000

    // The first LIMIT exits all recover, each recording its timestamp.
    for (let i = 0; i < GATEWAY_RECOVERY_LIMIT; i++) {
      const plan = planGatewayRecovery(sid, null, attempts, now + i)
      expect(plan.recover).toBe(true)
      expect(plan.sid).toBe(sid)
      attempts = plan.attempts
    }
    expect(attempts).toHaveLength(GATEWAY_RECOVERY_LIMIT)

    // The (LIMIT+1)th within the window is refused; attempts are NOT extended.
    const refused = planGatewayRecovery(sid, null, attempts, now + GATEWAY_RECOVERY_LIMIT)
    expect(refused.recover).toBe(false)
    expect(refused.attempts).toHaveLength(GATEWAY_RECOVERY_LIMIT)
  })

  test('prunes attempts older than GATEWAY_RECOVERY_WINDOW_MS, freeing the budget', () => {
    const sid = 'sess-1'
    const now = 1_000_000
    // Three stale attempts (all outside the window) + one fresh.
    const stale = [now - GATEWAY_RECOVERY_WINDOW_MS - 5, now - GATEWAY_RECOVERY_WINDOW_MS - 4, now - 30_000]
    const plan = planGatewayRecovery(sid, null, stale, now)
    // The two truly-stale ones are pruned; the in-window one survives + `now` added.
    expect(plan.recover).toBe(true)
    expect(plan.attempts).toEqual([now - 30_000, now])
  })

  test('respawns within budget when detached, without inventing a resume target', () => {
    const plan = planGatewayRecovery(null, null, [], 1_000_000)
    expect(plan.recover).toBe(true)
    expect(plan.sid).toBeNull()
    expect(plan.attempts).toEqual([1_000_000])
  })

  test('falls back to the recoverSid when the live sid was already cleared', () => {
    const plan = planGatewayRecovery(null, 'pending-sess', [], 1_000_000)
    expect(plan.recover).toBe(true)
    expect(plan.sid).toBe('pending-sess')
  })
})

describe('backoffMs — exponential delay (1s→30s cap)', () => {
  test('doubles per attempt (1-based) and caps at 30000ms', () => {
    expect(backoffMs(1)).toBe(1000)
    expect(backoffMs(2)).toBe(2000)
    expect(backoffMs(3)).toBe(4000)
    expect(backoffMs(4)).toBe(8000)
    expect(backoffMs(5)).toBe(16000)
    expect(backoffMs(6)).toBe(30000) // 32000 clamped to the cap
    expect(backoffMs(10)).toBe(30000) // stays at the cap
  })

  test('clamps a non-positive attempt to the first delay', () => {
    expect(backoffMs(0)).toBe(1000)
    expect(backoffMs(-3)).toBe(1000)
  })
})
