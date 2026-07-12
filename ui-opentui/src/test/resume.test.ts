/**
 * Resume mapper test (spec §1 lifecycle; gotcha §8 #5). The `session.resume`
 * history maps into the store's Message[], folding tool rows ({name,context},
 * NO text) into the preceding assistant turn's ordered parts so they render.
 */
import { describe, expect, test } from 'vitest'

import { mapResumeHistory } from '../logic/resume.ts'

describe('mapResumeHistory (Phase 4b)', () => {
  test('maps user/assistant text + folds tool rows into the preceding assistant parts', () => {
    const msgs = mapResumeHistory([
      { role: 'user', text: 'list files' },
      { role: 'assistant', text: 'Listing.' },
      { role: 'tool', name: 'terminal', context: 'ls -la' },
      { role: 'assistant', text: 'Done.' }
    ])
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'list files' })

    const a1 = msgs[1]!
    expect(a1.parts?.map(p => p.type)).toEqual(['text', 'tool']) // text + folded tool, inline
    const tool = a1.parts![1]!
    if (tool.type === 'tool') {
      // context → argsPreview (same field as a live tool part, so it renders identically)
      expect(tool).toMatchObject({ name: 'terminal', state: 'complete', argsPreview: 'ls -la' })
    } else {
      throw new Error('expected a folded tool part')
    }
    expect(msgs[2]).toMatchObject({ role: 'assistant', text: 'Done.' })
  })

  test('a tool row with no preceding assistant gets a standalone assistant holder', () => {
    const msgs = mapResumeHistory([{ role: 'tool', name: 'read_file', context: 'foo.ts' }])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.role).toBe('assistant')
    expect(msgs[0]!.parts?.[0]).toMatchObject({ type: 'tool', name: 'read_file', argsPreview: 'foo.ts' })
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
      }
    ])
    const tool = msgs[0]!.parts![1]!
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
    expect(msgs.map(message => message.text)).toEqual(['deploy it', '', 'Done.'])
    const tool = msgs[1]?.parts?.[0]
    expect(tool).toMatchObject({ name: 'terminal', resultText: 'all passed', state: 'complete', type: 'tool' })
    if (tool?.type !== 'tool') throw new Error('expected correlated tool part')
    expect(tool.argsText).toContain('npm test')
  })

  test('ignores non-arrays and unknown roles', () => {
    expect(mapResumeHistory(null)).toEqual([])
    expect(mapResumeHistory([{ role: 'weird', text: 'x' }])).toEqual([])
  })
})
