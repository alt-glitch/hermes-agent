import { describe, expect, test } from 'vitest'

import { createSessionStore, type SessionStore } from '../logic/store.ts'
import { StatusBar } from '../view/statusBar.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame, renderProbe } from './lib/render.ts'

function bar(store: SessionStore) {
  return () => (
    <ThemeProvider theme={() => store.state.theme}>
      <StatusBar store={store} />
    </ThemeProvider>
  )
}

describe('voice/browser status chrome', () => {
  test('renders exact-f7 voice labels and updates live', async () => {
    const store = createSessionStore()
    store.applyInfo({ model: 'test-model' })
    const probe = await renderProbe(bar(store), { width: 220, height: 3 })
    try {
      expect(probe.frame()).toContain('voice off')
      store.setVoiceMode({ enabled: true, tts: true })
      await probe.settle()
      expect(probe.frame()).toContain('voice on [tts]')
      store.apply({ type: 'voice.status', payload: { state: 'listening' } })
      await probe.settle()
      expect(probe.frame()).toContain('● REC')
      expect(probe.frame()).not.toContain('voice on')
      store.apply({ type: 'voice.status', payload: { state: 'transcribing' } })
      await probe.settle()
      expect(probe.frame()).toContain('◉ STT')
    } finally {
      probe.destroy()
    }
  })

  test('voice and browser chips drop whole at their responsive breakpoints', async () => {
    const store = createSessionStore()
    store.applyInfo({ model: 'm' })
    store.setVoiceMode({ enabled: true })
    store.setBrowserState({ connected: true })
    expect(await captureFrame(bar(store), { width: 120, height: 3 })).toContain('browser')
    const medium = await captureFrame(bar(store), { width: 100, height: 3 })
    expect(medium).toContain('voice on')
    expect(medium).not.toContain('browser')
    const narrow = await captureFrame(bar(store), { width: 83, height: 3 })
    expect(narrow).not.toContain('voice on')
    expect(narrow.split('\n').filter(row => row.trim())).toHaveLength(1)
  })
})
