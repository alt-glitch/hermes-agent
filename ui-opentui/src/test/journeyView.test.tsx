import { describe, expect, test, vi } from 'vitest'

import { DEFAULT_THEME } from '../logic/theme.ts'
import { JourneyOverlay, type JourneyOps } from '../view/overlays/journey.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

const FRAME = {
  axis: { end: 'Now', start: 'Jan' },
  buckets: [
    {
      date: '2026-01-01',
      index: 0,
      label: 'Today',
      memories: 1,
      nodes: [
        {
          body: 'remember the release checklist',
          glyph: '◆',
          id: 'm1',
          label: 'Release memory',
          meta: 'memory',
          style: 'memory'
        },
        { glyph: '✦', id: 's1', label: 'Deploy skill', meta: 'skill', style: 'skill' }
      ],
      skills: 1
    }
  ],
  count: 2,
  frames: [],
  legend: [],
  summary: ['2 learnings']
}

const CROWDED_FRAME = {
  ...FRAME,
  buckets: [
    {
      ...FRAME.buckets[0],
      nodes: [
        {
          glyph: '◆',
          id: 'm-long',
          label: `FIRST ROW ${'long label '.repeat(18)}TAIL_SHOULD_BE_CLIPPED`,
          meta: 'profile memory · 16 Jul 2026',
          style: 'memory'
        },
        { glyph: '✦', id: 's-second', label: 'SECOND ROW', meta: 'skill · 16 Jul 2026', style: 'skill' }
      ]
    }
  ],
  count: 2,
  frames: [
    {
      grid: [[[` chart ${'━'.repeat(120)}CHART_TAIL_SHOULD_BE_CLIPPED`, 'dim']], [[' chart two', 'dim']]]
    }
  ],
  summary: [`2 learnings · ${'summary '.repeat(20)}SUMMARY_TAIL_SHOULD_BE_CLIPPED`]
}

const LONG_FRAME = {
  ...FRAME,
  buckets: [
    {
      ...FRAME.buckets[0],
      nodes: Array.from({ length: 24 }, (_, index) => ({
        glyph: '✦',
        id: `s${index}`,
        label: `Journey skill ${index}`,
        meta: 'skill',
        style: 'skill'
      }))
    }
  ],
  count: 24
}

interface Harness {
  readonly closed: { value: number }
  readonly deletes: string[]
  readonly edits: Array<{ content: string; id: string }>
  readonly frameCalls: Array<{ cols: number; rows: number }>
  readonly probe: RenderProbe
}

async function mount(
  overrides: Partial<JourneyOps> = {},
  size: { height?: number; width?: number } = {}
): Promise<Harness> {
  const closed = { value: 0 }
  const deletes: string[] = []
  const edits: Array<{ content: string; id: string }> = []
  const frameCalls: Array<{ cols: number; rows: number }> = []
  const ops: JourneyOps = {
    frames: async (cols, rows) => {
      frameCalls.push({ cols, rows })
      return FRAME
    },
    detail: async id => ({ content: `detail for ${id}`, message: 'ok', ok: true }),
    edit: async (id, content) => {
      edits.push({ content, id })
      return { message: 'learning updated', ok: true }
    },
    delete: async id => {
      deletes.push(id)
      return { message: 'learning deleted', ok: true }
    },
    ...overrides
  }
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => DEFAULT_THEME}>
        <JourneyOverlay ops={ops} onClose={() => closed.value++} />
      </ThemeProvider>
    ),
    { height: size.height ?? 24, kittyKeyboard: true, width: size.width ?? 90 }
  )
  return { closed, deletes, edits, frameCalls, probe }
}

function point(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split('\n')
  const y = lines.findIndex(line => line.includes(text))
  if (y < 0) throw new Error(`missing ${text}`)
  return { x: lines[y]!.indexOf(text), y }
}

describe('JourneyOverlay', () => {
  test('shows an in-body loading state, timeline data, and terminal-sized frame request', async () => {
    const h = await mount({
      frames: async () => {
        await new Promise(resolve => setTimeout(resolve, 80))
        return FRAME
      }
    })
    try {
      expect(h.probe.frame()).toContain('assembling your learning map')
      await new Promise(resolve => setTimeout(resolve, 100))
      await h.probe.settle()
      expect(h.probe.frame()).toContain('2 learnings')
      expect(h.probe.frame()).toContain('Today · 1 skills · 1 memories')
    } finally {
      h.probe.destroy()
    }

    const sized = await mount({}, { height: 20, width: 68 })
    try {
      expect(sized.frameCalls).toEqual([{ cols: 60, rows: 6 }])
      expect(sized.probe.frame()).toContain('starmap hidden below 80 columns')
      sized.probe.resize(120, 35)
      await sized.probe.settle()
      expect(sized.probe.frame()).toContain('Deploy skill')
    } finally {
      sized.probe.destroy()
    }
  })

  test('supports keyboard navigation, detail loading', async () => {
    const h = await mount()
    try {
      await h.probe.settle()
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.probe.frame()).toContain('detail for s1')
    } finally {
      h.probe.destroy()
    }
  })

  test('keeps chart, summary, and timeline entries inside single allocated rows', async () => {
    const h = await mount({ frames: async () => CROWDED_FRAME }, { height: 24, width: 90 })
    try {
      await h.probe.settle()
      const lines = h.probe.frame().split('\n')
      const chart = lines.findIndex(line => line.includes('chart '))
      const chartTwo = lines.findIndex(line => line.includes('chart two'))
      const first = lines.findIndex(line => line.includes('FIRST ROW'))
      const second = lines.findIndex(line => line.includes('SECOND ROW'))
      expect(chartTwo).toBe(chart + 1)
      expect(lines.filter(line => line.includes('summary')).length).toBe(1)
      expect(first).toBeGreaterThan(-1)
      expect(second).toBe(first + 1)
      expect(lines[second]).not.toContain('FIRST ROW')
    } finally {
      h.probe.destroy()
    }
  })

  test('mouse-selects rows, opens embedded detail, and requires delete confirmation', async () => {
    const h = await mount()
    try {
      await h.probe.settle()
      const memory = point(h.probe.frame(), 'Release memory')
      await h.probe.click(memory.x, memory.y)
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.probe.frame()).toContain('remember the release checklist')
      h.probe.keys.pressKey('d')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('y confirm')
      h.probe.keys.pressKey('n')
      await h.probe.settle()
      expect(h.deletes).toEqual([])
      h.probe.keys.pressKey('d')
      h.probe.keys.pressKey('y')
      await new Promise(resolve => setTimeout(resolve, 10))
      await h.probe.settle()
      expect(h.deletes).toEqual(['m1'])
    } finally {
      h.probe.destroy()
    }
  })

  test('mouse wheel moves the timeline cursor without retargeting a pending confirmation', async () => {
    const h = await mount({ frames: async () => LONG_FRAME }, { height: 18, width: 90 })
    try {
      await h.probe.settle()
      const footer = point(h.probe.frame(), 'wheel/↑↓/jk move')
      await h.probe.scroll(footer.x, footer.y, 'up')
      h.probe.keys.pressKey('d')
      await h.probe.settle()
      await h.probe.scroll(footer.x, footer.y, 'up')
      h.probe.keys.pressKey('y')
      await new Promise(resolve => setTimeout(resolve, 10))
      await h.probe.settle()
      expect(h.deletes).toEqual(['s22'])
    } finally {
      h.probe.destroy()
    }
  })

  test('surfaces malformed/errors and retries without closing the overlay', async () => {
    const frames = vi
      .fn<JourneyOps['frames']>()
      .mockRejectedValueOnce(new Error('gateway offline'))
      .mockResolvedValueOnce(FRAME)
    const h = await mount({ frames })
    try {
      await h.probe.settle()
      expect(h.probe.frame()).toContain('r retry')
      h.probe.keys.pressKey('r')
      await h.probe.settle()
      expect(frames).toHaveBeenCalledTimes(2)
      expect(h.closed.value).toBe(0)
    } finally {
      h.probe.destroy()
    }
  })
})
