import { describe, expect, test } from 'vitest'

import {
  applyDelegationState,
  clearAgentsNudgeTurn,
  configureAgentsNudge,
  considerAgentsNudge,
  createAgentsNudgeState,
  createDelegationState,
  delegationPressure,
  delegationStatusText,
  idleSubagentResumeStatus,
  isActiveSubagentStatus,
  resolveActiveSubagentCount,
  startAgentsNudgeTurn
} from '../logic/agentStatus.ts'

describe('active subagent count authority', () => {
  const localRows = [{ status: 'running' }, { status: 'queued' }, { status: 'completed' }, { status: 'failed' }]

  test('usage.active_subagents wins over local rows, including explicit zero', () => {
    expect(resolveActiveSubagentCount(7, localRows)).toEqual({ count: 7, source: 'usage' })
    expect(resolveActiveSubagentCount(0, localRows)).toEqual({ count: 0, source: 'usage' })
  })

  test.each([undefined, null, '2', -1, 1.5, Number.POSITIVE_INFINITY])(
    'falls back to known-live local rows when usage count is absent/malformed: %s',
    value => {
      expect(resolveActiveSubagentCount(value, localRows)).toEqual({ count: 2, source: 'local' })
    }
  )

  test('normalizes canonical live aliases without counting terminal or unknown rows', () => {
    expect(isActiveSubagentStatus(' COMPLETED ')).toBe(false)
    expect(isActiveSubagentStatus('Interrupted')).toBe(false)
    expect(isActiveSubagentStatus('spawn requested')).toBe(true)
    expect(isActiveSubagentStatus('replying')).toBe(true)
    expect(isActiveSubagentStatus('future-live-state')).toBe(false)
  })
})

describe('delegation pause/caps state', () => {
  test('merges valid partial responses without mutating or erasing prior caps', () => {
    const initial = createDelegationState()
    const withCaps = applyDelegationState(
      initial,
      { max_concurrent_children: 3, max_spawn_depth: 2, paused: false },
      100
    )
    const paused = applyDelegationState(withCaps, { paused: true }, 200)

    expect(initial).toEqual({ maxConcurrentChildren: null, maxSpawnDepth: null, paused: false, updatedAtMs: null })
    expect(withCaps).toEqual({ maxConcurrentChildren: 3, maxSpawnDepth: 2, paused: false, updatedAtMs: 100 })
    expect(paused).toEqual({ maxConcurrentChildren: 3, maxSpawnDepth: 2, paused: true, updatedAtMs: 200 })
  })

  test('malformed/empty patches are inert and cannot erase the last good response', () => {
    const state = applyDelegationState(
      createDelegationState(),
      { max_concurrent_children: 4, max_spawn_depth: 3, paused: true },
      100
    )

    expect(applyDelegationState(state, { max_concurrent_children: 0, max_spawn_depth: -1, paused: 'false' }, 200)).toBe(
      state
    )
    expect(applyDelegationState(state, {}, 200)).toBe(state)
  })

  test('warns at Ink ratios and uses widest-level concurrency, not global active count', () => {
    const state = applyDelegationState(createDelegationState(), { max_concurrent_children: 3, max_spawn_depth: 3 }, 100)
    const normal = delegationPressure(state, { activeCount: 9, depth: 1, widestLevel: 1 })
    const warn = delegationPressure(state, { activeCount: 9, depth: 2, widestLevel: 1 })
    const capped = delegationPressure(state, { activeCount: 3, depth: 1, widestLevel: 3 })

    expect(normal).toMatchObject({ concurrencyRatio: 1 / 3, depthRatio: 1 / 3, level: 'normal' })
    expect(warn).toMatchObject({ atCap: false, depthRatio: 2 / 3, level: 'warn' })
    expect(capped).toMatchObject({ atCap: true, concurrencyRatio: 1, level: 'error' })
  })

  test('paused is error-toned even while idle; unknown caps stay neutral', () => {
    const paused = applyDelegationState(createDelegationState(), { paused: true }, 100)
    expect(delegationPressure(paused, { activeCount: 0, depth: 8, widestLevel: 8 })).toEqual({
      activeCount: 0,
      atCap: false,
      concurrencyRatio: 0,
      depthRatio: 0,
      level: 'error',
      ratio: 0
    })
    expect(delegationStatusText(paused)).toBe('delegation · paused · caps d?/?')
  })
})

describe('/agents nudge credit', () => {
  test.each([
    [false, false],
    [true, true],
    [undefined, true],
    [null, true],
    [0, true],
    ['false', true]
  ])('only literal false disables: %s', (value, expected) => {
    expect(createAgentsNudgeState(value).enabled).toBe(expected)
  })

  test('overlay-open suppression does not burn the once-per-turn credit', () => {
    const started = startAgentsNudgeTurn(createAgentsNudgeState())
    const turnId = started.activeTurnId
    if (turnId === null) throw new Error('message.start must issue a turn id')

    const watching = considerAgentsNudge(started, { overlayOpen: true, turnId })
    expect(watching).toEqual({ shouldNudge: false, state: started })

    const closed = considerAgentsNudge(watching.state, { overlayOpen: false, turnId })
    expect(closed.shouldNudge).toBe(true)
    expect(closed.state.nudgedTurnId).toBe(turnId)
    expect(considerAgentsNudge(closed.state, { overlayOpen: false, turnId }).shouldNudge).toBe(false)
  })

  test('message.start resets credit and old-turn tokens cannot spend it', () => {
    const first = startAgentsNudgeTurn(createAgentsNudgeState())
    const firstId = first.activeTurnId
    if (firstId === null) throw new Error('message.start must issue a turn id')
    const consumed = considerAgentsNudge(first, { overlayOpen: false, turnId: firstId }).state

    const second = startAgentsNudgeTurn(consumed)
    const secondId = second.activeTurnId
    if (secondId === null) throw new Error('message.start must issue a turn id')
    expect(secondId).not.toBe(firstId)
    expect(considerAgentsNudge(second, { overlayOpen: false, turnId: firstId }).shouldNudge).toBe(false)
    expect(considerAgentsNudge(second, { overlayOpen: false, turnId: secondId }).shouldNudge).toBe(true)
  })

  test('turn clear invalidates a late subagent event and preserves future-turn credit', () => {
    const started = startAgentsNudgeTurn(createAgentsNudgeState())
    const staleId = started.activeTurnId
    if (staleId === null) throw new Error('message.start must issue a turn id')

    const cleared = clearAgentsNudgeTurn(started)
    expect(cleared.activeTurnId).toBeNull()
    expect(considerAgentsNudge(cleared, { overlayOpen: false, turnId: staleId })).toEqual({
      shouldNudge: false,
      state: cleared
    })

    const next = startAgentsNudgeTurn(cleared)
    const nextId = next.activeTurnId
    if (nextId === null) throw new Error('message.start must issue a turn id')
    expect(considerAgentsNudge(next, { overlayOpen: false, turnId: staleId }).shouldNudge).toBe(false)
    expect(considerAgentsNudge(next, { overlayOpen: false, turnId: nextId }).shouldNudge).toBe(true)
  })

  test('explicit false disables without consuming credit; re-enable can still nudge', () => {
    const started = startAgentsNudgeTurn(createAgentsNudgeState())
    const turnId = started.activeTurnId
    if (turnId === null) throw new Error('message.start must issue a turn id')

    const disabled = configureAgentsNudge(started, false)
    const suppressed = considerAgentsNudge(disabled, { overlayOpen: false, turnId })
    expect(suppressed).toEqual({ shouldNudge: false, state: disabled })

    const enabled = configureAgentsNudge(suppressed.state, undefined)
    expect(considerAgentsNudge(enabled, { overlayOpen: false, turnId }).shouldNudge).toBe(true)
  })
})

describe('idle parked-subagent status text', () => {
  test('uses Ink singular/plural copy at full width and hides while busy/empty', () => {
    expect(idleSubagentResumeStatus({ availableCells: 80, count: 1, running: false })).toEqual({
      text: '↩ resumes when subagent finishes',
      variant: 'full'
    })
    expect(idleSubagentResumeStatus({ availableCells: 80, count: 3, running: false })).toEqual({
      text: '↩ resumes when 3 subagents finish',
      variant: 'full'
    })
    expect(idleSubagentResumeStatus({ availableCells: 80, count: 3, running: true })).toEqual({
      text: '',
      variant: 'hidden'
    })
    expect(idleSubagentResumeStatus({ availableCells: 80, count: 0, running: false })).toEqual({
      text: '',
      variant: 'hidden'
    })
  })

  test('selects only whole width-aware variants at their exact cell boundaries', () => {
    const full = '↩ resumes when 12 subagents finish'
    const compact = '↩ resumes · 12'
    const tiny = '↩ 12'

    expect(idleSubagentResumeStatus({ availableCells: full.length, count: 12, running: false })).toEqual({
      text: full,
      variant: 'full'
    })
    expect(idleSubagentResumeStatus({ availableCells: full.length - 1, count: 12, running: false })).toEqual({
      text: compact,
      variant: 'compact'
    })
    expect(idleSubagentResumeStatus({ availableCells: compact.length - 1, count: 12, running: false })).toEqual({
      text: tiny,
      variant: 'tiny'
    })
    expect(idleSubagentResumeStatus({ availableCells: tiny.length - 1, count: 12, running: false })).toEqual({
      text: '',
      variant: 'hidden'
    })
  })

  test('rejects malformed counts and widths instead of emitting partial chrome', () => {
    expect(idleSubagentResumeStatus({ availableCells: 80, count: -1, running: false }).variant).toBe('hidden')
    expect(idleSubagentResumeStatus({ availableCells: 80, count: 1.5, running: false }).variant).toBe('hidden')
    expect(idleSubagentResumeStatus({ availableCells: Number.NaN, count: 2, running: false }).variant).toBe('hidden')
  })
})
