import { describe, expect, test } from 'vitest'

import { mapResumeHistory } from '../logic/resume.ts'
import { createSessionStore, type ToolPartState } from '../logic/store.ts'
import { stripToolEnvelope } from '../logic/toolOutput.ts'
import { ThemeProvider } from '../view/theme.tsx'
import { BashToolBody, bashRenderer } from '../view/tools/bashTool.tsx'
import { renderProbe } from './lib/render.ts'

type Store = ReturnType<typeof createSessionStore>

const yieldedResult = {
  output: '',
  exit_code: null,
  error: null,
  status: 'yielded_to_background',
  session_id: 'proc_yielded',
  pid: 1234,
  notify_on_complete: true,
  note: 'The command was handed off and is still running.'
}

function toolPart(store: Store): ToolPartState | undefined {
  return store.state.messages.flatMap(message => message.parts ?? []).find(part => part.type === 'tool')
}

describe('yielded terminal result display', () => {
  test('normalizes yielded and completed output without reordering handoff metadata', () => {
    const cases = [
      {
        result: yieldedResult,
        expected: '[moved to background · proc_yielded · PID 1234]'
      },
      {
        result: { ...yieldedResult, output: 'ordinary output' },
        expected: 'ordinary output\n[moved to background · proc_yielded · PID 1234]'
      },
      { result: { output: '', exit_code: 0 }, expected: '' },
      { result: { output: 'ordinary output', exit_code: 0 }, expected: 'ordinary output' }
    ]
    for (const { result, expected } of cases) expect(stripToolEnvelope(JSON.stringify(result))).toBe(expected)
  })

  test('live and resumed silent handoffs render the same metadata through native bash primitives', async () => {
    const wire = JSON.stringify(yieldedResult)
    const live = createSessionStore()
    live.apply({ type: 'message.start' })
    live.apply({ type: 'tool.start', payload: { tool_id: 'call-yield', name: 'terminal', context: 'sleep 60' } })
    live.apply({
      type: 'tool.complete',
      payload: { tool_id: 'call-yield', name: 'terminal', args: { command: 'sleep 60' }, result: yieldedResult }
    })
    live.apply({ type: 'message.complete', payload: { text: 'Addressing the correction.' } })

    const resumed = createSessionStore()
    resumed.commitSnapshot(
      mapResumeHistory([
        { role: 'user', content: 'run the command' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-yield', function: { name: 'terminal', arguments: '{"command":"sleep 60"}' } }]
        },
        { role: 'tool', tool_call_id: 'call-yield', content: wire },
        { role: 'assistant', content: 'Addressing the correction.' }
      ])
    )

    for (const store of [live, resumed]) {
      const part = toolPart(store)
      expect(part).toMatchObject({
        state: 'complete',
        resultText: '[moved to background · proc_yielded · PID 1234]'
      })
      if (!part) throw new Error('expected terminal tool part')
      expect(bashRenderer.expandable(part)).toBe(true)
      const probe = await renderProbe(
        () => (
          <ThemeProvider>
            <BashToolBody part={part} width={90} />
          </ThemeProvider>
        ),
        { width: 100, height: 8 }
      )
      try {
        const frame = await probe.waitForFrame(value => value.includes('moved to background'))
        expect(frame).toContain('[moved to background · proc_yielded · PID 1234]')
      } finally {
        probe.destroy()
      }
    }
  })
})
