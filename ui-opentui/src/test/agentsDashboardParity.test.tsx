import { createSignal } from 'solid-js'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createDelegationState } from '../logic/agentStatus.ts'
import type { SpawnHistoryState, SpawnSnapshot } from '../logic/spawnHistory.ts'
import { dashboardAgentFromRecord, type DashboardAgent } from '../view/overlays/agents/model.ts'
import { AgentsDashboard } from '../view/overlays/agentsDashboard.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame, renderProbe } from './lib/render.ts'

const START = Date.now() - 12_000

function agent(id: string, goal: string, overrides: Partial<DashboardAgent> = {}): DashboardAgent {
  return {
    depth: 0,
    goal,
    id,
    index: 0,
    parentId: null,
    status: 'running',
    ...overrides
  }
}

const RICH_AGENTS: readonly DashboardAgent[] = [
  agent('root', 'Research the release blockers', {
    apiCalls: 4,
    costUsd: 0.034,
    filesRead: ['/repo/docs/release.md'],
    filesWritten: ['/repo/docs/report.md'],
    inputTokens: 2400,
    model: 'anthropic/claude-sonnet-5',
    notes: ['read the release checklist', 'compared the artifact manifests'],
    outputTail: [{ isError: false, preview: 'release checks passed', tool: 'terminal' }],
    outputTokens: 700,
    startedAt: START,
    toolCount: 3,
    tools: ['read_file(/repo/docs/release.md)', 'terminal(npm test)', 'write_file(report.md)'],
    trace: [
      { kind: 'start', text: 'Research the release blockers' },
      { kind: 'tool', text: 'terminal — npm test' },
      { kind: 'reply', text: 'The release wiring is green.' }
    ]
  }),
  agent('child', 'Audit native platform artifacts', {
    depth: 1,
    durationSeconds: 8,
    index: 1,
    inputTokens: 800,
    model: 'anthropic/claude-opus-4-8',
    outputTokens: 300,
    parentId: 'root',
    status: 'completed',
    summary: 'All four artifacts are signed.',
    toolCount: 2,
    tools: ['read_file(manifest.json)', 'terminal(cosign verify)']
  }),
  agent('failed', 'Probe the unavailable mirror', {
    depth: 1,
    durationSeconds: 3,
    index: 2,
    parentId: 'root',
    status: 'failed',
    summary: 'Mirror returned 503.',
    toolCount: 1
  })
]

function dashboardNode(props: Partial<Parameters<typeof AgentsDashboard>[0]> = {}) {
  return () => (
    <ThemeProvider>
      <AgentsDashboard subagents={RICH_AGENTS} onClose={() => {}} {...props} />
    </ThemeProvider>
  )
}

function snapshot(id: string, label: string, rows: readonly DashboardAgent[], offset: number): SpawnSnapshot {
  return Object.freeze({
    finishedAtMs: START + offset + 10_000,
    id,
    label,
    metadata: Object.freeze({}),
    sessionId: 'session-1',
    source: 'live',
    startedAtMs: START + offset,
    subagents: Object.freeze(rows.map(row => Object.freeze({ ...row })))
  })
}

describe('native agents dashboard parity', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  test('legacy archived rows without a status remain completed', () => {
    expect(dashboardAgentFromRecord({ goal: 'legacy archived task', task_index: 0 })?.status).toBe('completed')
    expect(dashboardAgentFromRecord({ goal: 'future archived task', status: 'future-state' })?.status).toBe('completed')
  })

  test('captureCharFrame renders a nested bounded tree, metrics, and timeline', async () => {
    const delegation = { ...createDelegationState(), maxConcurrentChildren: 4, maxSpawnDepth: 3 }
    const frame = await captureFrame(dashboardNode({ delegation }), {
      height: 34,
      until: 'Spawn tree',
      width: 124
    })
    expect(frame).toContain('Spawn tree')
    expect(frame).toContain('Timeline')
    expect(frame).toContain('Research the release blockers')
    expect(frame).toContain('Audit native platform artifacts')
    expect(frame).toContain('Probe the unavailable mirror')
    expect(frame).toContain('caps d3/4')
    expect(frame).toContain('sonnet-5×1')
  })

  test('timeline keeps simultaneous fan-outs as distinct lanes with a scaled ruler', async () => {
    const simultaneous = [
      agent('lane-1', 'First parallel task', { durationSeconds: 42, startedAt: START }),
      agent('lane-2', 'Second parallel task', { durationSeconds: 42, index: 1, startedAt: START }),
      agent('lane-3', 'Third parallel task', { durationSeconds: 42, index: 2, startedAt: START }),
      agent('lane-4', 'Completed offset task', {
        durationSeconds: 15,
        index: 3,
        startedAt: START + 5_000,
        status: 'completed'
      })
    ]
    const frame = await captureFrame(dashboardNode({ subagents: simultaneous }), {
      height: 34,
      until: 'Timeline',
      width: 116
    })
    const lanes = frame.split('\n').filter(line => line.includes('╺'))
    const ruler = frame.split('\n').find(line => line.includes('┼'))
    const labels = frame.split('\n').find(line => /0\s+\d+s\s+\d+s/.test(line))

    expect(lanes).toHaveLength(4)
    expect(lanes.slice(0, 3).every(line => line.includes('●'))).toBe(true)
    expect(lanes.some(line => line.includes('✓'))).toBe(true)
    expect(frame).not.toContain('██')
    expect(ruler).toBeDefined()
    expect(labels).toBeDefined()
  })

  test('the 132-column control footer stays whole inside its border and padding', async () => {
    const frame = await captureFrame(dashboardNode({ subagents: [] }), {
      height: 30,
      until: 'No subagents this turn',
      width: 132
    })
    expect(frame).toContain('q close')
    expect(frame).not.toContain('q clos │')
  })

  test('list navigation opens rich detail and Escape returns to the list', async () => {
    const probe = await renderProbe(dashboardNode(), { height: 34, kittyKeyboard: true, width: 116 })
    try {
      probe.keys.pressArrow('down')
      await probe.settle()
      probe.keys.pressEnter()
      await probe.settle()
      let frame = probe.frame()
      expect(frame).toContain('#2')
      expect(frame).toContain('Audit native platform artifacts')
      expect(frame).toContain('Tool calls (2)')
      probe.keys.pressKey('g', { shift: true })
      await probe.settle()
      frame = probe.frame()
      expect(frame).toContain('Summary')
      expect(frame).toContain('All four artifacts are signed.')

      probe.keys.pressEscape()
      await probe.settle()
      frame = probe.frame()
      expect(frame).toContain('Enter/→ open detail')
      expect(frame).toContain('Research the release blockers')
    } finally {
      probe.destroy()
    }
  })

  test('selection is stable by id through sort and moves safely when filtered out', async () => {
    const probe = await renderProbe(dashboardNode({ preselect: 'child' }), { height: 34, width: 116 })
    try {
      probe.keys.pressKey('s') // busiest; child remains selected by id
      await probe.settle()
      probe.keys.pressEnter()
      await probe.settle()
      expect(probe.frame()).toContain('#2 ✓ Audit native platform artifacts')

      probe.keys.pressKey('h')
      await probe.settle()
      probe.keys.pressKey('f') // running; completed child is filtered out
      await probe.settle()
      probe.keys.pressEnter()
      await probe.settle()
      expect(probe.frame()).toContain('Research the release blockers')
      expect(probe.frame()).not.toContain('#2 ✓ Audit native platform artifacts')
    } finally {
      probe.destroy()
    }
  })

  test('pause, kill-one, and kill-subtree are callback driven', async () => {
    const paused: boolean[] = []
    const killed: string[] = []
    const subtrees: readonly string[][] = []
    const mutableSubtrees = subtrees as string[][]
    const probe = await renderProbe(
      dashboardNode({
        onKillAgent: id => void killed.push(id),
        onKillSubtree: ids => void mutableSubtrees.push([...ids]),
        onPauseChange: next => void paused.push(next),
        preselect: 'root'
      }),
      { height: 34, width: 116 }
    )
    try {
      probe.keys.pressKey('p')
      await probe.settle()
      await Promise.resolve()
      probe.keys.pressKey('x')
      await probe.settle()
      await Promise.resolve()
      probe.keys.pressKey('x', { shift: true })
      await probe.settle()
      await Promise.resolve()
      expect(paused).toEqual([true])
      expect(killed).toEqual(['root'])
      expect(mutableSubtrees).toEqual([['root', 'child', 'failed']])
    } finally {
      probe.destroy()
    }
  })

  test('history stepping enters read-only replay and can return live', async () => {
    const archived = snapshot('snap-1', 'previous fan-out', RICH_AGENTS, -20_000)
    const history: SpawnHistoryState = Object.freeze({ snapshots: Object.freeze([archived]) })
    const killed: string[] = []
    const probe = await renderProbe(dashboardNode({ history, onKillAgent: id => void killed.push(id) }), {
      height: 34,
      width: 116
    })
    try {
      probe.keys.pressKey('[')
      await probe.settle()
      expect(probe.frame()).toContain('Replay 1/1')
      expect(probe.frame()).toContain('controls locked')
      probe.keys.pressKey('x')
      await probe.settle()
      expect(killed).toEqual([])
      expect(probe.frame()).toContain('replay mode — controls disabled')

      probe.keys.pressKey(']')
      await probe.settle()
      expect(probe.frame()).toContain('Spawn tree')
      expect(probe.frame()).not.toContain('Replay 1/1')
    } finally {
      probe.destroy()
    }
  })

  test('replay freezes running-row elapsed time at the snapshot boundary without arming a timer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(START + 60_000)
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const archived = snapshot('snap-running', 'interrupted fan-out', [RICH_AGENTS[0]!], -20_000)
    const history: SpawnHistoryState = Object.freeze({ snapshots: Object.freeze([archived]) })
    const probe = await renderProbe(dashboardNode({ history, subagents: [] }), { height: 30, width: 112 })
    try {
      await probe.settle()
      const frame = probe.frame()
      expect(frame).toContain('Last turn')
      expect(setIntervalSpy).not.toHaveBeenCalled()

      vi.advanceTimersByTime(60_000)
      await probe.settle()
      expect(probe.frame()).toBe(frame)
      expect(setIntervalSpy).not.toHaveBeenCalled()
    } finally {
      probe.destroy()
    }
  })

  test('opening after a completed turn shows the newest archive without an empty frame', async () => {
    const archived = snapshot('snap-1', 'previous fan-out', RICH_AGENTS, -20_000)
    const history: SpawnHistoryState = Object.freeze({ snapshots: Object.freeze([archived]) })
    const frame = await captureFrame(dashboardNode({ history, subagents: [] }), {
      height: 30,
      until: 'Last turn',
      width: 112
    })
    expect(frame).toContain('Last turn')
    expect(frame).toContain('Research the release blockers')
    expect(frame).not.toContain('No subagents this turn')
  })

  test('diff mode compares snapshots and reports structural changes', async () => {
    const before = snapshot('before', 'baseline fan-out', RICH_AGENTS.slice(0, 2), -20_000)
    const after = snapshot('after', 'candidate fan-out', RICH_AGENTS, 0)
    const frame = await captureFrame(dashboardNode({ diffPair: { baseline: before, candidate: after } }), {
      height: 32,
      until: 'Replay diff',
      width: 120
    })
    expect(frame).toContain('Replay diff')
    expect(frame).toContain('A · baseline')
    expect(frame).toContain('B · candidate')
    expect(frame).toContain('agents · +1 / −0')
    expect(frame).toContain('tokens:')
  })

  test('master list mounts a bounded window and follows G to the final id', async () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      agent(`a-${String(index)}`, `bounded-goal-${String(index).padStart(2, '0')}`, { index })
    )
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <AgentsDashboard subagents={many} onClose={() => {}} />
        </ThemeProvider>
      ),
      { height: 24, width: 84 }
    )
    try {
      let frame = probe.frame()
      expect(frame).toContain('bounded-goal-00')
      expect(frame).not.toContain('bounded-goal-39')
      expect((frame.match(/bounded-goal-/g) ?? []).length).toBeLessThanOrEqual(18)

      probe.keys.pressKey('g', { shift: true })
      await probe.settle()
      frame = probe.frame()
      expect(frame).toContain('bounded-goal-39')
      expect(frame).not.toContain('bounded-goal-00')
      expect((frame.match(/bounded-goal-/g) ?? []).length).toBeLessThanOrEqual(18)
    } finally {
      probe.destroy()
    }
  })

  test('resize switches to terminal-safe compact chrome without losing selection', async () => {
    const [rows] = createSignal(RICH_AGENTS)
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <AgentsDashboard subagents={rows()} onClose={() => {}} preselect="child" />
        </ThemeProvider>
      ),
      { height: 32, width: 120 }
    )
    try {
      expect(probe.frame()).toContain('Timeline')
      probe.resize(68, 22)
      await probe.settle()
      const frame = probe.frame()
      expect(frame).not.toContain('Timeline')
      expect(frame).toContain('↑↓ move · Enter open')
      probe.keys.pressEnter()
      await probe.settle()
      expect(probe.frame()).toContain('Audit native platform artifacts')
    } finally {
      probe.destroy()
    }
  })

  test('detail scroll content uses the available tall viewport instead of collapsing trace rows', async () => {
    const trace = Array.from({ length: 28 }, (_, index) => ({
      kind: 'progress' as const,
      text: `TRACE_${String(index).padStart(2, '0')}`
    }))
    const probe = await renderProbe(
      dashboardNode({ subagents: [agent('trace-heavy', 'Inspect the full live trace', { trace })] }),
      { height: 24, width: 100 }
    )
    try {
      probe.keys.pressEnter()
      await probe.settle()
      expect((probe.frame().match(/TRACE_/g) ?? []).length).toBeLessThan(20)

      probe.resize(100, 42)
      await probe.settle()
      const frame = probe.frame()
      expect(frame.match(/TRACE_/g)).toHaveLength(20)
      expect(frame).toContain('TRACE_08')
      expect(frame).toContain('TRACE_27')
      expect(frame).toContain('q close')
    } finally {
      probe.destroy()
    }
  })
})
