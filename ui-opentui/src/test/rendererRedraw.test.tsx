import type { KeyEvent } from '@opentui/core'
import { expect, test, vi } from 'vitest'

import { redrawRenderer } from '../boundary/renderer.ts'
import { isRedrawHotkey } from '../logic/hotkeys.ts'
import { renderProbe } from './lib/render.ts'

test('redraw preserves later key bytes from the same stdin chunk and clears selection', async () => {
  const probe = await renderProbe(() => <text>ready</text>)
  const seen: string[] = []
  const writes: string[] = []
  const clearSelection = vi.spyOn(probe.renderer, 'clearSelection')
  const output = {
    write: (chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }
  } as unknown as Pick<NodeJS.WriteStream, 'write'>

  const onKey = (event: KeyEvent) => {
    seen.push(event.name)
    if (isRedrawHotkey(event, 'linux')) redrawRenderer(probe.renderer, { clearSelection: true, output })
  }
  probe.renderer.keyInput.on('keypress', onKey)

  try {
    // Ctrl+L (0x0c) and X intentionally arrive in ONE parser chunk. The former
    // suspend/resume repaint reset the parser here and silently dropped X.
    probe.renderer.stdin.emit('data', Buffer.from('\u000cX'))
    await probe.settle()

    expect(seen).toEqual(expect.arrayContaining(['l', 'x']))
    expect(clearSelection).toHaveBeenCalledOnce()
    expect(writes).toContain('\u001b[2J\u001b[H')
  } finally {
    probe.renderer.keyInput.off('keypress', onKey)
    clearSelection.mockRestore()
    probe.destroy()
  }
})
