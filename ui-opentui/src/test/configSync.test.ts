import { describe, expect, test } from 'vitest'

import { decodeConfigMtimeResponse, decodeReloadMcpResponse } from '../boundary/schema/SessionCommandResponses.ts'
import {
  configSyncBlocked,
  createConfigSyncTracker,
  mcpLoadedRevision,
  mcpReloadSucceeded
} from '../logic/configSync.ts'

describe('revision-aware live config synchronization', () => {
  test('decodes the revision-bearing poll and reload acknowledgement contracts', () => {
    expect(decodeConfigMtimeResponse({ mcp_rev: 'rev-b', mtime: 20 })).toEqual({ mcp_rev: 'rev-b', mtime: 20 })
    expect(decodeReloadMcpResponse({ loaded_rev: 'rev-b', status: 'reloaded' })).toEqual({
      loaded_rev: 'rev-b',
      status: 'reloaded'
    })
  })

  test('blocks planning throughout session and tool transitions', () => {
    expect(configSyncBlocked(false, false)).toBe(false)
    expect(configSyncBlocked(true, false)).toBe(true)
    expect(configSyncBlocked(false, true)).toBe(true)
    expect(configSyncBlocked(true, true)).toBe(true)

    const tracker = createConfigSyncTracker()
    const baseline = tracker.plan(10, 'rev-a', false)
    expect(tracker.completeHydration(baseline!, true)).toBe(true)
    expect(tracker.plan(20, 'rev-b', configSyncBlocked(false, true))).toBeUndefined()
  })

  test('seeds the boot revision and commits baseline only after hydration', () => {
    const tracker = createConfigSyncTracker()
    const first = tracker.plan(10, 'rev-a', false)

    expect(first).toEqual({ kind: 'baseline', mcpRev: 'rev-a', mtime: 10, reload: false })
    expect(tracker.acceptedMcpRev()).toBe('rev-a')
    expect(tracker.completeHydration(first!, false)).toBe(false)
    expect(tracker.observedMtime()).toBe(0)
    expect(tracker.plan(10, 'rev-a', false)).toEqual(first)

    expect(tracker.completeHydration(first!, true)).toBe(true)
    expect(tracker.observedMtime()).toBe(10)
    expect(tracker.plan(10, 'rev-a', false)).toBeUndefined()
  })

  test('a cosmetic config write hydrates without an MCP reload', () => {
    const tracker = createConfigSyncTracker()
    const baseline = tracker.plan(10, 'rev-a', false)
    expect(tracker.completeHydration(baseline!, true)).toBe(true)

    const cosmetic = tracker.plan(20, 'rev-a', false)
    expect(cosmetic).toEqual({ kind: 'change', mcpRev: 'rev-a', mtime: 20, reload: false })
    expect(tracker.completeReload(cosmetic!, { status: 'reloaded', loaded_rev: 'rev-a' })).toBe(false)
    expect(tracker.completeHydration(cosmetic!, true)).toBe(true)
    expect(tracker.acceptedMcpRev()).toBe('rev-a')
  })

  test('a failed MCP reload remains unaccepted and retries the same revision next tick', () => {
    const tracker = createConfigSyncTracker()
    const baseline = tracker.plan(10, 'rev-a', false)
    expect(tracker.completeHydration(baseline!, true)).toBe(true)

    const changed = tracker.plan(20, 'rev-b', false)
    expect(changed).toEqual({ kind: 'change', mcpRev: 'rev-b', mtime: 20, reload: true })
    expect(tracker.completeReload(changed!, undefined)).toBe(false)
    expect(tracker.acceptedMcpRev()).toBe('rev-a')
    expect(tracker.observedMtime()).toBe(10)

    const retry = tracker.plan(20, 'rev-b', false)
    expect(retry).toEqual(changed)
    expect(tracker.completeReload(retry!, { status: 'reloaded', loaded_rev: 'rev-b' })).toBe(true)
    expect(tracker.acceptedMcpRev()).toBe('rev-b')

    // Hydration retry must not reconnect the already accepted revision.
    expect(tracker.completeHydration(retry!, false)).toBe(false)
    const hydrateRetry = tracker.plan(20, 'rev-b', false)
    expect(hydrateRetry).toEqual({ kind: 'change', mcpRev: 'rev-b', mtime: 20, reload: false })
    expect(tracker.completeHydration(hydrateRetry!, true)).toBe(true)
  })

  test('accepts the gateway loaded_rev when discovery raced a newer edit', () => {
    const tracker = createConfigSyncTracker()
    const baseline = tracker.plan(10, 'rev-a', false)
    expect(tracker.completeHydration(baseline!, true)).toBe(true)
    const changed = tracker.plan(20, 'rev-b', false)

    expect(tracker.completeReload(changed!, { status: 'reloaded', loaded_rev: 'rev-c' })).toBe(true)
    expect(tracker.acceptedMcpRev()).toBe('rev-c')
    expect(tracker.completeHydration(changed!, true)).toBe(true)

    // The next poll already observes what the server says it loaded: no second reload.
    expect(tracker.plan(30, 'rev-c', false)).toMatchObject({ reload: false })
  })

  test('recognizes only authoritative reload acknowledgements', () => {
    expect(mcpReloadSucceeded({ status: 'reloaded' })).toBe(true)
    expect(mcpReloadSucceeded({ status: 'confirm_required' })).toBe(false)
    expect(mcpLoadedRevision({ status: 'reloaded', loaded_rev: 'rev-c' }, 'rev-b')).toBe('rev-c')
    expect(mcpLoadedRevision({ status: 'reloaded' }, 'rev-b')).toBe('rev-b')
    expect(mcpLoadedRevision({ status: 'confirm_required' }, 'rev-b')).toBeUndefined()
    expect(mcpLoadedRevision(undefined, 'rev-b')).toBeUndefined()
  })
})
