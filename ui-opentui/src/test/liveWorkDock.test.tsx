/**
 * Live-work dock parity (Ink goalBar.tsx / processRoster.ts / agentsPanel.tsx):
 * the standing goal row fed by session.control.read + session.control.update,
 * and the session-scoped Processes block (process.list) in the dock and the
 * /agents overlay with the exited_at-based exit-verdict window.
 */
import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { decodeProcessListResponse, type ProcessEntry } from '../boundary/schema/ProcessResponses.ts'
import { decodeGoalSnapshot, type GoalSnapshot } from '../boundary/schema/SessionControl.ts'
import { goalLine } from '../logic/goalStatus.ts'
import { buildProcessRows, PROCESS_RETAIN_SECONDS, processSummary } from '../logic/processRoster.ts'
import { createSessionStore, type SessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

const goal = (over: Partial<GoalSnapshot> = {}): GoalSnapshot => ({
  title: 'ship the parity lane',
  status: 'active',
  turns_used: 3,
  max_turns: 20,
  ...over
})

const control = (g: unknown) => ({ goal: g, heartbeat: null, loop: null, revision: 'r1', updated_at: 1 })

const nowS = () => Date.now() / 1000

const proc = (over: Partial<ProcessEntry> = {}): ProcessEntry => ({
  session_id: 'proc_1',
  command: 'npm run dev',
  status: 'running',
  uptime_seconds: 42,
  output_preview: 'compiling…\nready on :3000\n',
  ...over
})

describe('goal line (Ink goalStatus.goalLine)', () => {
  test('active, parked, paused, and finished goals', () => {
    expect(goalLine(goal())).toEqual({ detail: '3/20 turns', glyph: '⊙', label: 'goal', title: 'ship the parity lane' })
    const parked = goalLine(goal({ wait_barrier: { type: 'pid', target: 4242, reason: 'build running' } }))
    expect(parked?.glyph).toBe('⏳')
    expect(parked?.detail).toBe('on pid 4242 · build running · 3/20 turns')
    expect(goalLine(goal({ status: 'paused', paused_reason: 'budget' }))?.detail).toBe('budget · 3/20 turns')
    expect(goalLine(goal({ status: 'done' }))).toBeNull()
    expect(goalLine(null)).toBeNull()
  })

  test('decode narrows the Unknown goal slot; malformed or null → no goal', () => {
    expect(decodeGoalSnapshot(goal())?.title).toBe('ship the parity lane')
    expect(decodeGoalSnapshot(null)).toBeNull()
    expect(decodeGoalSnapshot({ status: 'active' })).toBeNull()
  })
})

describe('goal snapshot in the store', () => {
  test('session.control.update sets and clears the goal; session reset drops it', () => {
    const store = createSessionStore()
    store.adoptFreshSession('s1')
    store.apply({ type: 'session.control.update', session_id: 's1', payload: { control: control(goal()) } })
    expect(store.state.goal?.turns_used).toBe(3)
    store.apply({ type: 'session.control.update', session_id: 's1', payload: { control: control(null) } })
    expect(store.state.goal).toBeNull()
    store.apply({ type: 'session.control.update', session_id: 's1', payload: { control: control(goal()) } })
    store.adoptFreshSession('s2')
    expect(store.state.goal).toBeNull()
  })

  test('session.control.read is claimed once per session and applies the snapshot', () => {
    const store = createSessionStore()
    store.adoptFreshSession('s1')
    expect(store.claimGoalRead('s1')).toBe(true)
    expect(store.claimGoalRead('s1')).toBe(false)
    expect(store.applySessionControlRead({ control: control(goal({ turns_used: 7 })), event_seq: 9 })).toBe(true)
    expect(store.state.goal?.turns_used).toBe(7)
    expect(store.applySessionControlRead({ nope: true })).toBe(false)
    // A failed read releases the claim for retry; a new session re-reads.
    store.releaseGoalRead('s1')
    expect(store.claimGoalRead('s1')).toBe(true)
    store.adoptFreshSession('s2')
    expect(store.claimGoalRead('s2')).toBe(true)
  })
})

describe('process roster (Ink processRoster.buildProcessRows)', () => {
  test('running rows show elapsed + last output; exits keep a verdict for the retain window', () => {
    const now = Date.now()
    const rows = buildProcessRows(
      [
        proc(),
        proc({ session_id: 'p2', command: 'pytest', status: 'exited', exit_code: 1, exited_at: now / 1000 - 5 }),
        proc({ session_id: 'p3', status: 'exited', exit_code: 0, exited_at: now / 1000 - PROCESS_RETAIN_SECONDS - 1 }),
        proc({ session_id: 'p4', status: 'exited', completion_reason: 'killed', exited_at: now / 1000 - 2 }),
        proc({ session_id: 'p5', status: 'exited', exit_code: 0 })
      ],
      now
    )
    expect(rows.map(r => [r.id, r.status, r.detail])).toEqual([
      ['proc_1', 'running', 'last: ready on :3000'],
      ['p4', 'killed', 'killed · 2s ago'],
      ['p2', 'failed', 'exit 1 · 5s ago']
    ])
    expect(processSummary(rows)).toBe('1 running · 2 done')
  })

  test('process.list decode keeps unknown fields and rejects a malformed row', () => {
    const ok = decodeProcessListResponse({ processes: [{ ...proc(), pid: 12, extra: 'x' }] })
    expect(Option.isSome(ok) && ok.value.processes?.length).toBe(1)
    expect(Option.isNone(decodeProcessListResponse({ processes: [{ command: 'x' }] }))).toBe(true)
  })

  test('store applies process.list and resets it with the session', () => {
    const store = createSessionStore()
    store.adoptFreshSession('s1')
    expect(store.applyProcessListResponse({ processes: [proc()] })).toBe(true)
    expect(store.state.sessionProcesses).toHaveLength(1)
    expect(store.applyProcessListResponse('garbage')).toBe(false)
    store.adoptFreshSession('s2')
    expect(store.state.sessionProcesses).toEqual([])
  })
})

async function mountApp(store: SessionStore) {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} />
      </ThemeProvider>
    ),
    { width: 100, height: 30 }
  )
}

const freshStore = () => {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.adoptFreshSession('s1')
  return store
}

describe('live-work dock view', () => {
  test('goal row renders above the dock from session.control.update and leaves when done', async () => {
    const store = freshStore()
    const h = await mountApp(store)
    try {
      expect(h.frame()).not.toContain('⊙ goal')
      store.apply({ type: 'session.control.update', session_id: 's1', payload: { control: control(goal()) } })
      const frame = await h.waitForFrame(f => f.includes('⊙ goal'))
      expect(frame).toContain('⊙ goal · 3/20 turns · ship the parity lane')
      store.apply({
        type: 'session.control.update',
        session_id: 's1',
        payload: { control: control(goal({ status: 'done' })) }
      })
      await h.waitForFrame(f => !f.includes('⊙ goal'))
    } finally {
      h.destroy()
    }
  })

  test('processes alone surface the dock block with running + exit-verdict rows', async () => {
    const store = freshStore()
    const h = await mountApp(store)
    try {
      expect(h.frame()).not.toContain('Processes')
      store.applyProcessListResponse({
        processes: [
          proc(),
          proc({ session_id: 'p2', command: 'pytest -q', status: 'exited', exit_code: 1, exited_at: nowS() - 3 }),
          proc({ session_id: 'p3', command: 'old-job', status: 'exited', exit_code: 0, exited_at: nowS() - 600 })
        ]
      })
      const frame = await h.waitForFrame(f => f.includes('Processes'))
      expect(frame).toContain('▾ Processes · 1 running · 1 done')
      expect(frame).toMatch(/⚙ npm run dev · 42s · last: ready on :3000/)
      expect(frame).toMatch(/✘ pytest -q · exit 1 · \ds ago/)
      expect(frame).not.toContain('old-job')
      store.applyProcessListResponse({ processes: [] })
      await h.waitForFrame(f => !f.includes('Processes'))
    } finally {
      h.destroy()
    }
  })

  test('/agents overlay lists the session processes under the tree', async () => {
    const store = freshStore()
    store.applyProcessListResponse({ processes: [proc({ command: 'tail -f build.log' })] })
    store.openDashboard()
    const h = await mountApp(store)
    try {
      const frame = await h.waitForFrame(f => f.includes('Processes · 1 running'))
      expect(frame).toContain('⚙ tail -f build.log')
    } finally {
      h.destroy()
    }
  })
})
