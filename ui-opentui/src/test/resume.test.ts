/**
 * Resume mapper test (spec §1 lifecycle; gotcha §8 #5). The `session.resume`
 * history maps into the store's Message[], buffering tool rows ({name,context},
 * NO text) onto the following assistant turn, matching the exact Ink mapper.
 */
import { describe, expect, test } from 'vitest'

import { mapResumeHistory } from '../logic/resume.ts'

describe('mapResumeHistory (Phase 4b)', () => {
  test('attaches a tool-before-final trail to the following assistant answer', () => {
    const msgs = mapResumeHistory([
      { role: 'user', text: 'list files' },
      { role: 'assistant', text: 'Listing.' },
      { role: 'tool', name: 'terminal', context: 'ls -la' },
      { role: 'assistant', text: 'Done.' }
    ])
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'list files' })

    const a1 = msgs[1]!
    expect(a1.parts?.map(p => p.type)).toEqual(['text'])
    const final = msgs[2]!
    expect(final.parts?.map(p => p.type)).toEqual(['tool', 'text'])
    const tool = final.parts![0]!
    if (tool.type === 'tool') {
      // context → argsPreview (same field as a live tool part, so it renders identically)
      expect(tool).toMatchObject({ name: 'terminal', state: 'complete', argsPreview: 'ls -la' })
    } else {
      throw new Error('expected a folded tool part')
    }
    expect(final).toMatchObject({ role: 'assistant', text: 'Done.' })
  })

  test('an ordinary assistant → tool → assistant sequence keeps one row per real assistant', () => {
    const msgs = mapResumeHistory([
      { role: 'assistant', text: 'I will inspect it.' },
      { role: 'tool', name: 'read_file', context: 'foo.ts' },
      { role: 'assistant', text: 'The file is valid.' }
    ])

    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.parts?.map(part => part.type)).toEqual(['text'])
    expect(msgs[1]?.parts?.map(part => part.type)).toEqual(['tool', 'text'])
  })

  test('folds result_text + args so resumed tools render collapsible like live (item 1)', () => {
    const msgs = mapResumeHistory([
      { role: 'assistant', text: 'Running.' },
      {
        role: 'tool',
        name: 'terminal',
        context: 'ls /usr/bin',
        args: { command: 'ls /usr/bin' },
        result_text: '[showing verbose tail; omitted 90 chars]\n{"output":"a\\nb\\nc","exit_code":0}'
      },
      { role: 'assistant', text: 'Done.' }
    ])
    const tool = msgs[1]!.parts![0]!
    if (tool.type !== 'tool') throw new Error('expected a folded tool part')
    expect(tool.argsPreview).toBe('ls /usr/bin')
    expect(tool.resultText).toBe('a\nb\nc') // label peeled + envelope stripped → collapsible
    expect(tool.lineCount).toBe(3)
    expect(tool.omittedNote).toBe('90 chars')
    expect(tool.argsText).toContain('"command"')
  })

  test('maps raw gateway content and correlates OpenAI tool calls with tool results', () => {
    const msgs = mapResumeHistory([
      { role: 'user', content: 'deploy it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', function: { name: 'terminal', arguments: '{"command":"npm test"}' } }]
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'all passed' },
      { role: 'assistant', content: 'Done.' }
    ])
    expect(msgs.map(message => message.text)).toEqual(['deploy it', 'Done.'])
    const tool = msgs[1]?.parts?.[0]
    expect(tool).toMatchObject({ name: 'terminal', resultText: 'all passed', state: 'complete', type: 'tool' })
    if (tool?.type !== 'tool') throw new Error('expected correlated tool part')
    expect(tool.argsText).toContain('npm test')
  })

  test('drops malformed leading, cross-boundary, and dangling tool trails without synthetic rows', () => {
    const msgs = mapResumeHistory([
      { role: 'tool', name: 'orphan-leading', context: 'a' },
      { role: 'user', text: 'new turn' },
      { role: 'tool', name: 'orphan-cross-boundary', context: 'b' },
      { role: 'system', text: 'boundary' },
      { role: 'assistant', text: 'real answer' },
      { role: 'tool', name: 'orphan-dangling', context: 'c' }
    ])

    expect(msgs.map(message => [message.role, message.text])).toEqual([
      ['user', 'new turn'],
      ['system', 'boundary'],
      ['assistant', 'real answer']
    ])
    expect(msgs[2]?.parts?.map(part => part.type)).toEqual(['text'])
  })

  test('never duplicates a buffered tool across assistant rows', () => {
    const msgs = mapResumeHistory([
      { role: 'assistant', text: 'before' },
      { role: 'tool', name: 'terminal', context: 'pwd' },
      { role: 'assistant', text: 'after' },
      { role: 'assistant', text: 'later' }
    ])
    const tools = msgs.flatMap(message => message.parts ?? []).filter(part => part.type === 'tool')

    expect(tools).toHaveLength(1)
    expect(msgs[0]?.parts?.map(part => part.type)).toEqual(['text'])
    expect(msgs[1]?.parts?.map(part => part.type)).toEqual(['tool', 'text'])
    expect(msgs[2]?.parts?.map(part => part.type)).toEqual(['text'])
  })

  test('ignores non-arrays and unknown roles', () => {
    expect(mapResumeHistory(null)).toEqual([])
    expect(mapResumeHistory([{ role: 'weird', text: 'x' }])).toEqual([])
  })

  test('maps persisted async delegation disclosure metadata', () => {
    const detail = '[ASYNC DELEGATION BATCH COMPLETE — deleg_resume]\nFULL_SENTINEL'
    const [message] = mapResumeHistory([
      {
        role: 'notification',
        text: 'deleg_resume · 2 agents · all done · 2s',
        notification: {
          id: 'deleg:deleg_resume',
          kind: 'async delegation',
          level: 'success',
          text: 'deleg_resume · 2 agents · all done · 2s',
          detail,
          always_visible: true
        }
      }
    ])

    expect(message?.role).toBe('notification')
    expect(message?.notification?.detail).toBe(detail)
    expect(message?.notification?.alwaysVisible).toBe(true)
  })

  test('skips hidden persisted display rows without changing ordinary history', () => {
    const msgs = mapResumeHistory([
      { role: 'user', text: 'real question' },
      { role: 'user', text: '[CONTEXT COMPACTION — REFERENCE ONLY]', display_kind: 'hidden' },
      { role: 'assistant', text: 'real answer' }
    ])

    expect(msgs.map(message => [message.role, message.text])).toEqual([
      ['user', 'real question'],
      ['assistant', 'real answer']
    ])
  })

  test('maps delegation completions to dim system markers with robust count fallback', () => {
    const msgs = mapResumeHistory([
      {
        role: 'user',
        text: '[IMPORTANT: internal delegation prompt]',
        display_kind: 'async_delegation_complete',
        display_metadata: { task_count: 3 },
        timestamp: 1_753_300_000
      },
      {
        role: 'user',
        text: '[IMPORTANT: internal single delegation prompt]',
        display_kind: 'async_delegation_complete',
        display_metadata: { task_count: 1 }
      },
      {
        role: 'user',
        text: '[IMPORTANT: malformed delegation prompt]',
        display_kind: 'async_delegation_complete',
        display_metadata: { task_count: 'many' }
      },
      {
        role: 'user',
        text: '[IMPORTANT: missing delegation metadata]',
        display_kind: 'async_delegation_complete'
      }
    ])

    expect(msgs).toEqual([
      { role: 'system', text: '◈ 3 background agents finished', timestamp: 1_753_300_000 },
      { role: 'system', text: '◈ 1 background agent finished' },
      { role: 'system', text: '◈ background agent work finished' },
      { role: 'system', text: '◈ background agent work finished' }
    ])
  })

  test('keeps model-switch bookkeeping hidden instead of resurrecting a user bubble', () => {
    const msgs = mapResumeHistory([
      { role: 'user', text: 'before' },
      { role: 'user', text: '[System: model changed to gpt-5]', display_kind: 'model_switch' },
      { role: 'assistant', text: 'after' }
    ])

    expect(msgs.map(message => [message.role, message.text])).toEqual([
      ['user', 'before'],
      ['assistant', 'after']
    ])
  })
})
