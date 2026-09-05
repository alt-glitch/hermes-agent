import { describe, expect, test } from 'vitest'
import { decodeJourneyDetail, decodeJourneyFrames, decodeJourneyMutation } from '../boundary/schema/JourneyResponses.ts'
import { journeyRows, journeyStep, journeyWindowStart } from '../logic/journey.ts'
const FRAME = {
  axis: { start: 'Jan', end: 'Now' },
  count: 2,
  frames: [],
  legend: [],
  summary: ['2 learnings'],
  buckets: [
    {
      date: '2026-01-01',
      index: 0,
      label: 'Today',
      memories: 1,
      skills: 1,
      nodes: [
        { glyph: '◆', id: 'm1', label: 'Memory', meta: 'memory', style: 'memory', body: 'body' },
        { glyph: '✦', id: 's1', label: 'Skill', meta: 'skill', style: 'skill' }
      ]
    }
  ]
}
describe('Journey contracts', () => {
  test('decodes frames/detail/mutations and rejects malformed payloads', () => {
    expect(decodeJourneyFrames(FRAME)?.count).toBe(2)
    expect(decodeJourneyFrames({ ...FRAME, count: '2' })).toBeUndefined()
    expect(decodeJourneyDetail({ ok: true, message: 'ok', content: 'x' })).toMatchObject({ ok: true, content: 'x' })
    expect(decodeJourneyMutation({ ok: true, message: 'deleted' })).toEqual({ ok: true, message: 'deleted' })
  })
  test('builds chronological slice/node rows and clamps navigation/window', () => {
    const rows = journeyRows(decodeJourneyFrames(FRAME))
    expect(rows.map(r => r.kind)).toEqual(['slice', 'node', 'node'])
    expect(journeyStep(rows, 2, 1)).toBe(2)
    expect(journeyStep(rows, 0, -1)).toBe(0)
    expect(journeyWindowStart(8, 20, 6)).toBe(5)
  })
  test('decodes producer visual fields, shorter runs, and additive metadata', () => {
    const grid = [
      [
        ['text'],
        ['styled', 'dim'],
        ['faded', 'skill', 0.7],
        ['colored', 'skill', 1, '#abcdef'],
        ['plain', 'memory', 0.9, null]
      ]
    ]
    const decoded = decodeJourneyFrames({
      ...FRAME,
      frames: [{ grid, reveal: 1, visible: 2, date: 'Now', labels: [] }],
      legend: [{ glyph: '●', label: 'skills (1)', style: 'skill' }],
      categories: [{ glyph: '●', label: 'development (1)', color: '#abcdef' }]
    })
    expect(decoded?.frames[0]?.grid).toEqual(grid)
    expect(decoded?.legend[0]?.label).toBe('skills (1)')
    expect(decoded?.categories?.[0]?.color).toBe('#abcdef')
    expect(journeyRows(decoded)).toHaveLength(3)
    expect(decodeJourneyFrames(FRAME)?.categories).toBeUndefined()
  })
  test.each(
    [
      null,
      'not an array',
      {},
      [null],
      [{ grid: null }],
      [{ grid: [null] }],
      [{ grid: [[null]] }],
      [{ grid: [[[]]] }],
      [{ grid: [[[3]]] }],
      [{ grid: [[['text', {}]]] }],
      [{ grid: [[['text', 'dim', 'bright']]] }],
      [{ grid: [[['text', 'dim', Infinity]]] }],
      [{ grid: [[['text', 'dim', 1, {}]]] }]
    ].map(frames => ({ frames }))
  )('drops malformed chart data without dropping the learning list: $frames', ({ frames }) => {
    const decoded = decodeJourneyFrames({ ...FRAME, frames })
    expect(decoded?.frames).toEqual([])
    expect(journeyRows(decoded).map(row => row.kind)).toEqual(['slice', 'node', 'node'])
  })
  test.each(['legend', 'categories'] as const)('isolates malformed %s from other visual sections', field => {
    const valid = [{ glyph: '●', label: 'skills' }]
    const grid = [[['chart', 'dim']]]
    for (const invalid of [
      null,
      {},
      'broken',
      [null],
      [{}],
      [{ glyph: 1, label: 'bad' }],
      [{ glyph: '●', label: 'bad', color: {} }]
    ]) {
      const decoded = decodeJourneyFrames({
        ...FRAME,
        frames: [{ grid }],
        legend: valid,
        categories: valid,
        [field]: invalid
      })
      expect(decoded?.[field]).toEqual([])
      expect(decoded?.frames[0]?.grid).toEqual(grid)
      expect(decoded?.[field === 'legend' ? 'categories' : 'legend']).toEqual(valid)
      expect(journeyRows(decoded)).toHaveLength(3)
    }
  })
  test('still rejects invalid required data while visuals degrade independently', () => {
    for (const patch of [{ count: '2' }, { axis: null }, { summary: [3] }, { buckets: [null] }]) {
      expect(decodeJourneyFrames({ ...FRAME, frames: null, ...patch })).toBeUndefined()
    }
  })
})
