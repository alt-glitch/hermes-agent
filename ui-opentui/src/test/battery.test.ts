import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  batteryEnabledFromConfig,
  batteryInfoFromResponse,
  batteryLabel,
  createBatteryPoller,
  type BatteryInfo
} from '../logic/battery.ts'
import { createSessionStore } from '../logic/store.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('battery response normalization', () => {
  test('clamps percent, normalizes category, and keeps unknown values explicit', () => {
    expect(batteryInfoFromResponse({ available: true, category: 'warn', percent: 142.7, plugged: false })).toEqual({
      available: true,
      category: 'warn',
      percent: 100,
      plugged: false
    })
    expect(batteryInfoFromResponse({ available: true, category: 'purple', percent: null, plugged: null })).toEqual({
      available: true,
      category: 'dim',
      percent: null,
      plugged: null
    })
    expect(batteryInfoFromResponse({ available: 'yes' })).toBeNull()
  })

  test('uses charging/battery glyphs and renders unknown percent as --', () => {
    const base: BatteryInfo = { available: true, category: 'good', percent: 82, plugged: false }
    expect(batteryLabel(base)).toBe('🔋 82%')
    expect(batteryLabel({ ...base, plugged: true })).toBe('⚡ 82%')
    expect(batteryLabel({ ...base, percent: null })).toBe('🔋 --%')
  })

  test('reads the persisted display.battery flag defensively', () => {
    expect(batteryEnabledFromConfig({ display: { battery: true } })).toBe(true)
    expect(batteryEnabledFromConfig({ display: { battery: 'on' } })).toBe(true)
    expect(batteryEnabledFromConfig({ display: { battery: false } })).toBe(false)
    expect(batteryEnabledFromConfig({ display: 'broken' })).toBe(false)
  })
})

describe('battery polling lifecycle', () => {
  test('store preference is revision-guarded and survives session-owned resets', () => {
    const store = createSessionStore()
    const enabled: boolean[] = []
    store.registerBatteryEnabledHandler(value => enabled.push(value))
    const staleRevision = store.getBatteryRevision()
    store.setBatteryEnabled(true)

    expect(store.hydrateBatteryEnabled(false, staleRevision)).toBe(false)
    expect(store.state.batteryEnabled).toBe(true)
    store.clearTranscript()
    store.adoptFreshSession('sid-2')
    expect(store.state.batteryEnabled).toBe(true)
    expect(enabled).toEqual([false, true])
  })

  test('polls immediately and every 30s only while enabled, without duplicate intervals', async () => {
    vi.useFakeTimers()
    const reading = { available: true, category: 'good', percent: 81, plugged: false }
    const request = vi.fn(async () => reading)
    const apply = vi.fn()
    const poller = createBatteryPoller({ apply, request })

    expect(vi.getTimerCount()).toBe(0)
    poller.setEnabled(true)
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenLastCalledWith(reading)
    expect(vi.getTimerCount()).toBe(1)

    poller.setEnabled(true)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request).toHaveBeenCalledTimes(2)

    poller.setEnabled(false)
    expect(apply).toHaveBeenLastCalledWith(null)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(2)

    poller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('drops a late in-flight reading after disable', async () => {
    vi.useFakeTimers()
    let resolve!: (value: unknown) => void
    const request = vi.fn(() => new Promise<unknown>(done => (resolve = done)))
    const apply = vi.fn()
    const poller = createBatteryPoller({ apply, request })

    poller.setEnabled(true)
    poller.setEnabled(false)
    resolve({ available: true, category: 'good', percent: 99, plugged: true })
    await Promise.resolve()

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(null)
    poller.dispose()
  })
})
