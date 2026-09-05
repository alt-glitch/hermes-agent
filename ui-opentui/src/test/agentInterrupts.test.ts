import { describe, expect, test, vi } from 'vitest'

import { createAgentInterrupts } from '../boundary/agentInterrupts.ts'

describe('agent interrupt boundary', () => {
  test('decodes success, missing agents and malformed results', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ found: true, subagent_id: 'live' })
      .mockResolvedValueOnce({ found: false, subagent_id: 'dead' })
      .mockResolvedValueOnce({ found: 'yes' })
    const controls = createAgentInterrupts(request)
    await expect(controls.interrupt('live')).resolves.toBe('killing live')
    await expect(controls.interrupt('dead')).resolves.toBe('not found: dead')
    await expect(controls.interrupt('bad')).rejects.toThrow('invalid interrupt response')
  })

  test('partial failure waits for every in-flight child and never duplicates IDs', async () => {
    let release: (value: unknown) => void = () => {}
    const request = vi.fn((id: string) => {
      if (id === 'slow')
        return new Promise(resolve => {
          release = resolve
        })
      if (id === 'failed') return Promise.reject(new Error('disconnected'))
      return Promise.resolve({ found: false, subagent_id: id })
    })
    const result = createAgentInterrupts(request).interruptSubtree(['slow', 'failed', 'dead', 'slow'])
    const settled = vi.fn()
    void result.then(settled, settled)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(3)
    release({ found: true, subagent_id: 'slow' })
    await expect(result).rejects.toThrow('1 stop requested · 1 already finished/not found · 1 failed')
  })
})
