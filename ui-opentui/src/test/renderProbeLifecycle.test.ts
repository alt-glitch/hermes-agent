import { describe, expect, test, vi } from 'vitest'

const setup = vi.hoisted(() => ({
  renderer: { destroy: vi.fn() },
  renderOnce: vi.fn<() => Promise<void>>(),
  flush: vi.fn<() => Promise<void>>(),
  waitForVisualIdle: vi.fn<() => Promise<void>>()
}))
vi.mock('@opentui/solid', () => ({ testRender: async () => setup, useRenderer: vi.fn() }))
vi.mock('../boundary/ffiSafe.ts', () => ({ installFfiCoordSafety: vi.fn() }))
vi.mock('../boundary/multiClickSelect.ts', () => ({ installMultiClickSelection: vi.fn() }))

import { renderProbe } from './lib/render.ts'

describe('renderProbe initialization ownership', () => {
  test.each(['renderOnce', 'flush', 'waitForVisualIdle'] as const)(
    'destroys the acquired renderer when %s rejects',
    async failing => {
      vi.clearAllMocks()
      setup.renderOnce.mockResolvedValue()
      setup.flush.mockResolvedValue()
      setup.waitForVisualIdle.mockResolvedValue()
      const failure = new Error(`failed ${failing}`)
      setup[failing].mockRejectedValueOnce(failure)
      await expect(renderProbe(() => undefined)).rejects.toBe(failure)
      expect(setup.renderer.destroy).toHaveBeenCalledExactlyOnceWith()
    }
  )
})
