import { describe, expect, test } from 'vitest'

import { createPasteStore } from '../logic/pastes.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

describe('collapsed paste slash submission', () => {
  test('expands the paste body before the slash router receives it', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const pasteStore = createPasteStore()
    const submitted: string[] = []
    const body = 'first line\n  second line\n\tthird line\nfourth line'

    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App
            store={store}
            pasteStore={pasteStore}
            onSubmit={text => {
              submitted.push(text)
            }}
          />
        </ThemeProvider>
      ),
      { height: 24, kittyKeyboard: true, width: 80 }
    )

    try {
      const token = pasteStore.add(body)
      if (token === undefined) throw new Error('paste fixture unexpectedly exceeded its store ceiling')
      store.replaceComposerDraft(`/goal ${token}`)
      await probe.settle()
      expect(probe.frame()).toContain(token)
      probe.keys.pressEnter()
      await probe.settle()
      expect(submitted).toEqual([`/goal ${body}`])
    } finally {
      probe.destroy()
    }
  })
})
