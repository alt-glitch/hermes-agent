import { describe, expect, test, vi } from 'vitest'

import { coordinatePromptLiveSession } from '../logic/promptLiveSession.ts'

function harness(overrides: Partial<Parameters<typeof coordinatePromptLiveSession>[0]> = {}) {
  const restored: Array<[string, string]> = []
  const submitted: string[] = []
  const notified: string[] = []
  const switched: string[] = []
  const options: Parameters<typeof coordinatePromptLiveSession>[0] = {
    create: () => Promise.resolve('live-new'),
    modelArg: 'model-a --provider provider-a',
    notify: message => notified.push(message),
    onModelSwitched: value => switched.push(value),
    owns: () => true,
    prompt: '  ship it  ',
    restore: (prompt, notice) => restored.push([prompt, notice]),
    submit: prompt => {
      submitted.push(prompt)
      return true
    },
    switchModel: () => Promise.resolve('model-a'),
    ...overrides
  }
  return { notified, options, restored, submitted, switched }
}

describe('coordinatePromptLiveSession', () => {
  test('creates, switches model, then submits trimmed authored input', async () => {
    const order: string[] = []
    const h = harness({
      create: () => {
        order.push('create')
        return Promise.resolve('live-new')
      },
      switchModel: () => {
        order.push('model')
        return Promise.resolve('model-a')
      },
      submit: prompt => {
        order.push(`submit:${prompt}`)
        return true
      }
    })
    await expect(coordinatePromptLiveSession(h.options)).resolves.toEqual({ kind: 'created', sessionId: 'live-new' })
    expect(order).toEqual(['create', 'model', 'submit:ship it'])
    expect(h.notified).toEqual(['model → model-a'])
    expect(h.switched).toEqual(['model-a'])
    expect(h.restored).toEqual([])
  })

  test.each([
    ['create', { create: () => Promise.resolve(undefined) }],
    ['model', { switchModel: () => Promise.resolve('   ') }],
    ['ownership', { owns: () => false }],
    ['submit', { submit: () => false }]
  ] as const)('restores the prompt when %s admission fails', async (reason, overrides) => {
    const h = harness(overrides)
    await expect(coordinatePromptLiveSession(h.options)).resolves.toEqual({ kind: 'restored', reason })
    expect(h.restored).toHaveLength(1)
    expect(h.restored[0]?.[0]).toBe('ship it')
    expect(h.restored[0]?.[1]).toContain('prompt restored to composer')
    if (reason === 'ownership') expect(h.switched).toEqual([])
  })

  test('restores with model error detail and never submits', async () => {
    const h = harness({ switchModel: () => Promise.reject(new Error('provider unavailable')) })
    await expect(coordinatePromptLiveSession(h.options)).resolves.toEqual({ kind: 'restored', reason: 'model' })
    expect(h.restored[0]?.[1]).toContain('provider unavailable')
    expect(h.submitted).toEqual([])
  })

  test('empty input performs no work', async () => {
    const create = vi.fn(() => Promise.resolve('live-new'))
    const h = harness({ create, prompt: '   ' })
    await expect(coordinatePromptLiveSession(h.options)).resolves.toEqual({ kind: 'empty' })
    expect(create).not.toHaveBeenCalled()
  })
})
