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
})
