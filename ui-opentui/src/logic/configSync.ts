/** Two-phase live-config synchronization state.
 *
 * A changed config file requires an idle-only MCP reload followed by a full
 * config hydration. The observed mtime advances only after both phases finish.
 * Keeping the phases separate is important: if hydration fails after a
 * successful reload, the next poll retries hydration without mutating the
 * process-global MCP registry a second time.
 */

export type ConfigSyncKind = 'baseline' | 'change'

export interface ConfigSyncPlan {
  readonly kind: ConfigSyncKind
  readonly mtime: number
  /** True only until the changed mtime has completed its MCP reload. */
  readonly reload: boolean
}

export interface ConfigSyncTracker {
  /** Commit a successfully decoded, active-session config hydration. */
  readonly completeHydration: (plan: ConfigSyncPlan, succeeded: boolean) => boolean
  /** Record the result of the process-global MCP reload phase. */
  readonly completeReload: (plan: ConfigSyncPlan, succeeded: boolean) => boolean
  readonly observedMtime: () => number
  /** Return the next safe phase, or undefined while busy/unchanged. */
  readonly plan: (nextMtime: number, busy: boolean) => ConfigSyncPlan | undefined
}

interface PendingSync {
  kind: ConfigSyncKind
  mtime: number
  reloadComplete: boolean
}

function validMtime(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

export function configSyncBlocked(turnBusy: boolean, sessionTransitioning: boolean): boolean {
  return turnBusy || sessionTransitioning
}

export function mcpReloadSucceeded(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'status' in value && value.status === 'reloaded'
}

export function createConfigSyncTracker(): ConfigSyncTracker {
  let observedMtime = 0
  let pending: PendingSync | undefined

  const matches = (plan: ConfigSyncPlan): boolean =>
    pending !== undefined && pending.kind === plan.kind && pending.mtime === plan.mtime

  return {
    completeHydration(plan, succeeded) {
      if (!succeeded || !matches(plan) || !pending?.reloadComplete) return false
      observedMtime = plan.mtime
      pending = undefined
      return true
    },

    completeReload(plan, succeeded) {
      if (!succeeded || !plan.reload || !matches(plan) || pending?.kind !== 'change') return false
      pending.reloadComplete = true
      return true
    },

    observedMtime: () => observedMtime,

    plan(nextMtime, busy) {
      if (busy || !validMtime(nextMtime)) return undefined
      if (pending === undefined && nextMtime === observedMtime) return undefined

      if (pending?.mtime !== nextMtime) {
        const kind: ConfigSyncKind = observedMtime === 0 ? 'baseline' : 'change'
        pending = {
          kind,
          mtime: nextMtime,
          // Establishing the first baseline only hydrates local config. Every
          // subsequent distinct mtime must reload MCP before it can commit.
          reloadComplete: kind === 'baseline'
        }
      }

      return {
        kind: pending.kind,
        mtime: pending.mtime,
        reload: !pending.reloadComplete
      }
    }
  }
}
