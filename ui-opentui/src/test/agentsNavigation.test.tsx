import { type Renderable } from '@opentui/core'
import { createSignal } from 'solid-js'
import { expect, test, vi } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { buildSubagentTree } from '../logic/subagentTree.ts'
import { App } from '../view/App.tsx'
import { AgentsTray, type AgentsTrayApi } from '../view/agentsTray.tsx'
import { AgentsDashboard } from '../view/overlays/agentsDashboard.tsx'
import { dashboardTreePaths, prepareDashboardRows } from '../view/overlays/agents/model.ts'
import { ThemeProvider } from '../view/theme.tsx'
import { agentFanout, seedAgentFanout } from './lib/agentFanout.ts'
import { renderProbe } from './lib/render.ts'

function find(root: Renderable, id: string): Renderable | undefined {
  if (root.id === id) return root
  for (const child of root.getChildren()) {
    const match = find(child, id)
    if (match) return match
  }
  return undefined
}

test('expanded tray keeps the selected identity visible through fan-out, removal and resize', async () => {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  seedAgentFanout(store)
  const last = store.state.subagents.at(-1)!
  const previous = store.state.subagents.at(-2)!
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} />
      </ThemeProvider>
    ),
    { width: 120, height: 36, kittyKeyboard: true }
  )
  try {
    probe.keys.pressArrow('down')
    await probe.settle()
    expect(probe.frame()).toContain('Enter inspect')
    for (let index = 1; index < 223; index++) probe.keys.pressArrow('down')
    await probe.settle()
    expect(
      probe
        .frame()
        .split('\n')
        .find(line => line.includes('▸ ● running'))
    ).toContain(last.goal.slice(0, 8))
    expect(probe.frame()).toContain('Esc back')
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'worker-000', summary: 'done' } })
    for (const [width, height] of [
      [90, 28],
      [52, 14],
      [120, 36]
    ]) {
      probe.resize(width!, height!)
      await vi.waitFor(async () => {
        await probe.settle()
        expect(
          probe
            .frame()
            .split('\n')
            .find(line => line.includes('▸ ● running'))
        ).toContain(last.goal.slice(0, 8))
        expect(probe.frame()).toContain('Esc back')
      })
    }
    probe.keys.pressArrow('up')
    await probe.settle()
    expect(
      probe
        .frame()
        .split('\n')
        .find(line => line.includes('▸ ● running'))
    ).toContain(previous.goal.slice(0, 8))
    const row = find(probe.renderer.root, `agent-tray-row-${previous.id}`)
    expect(row).toBeDefined()
    await probe.scroll(row!.x + 2, row!.y, 'down')
    expect(
      probe
        .frame()
        .split('\n')
        .find(line => line.includes('▸ ● running'))
    ).toContain(last.goal.slice(0, 8))
    store.apply({ type: 'subagent.complete', payload: { subagent_id: last.id, summary: 'finished' } })
    await probe.settle()
    expect(
      probe
        .frame()
        .split('\n')
        .find(line => line.includes('▸ ● running'))
    ).toContain(previous.goal.slice(0, 8))
    probe.keys.pressEnter()
    await probe.settle()
    expect(probe.frame()).toContain('Spawn tree')
    expect(store.state.dashboardAgent).toBe(previous.id)
    probe.keys.pressEscape()
    await vi.waitFor(async () => {
      await probe.settle()
      expect(store.state.dashboard).toBe(false)
      expect(probe.frame()).toContain('Type your message')
    })
    await probe.keys.typeText('composer remains usable')
    expect(await probe.waitForFrame(frame => frame.includes('composer remains usable'))).toContain(
      'composer remains usable'
    )
    store.adoptFreshSession('next-session')
    await probe.settle()
    expect(probe.frame()).not.toContain('agents active')
    expect(store.state.subagents).toEqual([])
  } finally {
    probe.destroy()
  }
})

test('tray selection survives insertion and reordering and exits when the roster is cleared', async () => {
  const [agents, setAgents] = createSignal(agentFanout())
  const opened = vi.fn()
  const exited = vi.fn()
  let api: AgentsTrayApi | undefined
  const probe = await renderProbe(() => (
    <ThemeProvider>
      <AgentsTray subagents={agents()} bind={value => (api = value)} onOpen={opened} onExit={exited} />
    </ThemeProvider>
  ))
  try {
    expect(api?.focusTray()).toBe(true)
    probe.keys.pressArrow('down')
    await probe.settle()
    const selected = agents()[1]!
    setAgents(current => [
      { id: 'new-arrival', depth: 0, goal: 'New arrival', status: 'queued' },
      ...current.toReversed()
    ])
    await probe.settle()
    expect(
      probe
        .frame()
        .split('\n')
        .find(line => line.includes('▸ ● running'))
    ).toContain(selected.goal.slice(0, 8))
    probe.keys.pressEnter()
    expect(opened).toHaveBeenCalledWith(selected.id)
    setAgents([])
    await probe.settle()
    expect(exited).toHaveBeenCalledOnce()
    expect(probe.frame()).not.toContain('Enter inspect')
  } finally {
    probe.destroy()
  }
})

test('folding follows parent identity and filters never invent ancestry or hide matching descendants', () => {
  const agents = agentFanout()
  const collapsed = new Set(['worker-010'])
  const rows = prepareDashboardRows(agents, 'depth-first', 'all', collapsed)
  const paths = dashboardTreePaths(buildSubagentTree(agents))
  expect(paths.get('worker-011')?.ancestors).toHaveLength(11)
  expect(paths.get('worker-011')?.ancestors.at(-1)).toBe('worker-010')
  expect(rows.some(node => node.item.id === 'worker-010')).toBe(true)
  expect(rows.some(node => node.item.id === 'worker-011')).toBe(false)
  expect(rows.some(node => node.item.id === 'worker-012')).toBe(true)
  expect(
    prepareDashboardRows(agents, 'depth-first', 'running', collapsed).some(node => node.item.id === 'worker-011')
  ).toBe(true)

  const orphan = { id: 'orphan', parentId: 'late-parent', depth: 99, goal: 'Orphan', status: 'running' }
  const first = dashboardTreePaths(buildSubagentTree([orphan]))
  expect(first.get('orphan')?.ancestors).toEqual([])
  const parent = { id: 'late-parent', depth: 0, goal: 'Parent', status: 'running' }
  const recovered = dashboardTreePaths(buildSubagentTree([orphan, parent]))
  expect(recovered.get('orphan')?.ancestors).toEqual(['late-parent'])
  expect(orphan.parentId).toBe(parent.id)
})

test('ownership overview hides messages until inspection and retains deep tree navigation on return', async () => {
  const [agents, setAgents] = createSignal(agentFanout())
  const probe = await renderProbe(
    () => (
      <ThemeProvider>
        <AgentsDashboard subagents={agents()} onClose={() => {}} preselect="worker-011" />
      </ThemeProvider>
    ),
    { width: 120, height: 36, kittyKeyboard: true }
  )
  try {
    expect(probe.frame()).not.toContain('Following live')
    expect(probe.frame()).not.toContain('Messages')
    expect(find(probe.renderer.root, 'agents-master')?.width).toBeGreaterThan(100)
    expect(probe.frame()).toContain('worker-010')
    expect(probe.frame()).toContain('worker-011')
    probe.keys.pressEnter()
    await probe.settle()
    expect(probe.frame()).toContain('Report from worker-011')
    probe.keys.pressEscape()
    await probe.settle()
    expect(probe.frame()).not.toContain('Messages')
    expect(probe.frame()).toContain('worker-011')
    probe.keys.pressArrow('left') // fold the selected branch
    await probe.settle()
    expect(probe.frame()).toContain('▸')
    probe.keys.pressArrow('right') // expand without opening messages
    await probe.settle()
    expect(probe.frame()).not.toContain('Messages')
    setAgents(current => current.map(agent => ({ ...agent, toolCount: 99 })))
    probe.resize(52, 14)
    await probe.settle()
    expect(probe.frame()).toContain('worker-011')
    expect(probe.frame()).toContain('q close')
    probe.keys.pressEnter()
    await probe.settle()
    expect(probe.frame()).toContain('Report from worker-011')
  } finally {
    probe.destroy()
  }
})
