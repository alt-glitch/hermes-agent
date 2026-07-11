import { describe, expect, test } from 'vitest'

import { configSyncBlocked, createConfigSyncTracker, mcpReloadSucceeded } from '../logic/configSync.ts'

describe('live config synchronization', () => {
  test('blocks reload planning throughout session and tool transitions', () => {
    expect(configSyncBlocked(false, false)).toBe(false)
    expect(configSyncBlocked(true, false)).toBe(true)
    expect(configSyncBlocked(false, true)).toBe(true)
    expect(configSyncBlocked(true, true)).toBe(true)

    const tracker = createConfigSyncTracker()
    const baseline = tracker.plan(10, false)
    expect(tracker.completeHydration(baseline!, true)).toBe(true)
    expect(tracker.plan(20, configSyncBlocked(false, true))).toBeUndefined()
  })

  test('commits the initial mtime only after config hydration succeeds', () => {
    const tracker = createConfigSyncTracker()
    const first = tracker.plan(10, false)

    expect(first).toEqual({ kind: 'baseline', mtime: 10, reload: false })
    expect(tracker.completeHydration(first!, false)).toBe(false)
    expect(tracker.observedMtime()).toBe(0)
    expect(tracker.plan(10, false)).toEqual(first)

    expect(tracker.completeHydration(first!, true)).toBe(true)
    expect(tracker.observedMtime()).toBe(10)
    expect(tracker.plan(10, false)).toBeUndefined()
  })

  test('defers an edit while busy and retries a rejected reload exactly once before committing', () => {
    const tracker = createConfigSyncTracker()
    const baseline = tracker.plan(10, false)
    expect(tracker.completeHydration(baseline!, true)).toBe(true)

    // A config edit during a turn must not authorize any global mutation.
    expect(tracker.plan(20, true)).toBeUndefined()
    expect(tracker.observedMtime()).toBe(10)

    const rejected = tracker.plan(20, false)
    expect(rejected).toEqual({ kind: 'change', mtime: 20, reload: true })
    expect(tracker.completeReload(rejected!, false)).toBe(false)
    expect(tracker.observedMtime()).toBe(10)

    const retry = tracker.plan(20, false)
    expect(retry).toEqual(rejected)
    expect(tracker.completeReload(retry!, true)).toBe(true)

    // If full-config hydration is transiently unavailable, retain the pending
    // mtime but do not repeat the already-successful process-global reload.
    expect(tracker.completeHydration(retry!, false)).toBe(false)
    const hydrateRetry = tracker.plan(20, false)
    expect(hydrateRetry).toEqual({ kind: 'change', mtime: 20, reload: false })
    expect(tracker.completeHydration(hydrateRetry!, true)).toBe(true)

    expect(tracker.observedMtime()).toBe(20)
    expect(tracker.plan(20, false)).toBeUndefined()
  })

  test('accepts only the authoritative reloaded response', () => {
    expect(mcpReloadSucceeded({ status: 'reloaded' })).toBe(true)
    expect(mcpReloadSucceeded({ status: 'confirm_required' })).toBe(false)
    expect(mcpReloadSucceeded({ status: 'reloaded', stale: true })).toBe(true)
    expect(mcpReloadSucceeded(undefined)).toBe(false)
  })
})
