import { MarkdownRenderable, ScrollBoxRenderable, type Renderable } from '@opentui/core'
import { KeyCodes } from '@opentui/core/testing'
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

  test.each([false, true].flatMap(replay => [96, 124].map(width => ({ replay, width }))))(
    'every retained detail row is reachable by paging (replay=$replay, width=$width)',
    async ({ replay, width }) => {
      const labels = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, '0')}`)
      const filesRead = labels('read', 40)
      const filesWritten = labels('written', 40)
      const tools = labels('call', 24)
      const outputs = labels('output', 12)
      const events = labels('event', 40)
      const notes = labels('note', 12)
      const row = agent('retained', 'Inspect retained records', {
        filesRead,
        filesWritten,
        tools,
        outputTail: outputs.map(preview => ({ preview, tool: 'terminal', isError: false })),
        trace: events.map(text => ({ kind: 'tool', text })),
        notes,
        status: replay ? 'completed' : 'running'
      })
      const probe = await renderProbe(
        dashboardNode({
          subagents: replay ? [] : [row],
          history: { snapshots: replay ? [snapshot('retained-run', 'Retained records', [row], 0)] : [] }
        }),
        { width, height: 30 }
      )
      try {
        probe.keys.pressEnter()
        await probe.settle()
        const scroll = descendants(probe.renderer.root).find(
          (item): item is ScrollBoxRenderable => item instanceof ScrollBoxRenderable
        )
        expect(scroll).toBeDefined()
        for (const { key, entries } of [
          { key: 'f', entries: [...filesWritten, ...filesRead] },
          { key: 't', entries: tools },
          { key: 'o', entries: outputs },
          { key: 'e', entries: events },
          { key: 'n', entries: notes }
        ]) {
          probe.keys.pressKey(key)
          await probe.settle()
          probe.keys.pressKey(KeyCodes.HOME)
          await probe.settle()
          let frames = probe.frame()
          for (let page = 0; page < 30; page += 1) {
            const before = scroll!.scrollTop
            probe.keys.pressKey('\u001b[6~')
            await probe.settle()
            frames += probe.frame()
            if (scroll!.scrollTop === before) break
          }
          for (const entry of entries) expect(frames, `section ${key}`).toContain(entry)
          probe.keys.pressKey(key)
          await probe.settle()
        }
      } finally {
        probe.destroy()
      }
    }
  )

  test.each(
    ['queued', 'running', 'completed', 'failed', 'error', 'interrupted', 'timeout'].flatMap(status =>
      [false, true].flatMap(replay => [96, 124].map(width => ({ status, replay, width })))
    )
  )('$status agents: sections and navigation (replay=$replay, width=$width)', async ({ status, replay, width }) => {
    const row = agent('state-row', `Inspect ${status}`, {
      ...RICH_AGENTS[0],
      id: 'state-row',
      status,
      thinking: ['Activity marker'],
      notes: ['Progress marker'],
      trace: [
        { kind: 'reasoning', text: 'Reasoning marker' },
        { kind: 'tool', text: 'Trace marker' }
      ]
    })
    const killed = vi.fn()
    const probe = await renderProbe(
      dashboardNode({
        subagents: replay ? [] : [row],
        history: { snapshots: [snapshot('state-snapshot', 'state snapshot', [row], 0)] },
        onKillAgent: killed
      }),
      {
        width,
        height: 50,
        kittyKeyboard: true
      }
    )
    try {
      probe.keys.pressTab()
      await probe.settle()
      for (const [key, title] of [
        ['a', 'Activity'],
        ['t', 'Tool calls'],
        ['o', 'Output'],
        ['d', 'Details'],
        ['b', 'Budget'],
        ['e', 'Live trace'],
        ['f', 'Files'],
        ['n', 'Progress']
      ] as const) {
        probe.keys.pressKey(key)
        probe.keys.pressKey('g')
        await probe.settle()
        expect(probe.frame()).toContain(`▾ ${title}`)
        probe.keys.pressKey(key)
        await probe.settle()
        expect(probe.frame()).toContain(`▸ ${title}`)
      }
      probe.keys.pressKey('r')
      await probe.settle()
      expect(
        descendants(probe.renderer.root).some(
          item => item instanceof MarkdownRenderable && item.content === 'Reasoning marker'
        )
      ).toBe(true)
      probe.keys.pressKey('x')
      await probe.settle()
      if (!replay && (status === 'queued' || status === 'running')) expect(killed).toHaveBeenCalledWith('state-row')
      else {
        expect(killed).not.toHaveBeenCalled()
        expect(probe.frame()).toContain(replay ? 'replay mode — controls disabled' : 'agent already finished')
      }
      probe.keys.pressEscape()
      await probe.settle()
      expect(probe.frame()).toContain('Enter')
      probe.keys.pressArrow('right')
      await probe.settle()
      expect(probe.frame()).toContain('Esc back')
      probe.keys.pressArrow('left')
      await probe.settle()
      expect(probe.frame()).toContain('Enter')
    } finally {
      probe.destroy()
    }
  })

  test('replay stays on its snapshot through prepend and pruning, and can return to empty live', async () => {
    const first = snapshot('first', 'first', [agent('first-agent', 'Original replay')], 0)
    const second = snapshot('second', 'second', [agent('second-agent', 'Newer replay')], 1000)
    const [history, setHistory] = createSignal<SpawnHistoryState>({ snapshots: [first] })
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <AgentsDashboard subagents={[]} history={history()} onClose={() => {}} />
        </ThemeProvider>
      ),
      { width: 96, height: 30 }
    )
    try {
      expect(probe.frame()).toContain('Original replay')
      setHistory({ snapshots: [second, first] })
      await probe.settle()
      expect(probe.frame()).toContain('Original replay')
      expect(probe.frame()).not.toContain('Newer replay')
      setHistory({ snapshots: [second] })
      await probe.settle()
      expect(probe.frame()).toContain('Original replay')
      probe.keys.pressKey(']')
      await probe.settle()
      expect(probe.frame()).toContain('No subagents this turn')
      probe.keys.pressTab()
      probe.keys.pressKey('f')
      probe.keys.pressKey('[')
      await probe.settle()
      expect(probe.frame()).toContain('Newer replay')
    } finally {
      probe.destroy()
    }
  })

  test('pending and rejected controls never trap navigation or multiply requests', async () => {
    let rejectAction: (reason: Error) => void = () => {}
    const kill = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAction = reject
        })
    )
    const close = vi.fn()
    const probe = await renderProbe(dashboardNode({ onKillAgent: kill, onClose: close }), { width: 96, height: 34 })
    try {
      probe.keys.pressKey('x')
      await probe.settle()
      probe.keys.pressKey('x')
      probe.keys.pressArrow('down')
      probe.keys.pressEnter()
      await probe.settle()
      expect(kill).toHaveBeenCalledTimes(1)
      expect(probe.frame()).toContain('control request pending')
      expect(probe.frame()).toContain('Audit native platform artifacts')
      rejectAction(new Error('Backend unavailable'))
      await probe.settle()
      expect(probe.frame()).toContain('Backend unavailable')
      probe.keys.pressKey('q')
      await probe.settle()
      expect(close).toHaveBeenCalledOnce()
    } finally {
      probe.destroy()
    }
  })

  test('page, home/end, help, modifiers and Ctrl+C work without trapping focus', async () => {
    const close = vi.fn()
    const kill = vi.fn()
    const rows = Array.from({ length: 30 }, (_, index) =>
      agent(`key-${String(index)}`, `Key task ${String(index)}`, {
        index,
        status: index % 2 ? 'completed' : 'running',
        notes: Array.from(
          { length: 6 },
          (_, line) => `Progress line ${String(line)}\n${'retained progress\n'.repeat(15)}`
        )
      })
    )
    const probe = await renderProbe(dashboardNode({ subagents: rows, onClose: close, onKillSubtree: kill }), {
      width: 96,
      height: 30,
      kittyKeyboard: true
    })
    try {
      probe.keys.pressKey(KeyCodes.END)
      probe.keys.pressEnter()
      await probe.settle()
      expect(probe.frame()).toContain('#30')
      probe.keys.pressTab({ shift: true })
      probe.keys.pressKey(KeyCodes.HOME)
      probe.keys.pressKey('\u001b[6~')
      probe.keys.pressEnter()
      await probe.settle()
      expect(probe.frame()).not.toContain('#1 ')
      probe.keys.pressKey('n')
      await probe.settle()
      probe.keys.pressKey(KeyCodes.END)
      await probe.settle()
      const scroll = descendants(probe.renderer.root).find(
        (item): item is ScrollBoxRenderable => item instanceof ScrollBoxRenderable
      )
      expect(scroll).toBeDefined()
      const bottom = scroll!.scrollTop
      expect(bottom).toBeGreaterThan(0)
      probe.keys.pressKey('u', { ctrl: true })
      await probe.settle()
      expect(scroll!.scrollTop).toBeLessThan(bottom)
      probe.keys.pressKey('d', { ctrl: true })
      await probe.settle()
      expect(scroll!.scrollTop).toBe(bottom)
      probe.keys.pressKey('x', { ctrl: true, shift: true })
      await probe.settle()
      expect(kill).not.toHaveBeenCalled()
      probe.keys.pressKey('?')
      await probe.settle()
      expect(probe.frame()).toContain('files · n progress')
      probe.keys.pressEscape()
      await probe.settle()
      expect(probe.frame()).not.toContain('files · n progress')
      expect(close).not.toHaveBeenCalled()
      probe.keys.pressCtrlC()
      await probe.settle()
      expect(close).not.toHaveBeenCalled()
      probe.keys.pressCtrlC()
      await probe.settle()
      expect(close).toHaveBeenCalledOnce()
    } finally {
      probe.destroy()
    }
  })

  test('a finished parent can stop its still-running descendants, but not an entirely finished tree', async () => {
    const stop = vi.fn()
    const [rows, setRows] = createSignal([
      agent('parent', 'Finished parent', { status: 'completed' }),
      agent('child', 'Running child', { parentId: 'parent', depth: 1 })
    ])
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <AgentsDashboard subagents={rows()} onClose={() => {}} onKillSubtree={stop} />
        </ThemeProvider>
      ),
      { width: 96, height: 30 }
    )
    try {
      probe.keys.pressKey('x', { shift: true })
      await probe.settle()
      expect(stop).toHaveBeenCalledWith(['parent', 'child'])
      setRows(current => current.map(row => ({ ...row, status: 'interrupted' })))
      await probe.settle()
      probe.keys.pressKey('x', { shift: true })
      await probe.settle()
      expect(stop).toHaveBeenCalledOnce()
      expect(probe.frame()).toContain('subtree already finished')
    } finally {
      probe.destroy()
    }
  })

  test('empty filtered views recover with f, while diff ignores hidden help and closes once', async () => {
    const probe = await renderProbe(
      dashboardNode({ subagents: [agent('done', 'Done task', { status: 'completed' })] }),
      { width: 80, height: 24 }
    )
    try {
      probe.keys.pressKey('f')
      await probe.settle()
      expect(probe.frame()).toContain('No agents match filter: running')
      probe.keys.pressTab()
      probe.keys.pressKey('f')
      probe.keys.pressKey('f')
      await probe.settle()
      expect(probe.frame()).toContain('Done task')
    } finally {
      probe.destroy()
    }
    const close = vi.fn()
    const clear = vi.fn()
    const diff = await renderProbe(
      dashboardNode({
        onClose: close,
        onClearDiff: clear,
        diffPair: {
          baseline: snapshot('a', 'before', RICH_AGENTS, 0),
          candidate: snapshot('b', 'after', RICH_AGENTS, 1000)
        }
      }),
      { width: 96, height: 30, kittyKeyboard: true }
    )
    try {
      diff.keys.pressKey('?')
      diff.keys.pressEscape()
      await diff.settle()
      expect(close).toHaveBeenCalledOnce()
      expect(clear).toHaveBeenCalledOnce()
    } finally {
      diff.destroy()
    }
  })

  test('spawning can pause/resume, and all controls stay locked after live rows archive', async () => {
    const [delegation, setDelegation] = createSignal(createDelegationState())
    const [rows, setRows] = createSignal<readonly DashboardAgent[]>(RICH_AGENTS)
    const [history, setHistory] = createSignal<SpawnHistoryState>({ snapshots: [] })
    const pause = vi.fn((paused: boolean) => {
      setDelegation(current => ({ ...current, paused }))
    })
    const kill = vi.fn()
    const subtree = vi.fn()
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <AgentsDashboard
            subagents={rows()}
            history={history()}
            delegation={delegation()}
            onClose={() => {}}
            onPauseChange={pause}
            onKillAgent={kill}
            onKillSubtree={subtree}
          />
        </ThemeProvider>
      ),
      { width: 96, height: 30 }
    )
    try {
      probe.keys.pressKey('p')
      await probe.settle()
      expect(delegation().paused).toBe(true)
      probe.keys.pressKey('p')
      await probe.settle()
      expect(delegation().paused).toBe(false)
      setHistory({ snapshots: [snapshot('finished', 'finished', RICH_AGENTS, 1000)] })
      setRows([])
      await probe.settle()
      expect(probe.frame()).toContain('Last turn')
      for (const key of ['p', 'x', 'X']) {
        probe.keys.pressKey(key.toLowerCase(), { shift: key === 'X' })
        await probe.settle()
        expect(probe.frame()).toContain('replay mode — controls disabled')
      }
      expect(pause).toHaveBeenCalledTimes(2)
      expect(kill).not.toHaveBeenCalled()
      expect(subtree).not.toHaveBeenCalled()
      probe.resize(40, 12)
      probe.keys.pressKey('?')
      await probe.settle()
      probe.keys.pressKey(KeyCodes.END)
      await probe.settle()
      expect(probe.frame()).toContain('running agents)')
      probe.keys.pressKey('?')
      probe.keys.pressKey(']')
      setRows(RICH_AGENTS)
      await probe.settle()
      expect(probe.frame()).toContain('Spawn tree')
    } finally {
      probe.destroy()
    }
  })

  test('clicking scrollable help never steals close-layer focus or double-scrolls', async () => {
    const close = vi.fn()
    const probe = await renderProbe(dashboardNode({ onClose: close }), { width: 40, height: 12, kittyKeyboard: true })
    try {
      probe.keys.pressKey('?')
      await probe.settle()
      const help = descendants(probe.renderer.root).find(
        (item): item is ScrollBoxRenderable => item instanceof ScrollBoxRenderable && item.id === 'agents-key-help'
      )
      expect(help).toBeDefined()
      await probe.click(help!.x + 2, help!.y + 1)
      const before = help!.scrollTop
      probe.keys.pressArrow('down')
      await probe.settle()
      expect(help!.scrollTop).toBe(before + 1)
      probe.keys.pressKey('?')
      await probe.settle()
      probe.keys.pressEscape()
      await probe.settle()
      expect(close).toHaveBeenCalledOnce()
    } finally {
      probe.destroy()
    }
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
      expect((frame.match(/TRACE_/g) ?? []).length).toBeGreaterThan(20)
      expect(frame).toContain('TRACE_08')
      expect(frame).toContain('q close')
      probe.keys.pressKey(KeyCodes.END)
      await probe.settle()
      expect(probe.frame()).toContain('TRACE_27')
      probe.keys.pressKey(KeyCodes.HOME)
      await probe.settle()
      expect(probe.frame()).toContain('TRACE_00')
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
