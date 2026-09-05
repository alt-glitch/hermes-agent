import { Option, Schema } from 'effect'
import { describe, expect, test, vi } from 'vitest'

import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import { createSessionStore, type SessionStore } from '../logic/store.ts'
import { SUBAGENT_SUMMARY_LIMIT, SUBAGENT_TRACE_LIMIT, SUBAGENT_TRACE_TEXT_LIMIT } from '../logic/subagentTrace.ts'

function start(store: SessionStore, id = 'a') {
  store.apply({ type: 'subagent.start', payload: { subagent_id: id, goal: `Full task ${id}` } })
  const agent = store.state.subagents.find(item => item.id === id)
  if (agent === undefined) throw new Error('started agent is missing')
  return agent
}

function text(store: SessionStore, value: string, id = 'a'): void {
  store.apply({ type: 'subagent.text', payload: { subagent_id: id, text: value } })
}

describe('agent message retention and completion', () => {
  test('supplied reasoning is decoded and ordered separately from activity and reply text', () => {
    const store = createSessionStore()
    const agent = start(store)
    for (const chunk of ['Compare ', 'the two cases.']) {
      const event = Schema.decodeUnknownOption(GatewayEventSchema)({
        type: 'subagent.reasoning',
        payload: { subagent_id: 'a', text: chunk }
      })
      expect(Option.isSome(event)).toBe(true)
      if (Option.isSome(event)) store.apply(event.value)
    }
    store.apply({ type: 'subagent.thinking', payload: { subagent_id: 'a', text: 'working...' } })
    text(store, 'The cases differ.')
    expect(agent.trace?.slice(1).map(entry => [entry.kind, entry.text])).toEqual([
      ['reasoning', 'Compare the two cases.'],
      ['reply', 'The cases differ.']
    ])
    expect(agent.thought).toBe('working...')
  })
  test('interleaved siblings retain stable independent messages and whitespace', () => {
    const store = createSessionStore()
    const a = start(store)
    const b = start(store, 'b')
    text(store, 'first')
    const first = a.trace?.at(-1)
    text(store, 'other', 'b')
    text(store, '\n\n')
    text(store, 'paragraph')
    expect(a.trace?.at(-1)).toBe(first)
    expect(first?.text).toBe('first\n\nparagraph')
    expect(b.trace?.at(-1)?.text).toBe('other')
    store.apply({ type: 'subagent.tool', payload: { subagent_id: 'a', tool_name: 'read_file' } })
    text(store, 'next')
    expect(a.trace?.at(-1)?.id).not.toBe(first?.id)
    expect(a.trace?.filter(entry => entry.kind === 'reply').map(entry => entry.text)).toEqual([
      'first\n\nparagraph',
      'next'
    ])
  })

  test('completion finishes the last streamed prefix in place, once; ignores late deltas', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const store = createSessionStore()
      const agent = start(store)
      text(store, 'Here is ')
      const reply = agent.trace?.at(-1)
      store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a', summary: 'Here is the answer.' } })
      clock.mockReturnValue(2000)
      store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a', summary: 'Here is the answer.' } })
      text(store, 'stale')
      expect(agent.trace?.at(-1)).toBe(reply)
      expect(reply?.text).toBe('Here is the answer.')
      expect(agent.trace).toHaveLength(2)
      expect(agent.endedAt).toBe(1000)
    } finally {
      clock.mockRestore()
    }
  })

  test('a shortened completion preview preserves the full last streamed reply', () => {
    const store = createSessionStore()
    const agent = start(store)
    const full = 'Verified result. '.repeat(80)
    text(store, full)
    const reply = agent.trace?.at(-1)
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a', summary: full.slice(0, 500) } })
    expect(agent.trace?.at(-1)).toBe(reply)
    expect(reply?.text).toBe(full)
    expect(agent.trace?.some(entry => entry.kind === 'summary')).toBe(false)
  })

  test('identical messages separated by a tool are not globally deduplicated', () => {
    const store = createSessionStore()
    const agent = start(store)
    text(store, 'Checking.')
    store.apply({ type: 'subagent.tool', payload: { subagent_id: 'a', tool_name: 'read_file' } })
    text(store, 'Checking.')
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a', summary: 'Checking.' } })
    expect(agent.trace?.filter(entry => entry.kind === 'reply').map(entry => entry.text)).toEqual([
      'Checking.',
      'Checking.'
    ])
  })

  test('summary-only and different final responses remain available', () => {
    const store = createSessionStore()
    const a = start(store)
    const b = start(store, 'b')
    text(store, 'Preliminary result')
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a', summary: 'Final result' } })
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'b', summary: 'Legacy result' } })
    expect(a.trace?.slice(-2).map(entry => entry.text)).toEqual(['Preliminary result', 'Final result'])
    expect(b.trace?.at(-1)?.text).toBe('Legacy result')
  })

  test('empty failure completion never fabricates an assistant reply', () => {
    const store = createSessionStore()
    const agent = start(store)
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a', status: 'failed' } })
    expect(agent.status).toBe('failed')
    expect(agent.trace?.some(entry => entry.kind === 'summary' || entry.kind === 'reply')).toBe(false)
  })

  test('a huge reply stays bounded after repeated appends, with explicit loss and stable identity', () => {
    const store = createSessionStore()
    const agent = start(store)
    text(store, 'x'.repeat(SUBAGENT_TRACE_TEXT_LIMIT * 2))
    const reply = agent.trace?.at(-1)
    text(store, 'LATEST')
    expect(agent.trace?.at(-1)).toBe(reply)
    expect(reply?.text).toHaveLength(SUBAGENT_TRACE_TEXT_LIMIT)
    expect(reply?.text.endsWith('LATEST')).toBe(true)
    expect(reply?.truncated).toBe(true)
    expect(agent.traceTruncated).toBe(true)
    expect(agent.traceDropped).toBe(1)
    store.apply({
      type: 'subagent.complete',
      payload: { subagent_id: 'a', summary: 's'.repeat(SUBAGENT_TRACE_TEXT_LIMIT * 2) }
    })
    expect(agent.summary).toHaveLength(SUBAGENT_SUMMARY_LIMIT)
    expect(agent.trace?.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(
      SUBAGENT_TRACE_TEXT_LIMIT
    )
  })

  test('retention never splits a supplementary Unicode character', () => {
    const store = createSessionStore()
    const agent = start(store)
    text(store, '😀' + 'x'.repeat(SUBAGENT_TRACE_TEXT_LIMIT - 1))
    expect(agent.trace?.at(-1)?.text.isWellFormed()).toBe(true)
    expect(agent.trace?.at(-1)?.text.length).toBeLessThanOrEqual(SUBAGENT_TRACE_TEXT_LIMIT)
    expect(agent.trace).toHaveLength(1)
    store.apply({
      type: 'subagent.complete',
      payload: { subagent_id: 'a', summary: '😀' + 'y'.repeat(SUBAGENT_SUMMARY_LIMIT - 1) }
    })
    expect(agent.summary?.isWellFormed()).toBe(true)
    expect(agent.summary?.length).toBeLessThanOrEqual(SUBAGENT_SUMMARY_LIMIT)
  })

  test('entry trimming preserves monotonic IDs and is disclosed in immutable archives', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    const agent = start(store)
    for (let index = 0; index < SUBAGENT_TRACE_LIMIT + 5; index += 1) {
      store.apply({ type: 'subagent.progress', payload: { subagent_id: 'a', text: `step ${String(index)}` } })
    }
    const ids = agent.trace?.map(entry => entry.id) ?? []
    expect(ids).toHaveLength(SUBAGENT_TRACE_LIMIT)
    expect(new Set(ids).size).toBe(ids.length)
    expect(agent.traceDropped).toBe(6)
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a', summary: 'done' } })
    store.apply({ type: 'message.complete', payload: { text: 'parent done' } })
    const archived = store.state.spawnHistory.snapshots[0]?.subagents[0]
    expect(archived?.['traceTruncated']).toBe(true)
    expect(archived?.['traceDropped']).toBe(7)
    store.apply({ type: 'message.start' })
    start(store)
    text(store, 'new session body')
    expect(archived?.['traceDropped']).toBe(7)
    expect(JSON.stringify(archived)).not.toContain('new session body')
  })

  test('optional short task label survives decoding without changing the full goal', () => {
    const decoded = Schema.decodeUnknownOption(GatewayEventSchema)({
      type: 'subagent.start',
      payload: { subagent_id: 'a', goal: 'Full detailed instructions', task_label: 'Audit API' }
    })
    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isNone(decoded)) return
    const store = createSessionStore()
    store.apply(decoded.value)
    expect(store.state.subagents[0]).toMatchObject({ taskLabel: 'Audit API', goal: 'Full detailed instructions' })
    store.clearTranscript()
    text(store, 'late')
    expect(store.state.subagents).toEqual([])
  })
})
