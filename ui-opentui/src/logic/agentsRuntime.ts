/**
 * Process-boundary coordinators for the Agents surface.
 *
 * The store owns deterministic state; the entry owns gateway Effects. These
 * small promise coordinators keep serialization/throttling testable without
 * giving Solid reducers transport responsibilities.
 */
import type { SpawnTreeSaveIntent } from './store.ts'

function safely(call: (() => void) | undefined): void {
  try {
    call?.()
  } catch {
    // Diagnostics must never break the control path they observe.
  }
}

export interface SpawnTreeSaveDrainerOptions {
  readonly next: () => SpawnTreeSaveIntent | undefined
  readonly settle: (snapshotId: string) => boolean
  readonly save: (request: SpawnTreeSaveIntent['request']) => Promise<unknown>
  readonly onSaveFailure?: (snapshotId: string, cause: unknown) => void
  readonly onInvariantFailure?: (snapshotId: string, cause?: unknown) => void
}

export interface SpawnTreeSaveDrainer {
  /** Coalesces concurrent calls onto one serial drain. Never rejects. */
  readonly drain: () => Promise<void>
  /** A settlement invariant failure blocks automatic retries (prevents spin). */
  readonly isBlocked: () => boolean
}

/**
 * Drain process-global persistence intents one at a time. A save failure is
 * best-effort and still settles; an inability to settle blocks the coordinator
 * so the same head can never hot-loop.
 */
export function createSpawnTreeSaveDrainer(options: SpawnTreeSaveDrainerOptions): SpawnTreeSaveDrainer {
  let active: Promise<void> | undefined
  let blocked = false

  const runLoop = async (): Promise<void> => {
    let currentId = '<none>'
    try {
      while (!blocked) {
        const intent = options.next()
        if (intent === undefined) return
        currentId = intent.snapshotId
        try {
          await options.save(intent.request)
        } catch (cause) {
          safely(() => options.onSaveFailure?.(intent.snapshotId, cause))
        }
        if (!options.settle(intent.snapshotId)) {
          // The bounded pending FIFO may intentionally evict this old in-flight
          // id while `save` awaits I/O. If the head advanced (or emptied), the
          // completed save is already definitive and draining can continue.
          // Only a false settlement that leaves the SAME head is a spin risk.
          const head = options.next()
          if (head?.snapshotId === intent.snapshotId) {
            blocked = true
            safely(() => options.onInvariantFailure?.(intent.snapshotId))
            return
          }
        }
      }
    } catch (cause) {
      blocked = true
      safely(() => options.onInvariantFailure?.(currentId, cause))
    }
  }

  const drain = (): Promise<void> => {
    if (blocked) return Promise.resolve()
    if (active !== undefined) return active

    const run = runLoop().finally(() => {
      if (active === run) active = undefined
      if (blocked) return
      let hasNext = false
      try {
        hasNext = options.next() !== undefined
      } catch (cause) {
        blocked = true
        safely(() => options.onInvariantFailure?.('<next>', cause))
      }
      // Close the small race where an intent is enqueued after runLoop sees an
      // empty queue but before `active` is released.
      if (hasNext) queueMicrotask(() => void drain())
    })
    active = run
    return run
  }

  return { drain, isBlocked: () => blocked }
}

export interface DelegationStatusRefresherOptions {
  readonly apply: (response: unknown) => boolean
  readonly fetch: () => Promise<unknown>
  readonly intervalMs?: number
  readonly now?: () => number
  readonly onFailure?: (cause: unknown) => void
  readonly onInvalid?: () => void
}

export interface DelegationStatusRefresher {
  /** True only when a fetched response decoded and applied. */
  readonly refresh: (force?: boolean) => Promise<boolean>
  /** Invalidate a dead gateway generation and allow an immediate replacement read. */
  readonly invalidate: () => void
}

/** Ink-compatible at-most-once-per-window status fetch with in-flight dedupe. */
export function createDelegationStatusRefresher(options: DelegationStatusRefresherOptions): DelegationStatusRefresher {
  const configuredInterval = options.intervalMs ?? 5_000
  const intervalMs = Number.isFinite(configuredInterval) ? Math.max(0, configuredInterval) : 5_000
  const now = options.now ?? Date.now
  let lastFetchAt: number | undefined
  let active: Promise<boolean> | undefined
  let generation = 0

  const refresh = (force = false): Promise<boolean> => {
    if (active !== undefined) return active
    const current = now()
    if (!force && lastFetchAt !== undefined && current >= lastFetchAt && current - lastFetchAt < intervalMs) {
      return Promise.resolve(false)
    }
    lastFetchAt = current
    const requestGeneration = generation

    let fetched: Promise<unknown>
    try {
      fetched = options.fetch()
    } catch (cause) {
      fetched = Promise.reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
    const request = fetched
      .then(response => {
        if (requestGeneration !== generation) return false
        const applied = options.apply(response)
        if (!applied) safely(options.onInvalid)
        return applied
      })
      .catch(cause => {
        if (requestGeneration === generation) safely(() => options.onFailure?.(cause))
        return false
      })
    active = request
    void request.finally(() => {
      if (active === request) active = undefined
    })
    return request
  }

  const invalidate = (): void => {
    generation += 1
    lastFetchAt = undefined
    active = undefined
  }

  return { invalidate, refresh }
}

/** Extract the one default-on Agents display flag from decoded `config.get full`. */
export function tuiAgentsNudgeConfigValue(config: Readonly<Record<string, unknown>>): unknown {
  const display = config['display']
  return typeof display === 'object' && display !== null && !Array.isArray(display)
    ? Reflect.get(display, 'tui_agents_nudge')
    : undefined
}
