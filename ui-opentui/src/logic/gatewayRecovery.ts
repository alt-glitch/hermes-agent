/**
 * Pure recovery-budget policy for the gateway exit handler (LOGIC side — no
 * Effect, no refs, no UI). Ported from Ink's `ui-tui/src/app/gatewayRecovery.ts`
 * and EXTENDED with opencode-style exponential backoff.
 *
 * A gateway that crash-loops on startup must not let the TUI spawn-storm, so
 * respawn+resume attempts are capped to GATEWAY_RECOVERY_LIMIT within a sliding
 * GATEWAY_RECOVERY_WINDOW_MS; past the budget the app falls back to the inert
 * "gateway exited" state. Kept pure (no refs/UI) so the bound — including the
 * crash-loop case — is unit-testable.
 */
export const GATEWAY_RECOVERY_LIMIT = 3
export const GATEWAY_RECOVERY_WINDOW_MS = 60_000

export interface RecoveryPlan {
  /** Attempt timestamps to persist (the pruned window, plus `now` iff respawning). */
  attempts: number[]
  /** Whether the gateway process may be respawned inside the crash-loop budget. */
  recover: boolean
  /**
   * Session to resume — the live sid, or the not-yet-consumed recovery target
   * when the live sid was already cleared by a prior exit.
   */
  sid: null | string
}

/**
 * Decide whether to respawn (and, when a SID exists, resume) after a gateway death. `liveSid` is the
 * current session (nulled on the first exit); `recoverSid` is a pending
 * recovery target carried across a respawn that died before gateway.ready —
 * so a startup crash-loop keeps retrying the same session up to the budget
 * instead of stranding it after one attempt.
 */
export function planGatewayRecovery(
  liveSid: null | string,
  recoverSid: null | string,
  attempts: number[],
  now: number
): RecoveryPlan {
  const sid = liveSid ?? recoverSid
  const recent = attempts.filter(t => now - t < GATEWAY_RECOVERY_WINDOW_MS)
  // A detached UI still needs a live gateway so /new and /resume can recover it.
  // The same crash-loop budget applies even when there is no session to resume.
  const recover = recent.length < GATEWAY_RECOVERY_LIMIT

  return { attempts: recover ? [...recent, now] : recent, recover, sid }
}

/**
 * Exponential backoff between respawn attempts (opencode-style): 1s, 2s, 4s, …
 * capped at 30s. `attempt` is 1-based (the first respawn waits 1s).
 */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000)
}
