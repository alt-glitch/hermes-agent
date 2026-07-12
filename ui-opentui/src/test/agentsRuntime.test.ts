import { describe, expect, test } from 'vitest'

import {
  createDelegationStatusRefresher,
  createSpawnTreeSaveDrainer,
  tuiAgentsNudgeConfigValue
} from '../logic/agentsRuntime.ts'
import type { SpawnTreeSaveIntent } from '../logic/store.ts'

function intent(id: string): SpawnTreeSaveIntent {
  return {
    snapshotId: id,
    request: {
      finished_at: 20,
      label: id,
      session_id: 'sid-1',
      started_at: 10,
      subagents: [{ goal: id, subagent_id: id }]
    }
  }
}

describe('spawn-tree save drainer', () => {
  test('coalesces callers and saves/settles strictly in FIFO order', async () => {
    const queue = [intent('a'), intent('b')]
    const calls: string[] = []
    const settled: string[] = []
    let releaseFirst: (() => void) | undefined
    const first = new Promise<void>(resolve => (releaseFirst = resolve))
    const drainer = createSpawnTreeSaveDrainer({
      next: () => queue[0],
      save: async request => {
        calls.push(request.label)
        if (request.label === 'a') await first
      },
      settle: id => {
        settled.push(id)
        queue.shift()
        return true
      }
    })

    const one = drainer.drain()
    const two = drainer.drain()
    expect(one).toBe(two)
    await Promise.resolve()
    expect(calls).toEqual(['a'])
    releaseFirst?.()
    await one
    expect(calls).toEqual(['a', 'b'])
    expect(settled).toEqual(['a', 'b'])
    expect(queue).toEqual([])
  })

  test('save failures are best-effort and do not strand later intents', async () => {
    const queue = [intent('a'), intent('b')]
    const failures: string[] = []
    const drainer = createSpawnTreeSaveDrainer({
      next: () => queue[0],
      save: request => (request.label === 'a' ? Promise.reject(new Error('disk full')) : Promise.resolve()),
      settle: () => (queue.shift(), true),
      onSaveFailure: id => failures.push(id)
    })
    await drainer.drain()
    expect(failures).toEqual(['a'])
    expect(queue).toEqual([])
    expect(drainer.isBlocked()).toBe(false)
  })

  test('a failed settlement blocks instead of retry-spinning the same head', async () => {
    const queue = [intent('a')]
    let saves = 0
    const invariants: string[] = []
    const drainer = createSpawnTreeSaveDrainer({
      next: () => queue[0],
      save: () => ((saves += 1), Promise.resolve()),
      settle: () => false,
      onInvariantFailure: id => invariants.push(id)
    })
    await drainer.drain()
    await drainer.drain()
    expect(saves).toBe(1)
    expect(invariants).toEqual(['a'])
    expect(drainer.isBlocked()).toBe(true)
  })

  test('bounded eviction of an in-flight head does not strand newer intents', async () => {
    const limit = 10
    let queue = [intent('0')]
    const saved: string[] = []
    let release: (() => void) | undefined
    const held = new Promise<void>(resolve => (release = resolve))
    const drainer = createSpawnTreeSaveDrainer({
      next: () => queue[0],
      save: async request => {
        saved.push(request.label)
        if (request.label === '0') await held
      },
      settle: id => {
        const found = queue.some(item => item.snapshotId === id)
        queue = queue.filter(item => item.snapshotId !== id)
        return found
      }
    })

    const draining = drainer.drain()
    await Promise.resolve()
    for (let index = 1; index <= limit; index += 1) {
      queue = [...queue, intent(String(index))].slice(-limit)
    }
    expect(queue.map(item => item.snapshotId)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])

    release?.()
    await draining
    expect(saved).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    expect(queue).toEqual([])
    expect(drainer.isBlocked()).toBe(false)
  })
})

describe('delegation status refresher', () => {
  test('deduplicates an in-flight read, throttles, and permits a forced refresh', async () => {
    let clock = 100
    let fetches = 0
    let release: ((value: unknown) => void) | undefined
    const first = new Promise<unknown>(resolve => (release = resolve))
    const applied: unknown[] = []
    const refresher = createDelegationStatusRefresher({
      apply: response => (applied.push(response), true),
      fetch: () => (++fetches === 1 ? first : Promise.resolve({ paused: true })),
      now: () => clock
    })

    const one = refresher.refresh()
    const two = refresher.refresh()
    expect(one).toBe(two)
    expect(fetches).toBe(1)
    release?.({ paused: false })
    await one

    clock += 100
    expect(await refresher.refresh()).toBe(false)
    expect(fetches).toBe(1)
    expect(await refresher.refresh(true)).toBe(true)
    expect(fetches).toBe(2)
    expect(applied).toEqual([{ paused: false }, { paused: true }])
  })

  test('invalid and failed reads are contained and reported', async () => {
    const signals: string[] = []
    const invalid = createDelegationStatusRefresher({
      apply: () => false,
      fetch: () => Promise.resolve({ bad: true }),
      onInvalid: () => signals.push('invalid')
    })
    expect(await invalid.refresh()).toBe(false)

    const failed = createDelegationStatusRefresher({
      apply: () => true,
      fetch: () => Promise.reject(new Error('offline')),
      onFailure: () => signals.push('failed')
    })
    expect(await failed.refresh()).toBe(false)

    const throws = createDelegationStatusRefresher({
      apply: () => true,
      fetch: () => {
        throw new Error('sync offline')
      },
      onFailure: () => signals.push('sync-failed')
    })
    expect(await throws.refresh()).toBe(false)
    expect(signals).toEqual(['invalid', 'failed', 'sync-failed'])
  })

  test('clock rollback does not suppress the next refresh indefinitely', async () => {
    let clock = 10_000
    let fetches = 0
    const refresher = createDelegationStatusRefresher({
      apply: () => true,
      fetch: () => ((fetches += 1), Promise.resolve({ paused: false })),
      now: () => clock
    })
    expect(await refresher.refresh()).toBe(true)
    clock = 1_000
    expect(await refresher.refresh()).toBe(true)
    expect(fetches).toBe(2)
  })

  test('gateway invalidation fences a stale response and permits an immediate replacement read', async () => {
    const releases: Array<(value: unknown) => void> = []
    const applied: unknown[] = []
    const refresher = createDelegationStatusRefresher({
      apply: response => (applied.push(response), true),
      fetch: () => new Promise<unknown>(resolve => releases.push(resolve))
    })
    const stale = refresher.refresh()
    refresher.invalidate()
    const fresh = refresher.refresh(true)
    expect(releases).toHaveLength(2)

    releases[1]?.({ paused: false })
    expect(await fresh).toBe(true)
    releases[0]?.({ paused: true })
    expect(await stale).toBe(false)
    expect(applied).toEqual([{ paused: false }])
  })
})

test('Agents nudge config extraction preserves explicit false and defaults missing shapes', () => {
  expect(tuiAgentsNudgeConfigValue({ display: { tui_agents_nudge: false } })).toBe(false)
  expect(tuiAgentsNudgeConfigValue({ display: { tui_agents_nudge: true } })).toBe(true)
  expect(tuiAgentsNudgeConfigValue({ display: 'compact' })).toBeUndefined()
  expect(tuiAgentsNudgeConfigValue({})).toBeUndefined()
})
