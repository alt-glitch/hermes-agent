import { MarkdownRenderable, ScrollBoxRenderable, type Renderable } from '@opentui/core'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createDelegationState } from '../logic/agentStatus.ts'
import type { SpawnHistoryState, SpawnSnapshot } from '../logic/spawnHistory.ts'
import { dashboardAgentFromRecord, type DashboardAgent } from '../view/overlays/agents/model.ts'
import { agentElapsed, agentEndTime } from '../view/overlays/agents/timeline.tsx'
import { AgentsDashboard } from '../view/overlays/agentsDashboard.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame, renderProbe } from './lib/render.ts'

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap(child => [child, ...descendants(child)])
}

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
    vi.spyOn(Date, 'now').mockReturnValue(START + 42_000)
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
    const ruler = frame.split('\n').find(line => line.includes('0─'))
    const labels = frame.split('\n').find(line => /┤\s+42s/.test(line))

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
    const probe = await renderProbe(dashboardNode(), { height: 34, kittyKeyboard: true, width: 96 })
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
      expect(frame).toContain('Final reply')
      expect(
        descendants(probe.renderer.root).some(
          item => item instanceof MarkdownRenderable && item.content === 'All four artifacts are signed.'
        )
      ).toBe(true)

      probe.keys.pressEscape()
      await probe.settle()
      frame = probe.frame()
      expect(frame).toContain('Enter')
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
      probe.keys.pressKey('e')
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
  test('wide master-detail uses measured height, stable row instances and wheel selection across resize', async () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      agent(`row-${String(index)}`, `Task ${String(index)}`, { index })
    )
    const [items, setItems] = createSignal<readonly DashboardAgent[]>(many)
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <AgentsDashboard subagents={items()} onClose={() => {}} />
        </ThemeProvider>
      ),
      { width: 140, height: 62 }
    )
    try {
      const master = descendants(probe.renderer.root).find(item => item.id === 'agents-master')
      const first = descendants(probe.renderer.root).find(item => item.id === 'agent-row-row-0')
      const detail = descendants(probe.renderer.root).find(item => item.id === 'agents-detail')
      expect(master?.visible).toBe(true)
      expect(detail?.visible).toBe(true)
      expect(descendants(probe.renderer.root).filter(item => item.id.startsWith('agent-row-')).length).toBeGreaterThan(
        18
      )
      expect(descendants(probe.renderer.root).filter(item => item.id.startsWith('agent-row-')).length).toBeLessThan(100)
      setItems(current => current.map(item => (item.id === 'row-1' ? { ...item, status: 'failed' } : item)))
      await probe.settle()
      expect(descendants(probe.renderer.root)).toContain(first)
      if (master === undefined) throw new Error('missing master')
      await probe.scroll(master.x + 3, master.y + 2, 'down')
      expect(probe.frame()).toContain('#2')
      probe.resize(76, 18)
      await probe.settle()
      expect(detail?.visible).toBe(false)
      probe.keys.pressEnter()
      await probe.settle()
      expect(probe.frame()).toContain('#2')
      expect(probe.frame()).toContain('← Back to agents')
      probe.keys.pressKey('h')
      await probe.settle()
      probe.keys.pressKey('g', { shift: true })
      await probe.settle()
      expect(probe.frame()).toContain('Task 99')
      probe.resize(140, 62)
      await probe.settle()
      expect(probe.frame()).toContain('#100')
      expect(detail?.visible).toBe(true)
      for (const width of [80, 40]) {
        probe.resize(width, 12)
        await probe.settle()
        expect(probe.frame()).toContain('Task 99')
        expect(probe.frame()).toContain('q close')
        expect(
          descendants(probe.renderer.root).filter(item => item.id.startsWith('agent-row-')).length
        ).toBeLessThanOrEqual(Math.max(1, Math.floor((master.height - 1) / 2)))
      }
    } finally {
      probe.destroy()
    }
  })

  test('terminal rows prefer measured duration and retained finals over receipt time and stale activity', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(START + 24_000)
    const completed = agent('completed', 'Verify contracts', {
      status: 'completed',
      startedAt: START,
      durationSeconds: 12,
      endedAt: START + 24_000,
      summary: 'VERIFIED_FINAL',
      trace: [{ kind: 'progress', text: 'STALE_PROGRESS' }]
    })
    const failed = agent('failed', 'Check mirror', {
      status: 'failed',
      startedAt: START,
      durationSeconds: 12,
      endedAt: START + 24_000,
      summary: 'MIRROR_FAILED_FINAL'
    })
    for (const item of [completed, failed]) {
      expect(agentEndTime(item, START + 50_000)).toBe(START + 12_000)
      expect(agentElapsed(item, START + 50_000)).toBe(12)
    }
    const frame = await captureFrame(dashboardNode({ subagents: [completed, failed] }), { width: 100, height: 24 })
    expect(frame).toContain('completed · 12s')
    expect(frame).toContain('failed · 12s')
    expect(frame).toContain('VERIFIED_FINAL')
    expect(frame).toContain('MIRROR_FAILED_FINAL')
    expect(frame).not.toContain('STALE_PROGRESS')
    expect(frame).not.toContain('waiting')
  })

  test('a shortened completion preview is not a second final answer in replay', async () => {
    const full = 'Verified result. '.repeat(40) + '\n\nFULL_REPLY_END'
    const completed = agent('completed', 'Verify contracts', {
      status: 'completed',
      summary: full.slice(0, 500),
      trace: [{ id: 1, kind: 'reply', text: full }]
    })
    const archived = snapshot('short-preview', 'Completed work', [completed], 0)
    const probe = await renderProbe(dashboardNode({ subagents: [], history: { snapshots: [archived] } }), {
      width: 132,
      height: 42
    })
    try {
      const bodies = descendants(probe.renderer.root).filter(item => item instanceof MarkdownRenderable)
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toHaveProperty('content', full)
      expect(probe.frame()).not.toContain('Final reply')
      expect(probe.frame().match(/❯ Assistant/g)).toHaveLength(1)
    } finally {
      probe.destroy()
    }
  })

  test('unknown terminal time stays unknown while the active sibling advances', async () => {
    const finished = agent('finished', 'Finished without timestamp', { status: 'completed', startedAt: START })
    const active = agent('active', 'Still working', { startedAt: START })
    expect(agentEndTime(finished, START + 1_000)).toBeUndefined()
    expect(agentEndTime(finished, START + 50_000)).toBeUndefined()
    expect(agentEndTime(active, START + 50_000)).toBe(START + 50_000)
    expect(agentEndTime({ ...finished, endedAt: START + 5_000 }, START + 50_000)).toBe(START + 5_000)
    const frame = await captureFrame(dashboardNode({ subagents: [finished, active] }), { width: 132, height: 32 })
    expect(frame).toContain('timing unknown')
    expect(frame).toContain('Finished without timestamp')
    expect(frame).toContain('Still working')
  })

  test('replay preserves trace metadata and keeps real reasoning separate from activity', async () => {
    const record = dashboardAgentFromRecord({
      subagent_id: 'retained',
      goal: 'Full original goal',
      task_label: 'Readable task',
      status: 'completed',
      ended_at: START + 4_000,
      trace_dropped: 3,
      trace_truncated: true,
      thinking: ['ACTIVITY_ONLY'],
      trace: [
        { id: 4, kind: 'reasoning', text: '**MODEL_REASONING**', truncated: true },
        { id: 5, kind: 'reply', text: 'Retained final reply' }
      ]
    })
    if (record === undefined) throw new Error('missing normalized archive')
    expect(record.taskLabel).toBe('Readable task')
    expect(record.endedAt).toBe(START + 4_000)
    expect(record.trace?.map(entry => entry.id)).toEqual([4, 5])
    const archived = snapshot('retained-snapshot', 'Retained work', [record], 0)
    const probe = await renderProbe(dashboardNode({ subagents: [], history: { snapshots: [archived] } }), {
      width: 132,
      height: 34
    })
    try {
      expect(probe.frame()).toContain('Readable task')
      expect(probe.frame()).toContain('3 events omitted')
      expect(probe.frame()).toContain('▸ Reasoning')
      expect(probe.frame()).not.toContain('ACTIVITY_ONLY')
      expect(
        descendants(probe.renderer.root).some(
          item => item instanceof MarkdownRenderable && item.content === '**MODEL_REASONING**'
        )
      ).toBe(false)
      probe.keys.pressEnter()
      probe.keys.pressKey('r')
      await probe.settle()
      const reasoning = descendants(probe.renderer.root).find(
        item => item instanceof MarkdownRenderable && item.content === '**MODEL_REASONING**'
      )
      expect(reasoning).toBeInstanceOf(MarkdownRenderable)
      if (!(reasoning instanceof MarkdownRenderable)) throw new Error('missing native reasoning')
      expect(reasoning.streaming).toBe(false)
      expect(probe.frame()).not.toContain('ACTIVITY_ONLY')
      probe.keys.pressKey('a')
      await probe.settle()
      expect(
        descendants(probe.renderer.root).some(
          item => item instanceof MarkdownRenderable && item.content === 'ACTIVITY_ONLY'
        )
      ).toBe(true)
    } finally {
      probe.destroy()
    }
  })

  test.each([
    { width: 132, height: 30 },
    { width: 80, height: 24 }
  ])('reader inspection survives appends at $width×$height with separate pinned headers', async dimensions => {
    const trace = Array.from({ length: 30 }, (_, index) => ({
      id: index,
      kind: 'reply' as const,
      text: `Retained paragraph ${String(index)}`
    }))
    const current = agent('stream', 'Observe retained messages', { trace })
    const [items, setItems] = createSignal<readonly DashboardAgent[]>([current])
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <AgentsDashboard subagents={items()} onClose={() => {}} />
        </ThemeProvider>
      ),
      dimensions
    )
    try {
      if (dimensions.width < 110) {
        probe.keys.pressEnter()
        await probe.settle()
        expect(
          probe
            .frame()
            .split('\n')
            .filter(line => line.includes('← Back to agents'))
        ).toHaveLength(1)
      }
      const scroll = descendants(probe.renderer.root).find(item => item.id === 'agent-detail-scroll')
      if (!(scroll instanceof ScrollBoxRenderable)) throw new Error('missing detail scroll')
      expect(scroll.scrollTop).toBeGreaterThan(0)
      expect(probe.frame()).toContain('Following live')
      await probe.scroll(scroll.x + 5, scroll.y + 3, 'up')
      await probe.settle()
      expect(probe.frame()).toContain('Scroll paused')
      const position = scroll.scrollTop
      setItems([{ ...current, trace: [...trace, { id: 30, kind: 'reply', text: 'Newest reply' }] }])
      await probe.settle()
      expect(scroll.scrollTop).toBe(position)
      expect(probe.frame()).toContain('Scroll paused')
      probe.keys.pressKey('l', { shift: true })
      await probe.settle()
      expect(probe.frame()).toContain('Following live')
      expect(scroll.scrollTop).toBeGreaterThan(position)
      probe.keys.pressArrow('up')
      await probe.settle()
      expect(probe.frame()).toContain('Scroll paused')
      const keyboardPosition = scroll.scrollTop
      setItems([
        {
          ...current,
          trace: [
            ...trace,
            { id: 30, kind: 'reply', text: 'Newest reply with more text' },
            { id: 31, kind: 'reply', text: 'Additional reply' }
          ]
        }
      ])
      await probe.settle()
      expect(scroll.scrollTop).toBe(keyboardPosition)
      expect(probe.frame()).toContain('Scroll paused')
      if (dimensions.width < 110) {
        const lines = probe.frame().split('\n')
        const back = lines.findIndex(line => line.includes('← Back to agents'))
        const paused = lines.findIndex(line => line.includes('Scroll paused'))
        expect(back).toBeGreaterThanOrEqual(0)
        expect(paused).toBe(back + 1)
      }
    } finally {
      probe.destroy()
    }
  })
})
