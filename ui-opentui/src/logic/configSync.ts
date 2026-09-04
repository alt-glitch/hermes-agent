/** Revision-aware live-config synchronization state.
 *
 * Config mtime controls local display hydration. MCP reloads are controlled by
 * the gateway's independent `mcp_rev`: cosmetic writes still hydrate config,
 * but they never reconnect MCP servers. A revision is accepted only after the
 * gateway confirms `status: reloaded`, so transient failures remain retryable
 * on the next poll even when mtime no longer changes.
 */

export type ConfigSyncKind = 'baseline' | 'change'

/** `display.status_bar.fields` visibility filter. `null` means the user has
 * not supplied a usable filter, so the status bar renders its default set. */
export type StatusBarFields = ReadonlySet<string> | null

/** Ink-compatible `display.status_bar.fields` normalization. A non-empty list
 * filters named segments; missing, empty, or wholly blank/malformed input uses
 * defaults. Unknown names survive harmlessly because the renderer only checks
 * the names it understands. */
export function normalizeStatusBarFields(raw: unknown): StatusBarFields {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const cleaned = raw.map(value => String(value).trim().toLowerCase()).filter(Boolean)
  return cleaned.length > 0 ? new Set(cleaned) : null
}

export interface ConfigSyncPlan {
  readonly kind: ConfigSyncKind
  readonly mcpRev: string
  readonly mtime: number
  /** True until this MCP revision has been confirmed loaded. */
  readonly reload: boolean
}

export interface ConfigSyncTracker {
  /** Last revision confirmed by boot baseline or a successful reload. */
  readonly acceptedMcpRev: () => string
  /** Commit a successfully decoded, active-session config hydration. */
  readonly completeHydration: (plan: ConfigSyncPlan, succeeded: boolean) => boolean
  /** Accept only an authoritative reload response, using its loaded_rev. */
  readonly completeReload: (plan: ConfigSyncPlan, response: unknown) => boolean
  readonly observedMtime: () => number
  /** Return the next safe phase, or undefined while busy/unchanged. */
  readonly plan: (nextMtime: number, nextMcpRev: string, busy: boolean) => ConfigSyncPlan | undefined
}

interface PendingSync {
  kind: ConfigSyncKind
  mcpRev: string
  mtime: number
  reloadComplete: boolean
}

function validMtime(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function responseRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

export function configSyncBlocked(turnBusy: boolean, sessionTransitioning: boolean): boolean {
  return turnBusy || sessionTransitioning
}

export function mcpReloadSucceeded(value: unknown): boolean {
  return responseRecord(value)?.status === 'reloaded'
}

/** The revision the gateway actually loaded. Older revision-aware gateways may
 * omit loaded_rev, in which case the requested revision is the best available
 * acknowledgement. Non-reloaded responses never produce an accepted value. */
export function mcpLoadedRevision(value: unknown, requestedRev: string): string | undefined {
  const response = responseRecord(value)
  if (response?.status !== 'reloaded') return undefined
  const loaded = typeof response.loaded_rev === 'string' ? response.loaded_rev.trim() : ''
  return loaded || requestedRev
}

export function createConfigSyncTracker(): ConfigSyncTracker {
  let observedMtime = 0
  let acceptedMcpRev = ''
  let pending: PendingSync | undefined

  const matches = (plan: ConfigSyncPlan): boolean =>
    pending !== undefined &&
    pending.kind === plan.kind &&
    pending.mtime === plan.mtime &&
    pending.mcpRev === plan.mcpRev

  return {
    acceptedMcpRev: () => acceptedMcpRev,

    completeHydration(plan, succeeded) {
      if (!succeeded || !matches(plan) || !pending?.reloadComplete) return false
      observedMtime = plan.mtime
      pending = undefined
      return true
    },

    completeReload(plan, response) {
      if (!plan.reload || !matches(plan) || pending?.kind !== 'change') return false
      const loadedRev = mcpLoadedRevision(response, plan.mcpRev)
      if (loadedRev === undefined) return false
      // Empty revisions are the legacy mtime-only path. There is no revision
      // acknowledgement to advance, but the authoritative status still proves
      // that this reload phase completed.
      if (loadedRev) acceptedMcpRev = loadedRev
      pending.reloadComplete = true
      return true
    },

    observedMtime: () => observedMtime,

    plan(nextMtime, nextMcpRev, busy) {
      if (busy || !validMtime(nextMtime)) return undefined
      const mcpRev = nextMcpRev.trim()

      // The first observation describes the registry built during session
      // startup. Seed it as a baseline rather than needlessly reloading it.
      if (observedMtime === 0 && acceptedMcpRev === '' && mcpRev) acceptedMcpRev = mcpRev

      const unchanged = nextMtime === observedMtime && (!mcpRev || mcpRev === acceptedMcpRev)
      if (pending === undefined && unchanged) return undefined

      if (pending?.mtime !== nextMtime || pending.mcpRev !== mcpRev) {
        const kind: ConfigSyncKind = observedMtime === 0 ? 'baseline' : 'change'
        const reload = kind === 'change' && (!mcpRev || mcpRev !== acceptedMcpRev)
        pending = { kind, mcpRev, mtime: nextMtime, reloadComplete: !reload }
      }

      return {
        kind: pending.kind,
        mcpRev: pending.mcpRev,
        mtime: pending.mtime,
        reload: !pending.reloadComplete
      }
    }
  }
}
