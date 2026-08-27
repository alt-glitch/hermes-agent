/**
 * Widget dock frame tests — the ambient dock paints registered cards (plain
 * text/box chrome paints headlessly), renders nothing when empty, stays
 * BOUNDED (≤ DOCK_MAX_ROWS reserved rows — an oversized widget clips instead
 * of eating the screen), placement routes to the right dock, and a crashing
 * render degrades to the ⚠ chip without touching siblings.
 */
import { describe, expect, test, vi } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { DOCK_MAX_ROWS, WidgetDock } from '../widgets/dock.tsx'
import { h, Text } from '../widgets/element.ts'
import { disposeAllWidgets, launchWidget } from '../widgets/host.ts'
import { defineWidgetApp, listWidgetApps, removeWidgetApp } from '../widgets/registry.ts'
import type { AmbientZone } from '../widgets/types.ts'
import { renderProbe } from './lib/render.ts'

const theme = () => createSessionStore().state.theme

function registerCard(id: string, lines: string[], zone?: AmbientZone): void {
  defineWidgetApp<{ lines: string[] }>({
    help: `${id} help`,
    id,
    init: () => ({ lines }),
    mode: 'ambient',
    reduce: s => s,
    render: c => c.state.lines.map(line => h(Text, null, line)),
    ...(zone !== undefined ? { zone } : {})
  })
}

function cleanup(): void {
  disposeAllWidgets()
  for (const app of listWidgetApps()) removeWidgetApp(app.id)
}

describe('WidgetDock frames', () => {
  test('renders nothing while no widget is docked, and the card once launched', async () => {
    cleanup()
    registerCard('dockcard', ['WIDGETCARD-LIVE'])
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={theme}>
          <WidgetDock placement="dock-bottom" />
        </ThemeProvider>
      ),
      { width: 60, height: 12 }
    )
    try {
      expect(probe.frame()).not.toContain('WIDGETCARD-LIVE')
      launchWidget('dockcard')
      await probe.settle()
      expect(probe.frame()).toContain('WIDGETCARD-LIVE')
      launchWidget('dockcard') // toggle away
      await probe.settle()
      expect(probe.frame()).not.toContain('WIDGETCARD-LIVE')
    } finally {
      probe.destroy()
      cleanup()
    }
  })

  test('the dock is BOUNDED: an oversized widget clips at DOCK_MAX_ROWS', async () => {
    cleanup()
    registerCard(
      'tall',
      Array.from({ length: 12 }, (_, i) => `ROW-${String(i + 1).padStart(2, '0')}`)
    )
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={theme}>
          <WidgetDock placement="dock-bottom" />
        </ThemeProvider>
      ),
      { width: 60, height: 20 }
    )
    try {
      launchWidget('tall')
      await probe.settle()
      const frame = probe.frame()
      expect(frame).toContain('ROW-01')
      expect(frame).toContain(`ROW-${String(DOCK_MAX_ROWS).padStart(2, '0')}`)
      expect(frame).not.toContain(`ROW-${String(DOCK_MAX_ROWS + 1).padStart(2, '0')}`)
    } finally {
      probe.destroy()
      cleanup()
    }
  })

  test('zones route to their dock; rail corners map to the nearest dock', async () => {
    cleanup()
    registerCard('north', ['NORTH-CARD'], 'top-right')
    registerCard('south', ['SOUTH-CARD'])
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={theme}>
          <WidgetDock placement="dock-top" />
        </ThemeProvider>
      ),
      { width: 60, height: 12 }
    )
    try {
      launchWidget('north')
      launchWidget('south')
      await probe.settle()
      const frame = probe.frame()
      expect(frame).toContain('NORTH-CARD') // top-right → dock-top
      expect(frame).not.toContain('SOUTH-CARD') // default dock-bottom stays out of this dock
    } finally {
      probe.destroy()
      cleanup()
    }
  })

  test('a crashing render shows the ⚠ chip for THAT widget; siblings keep painting', async () => {
    cleanup()
    registerCard('healthy', ['HEALTHY-CARD'])
    defineWidgetApp({
      help: 'boom',
      id: 'boom',
      init: () => ({}),
      mode: 'ambient',
      reduce: (s: never) => s,
      render: () => {
        throw new Error('paint exploded')
      }
    })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={theme}>
          <WidgetDock placement="dock-bottom" />
        </ThemeProvider>
      ),
      { width: 70, height: 12 }
    )
    try {
      launchWidget('healthy')
      launchWidget('boom')
      await probe.settle()
      const frame = probe.frame()
      expect(frame).toContain('HEALTHY-CARD')
      expect(frame).toContain('⚠')
      expect(frame).toContain('paint exploded')
    } finally {
      probe.destroy()
      cleanup()
    }
  })

  test('a modal widget replaces the composer, owns keys, and its reducer closes it', async () => {
    cleanup()
    defineWidgetApp<{ n: number }>({
      help: 'modal demo',
      id: 'modaldemo',
      init: () => ({ n: 0 }),
      mode: 'modal',
      reduce: (s, { ch, key }) => (key.escape || ch === 'q' ? null : ch === '+' ? { n: s.n + 1 } : s),
      render: c => h(Text, null, `MODAL-N=${c.state.n}`)
    })
    const store = createSessionStore()
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { width: 80, height: 26 }
    )
    try {
      launchWidget('modaldemo')
      await probe.settle()
      expect(probe.frame()).toContain('MODAL-N=0')
      await probe.keys.typeText('+')
      await probe.settle()
      expect(probe.frame()).toContain('MODAL-N=1')
      await probe.keys.typeText('q')
      await probe.settle()
      expect(probe.frame()).not.toContain('MODAL-N')
    } finally {
      probe.destroy()
      cleanup()
    }
  })

  test('in the full App the dock sits above the status bar and the composer stays usable', async () => {
    cleanup()
    registerCard('appdock', ['APPDOCK-CARD'])
    const store = createSessionStore()
    const typed: string[] = []
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={theme}>
          <App store={store} onType={text => typed.push(text)} />
        </ThemeProvider>
      ),
      { width: 80, height: 26 }
    )
    try {
      launchWidget('appdock')
      await probe.settle()
      const frame = probe.frame()
      expect(frame).toContain('APPDOCK-CARD')
      // the card renders ABOVE the status bar / composer region
      const lines = frame.split('\n')
      const cardRow = lines.findIndex(line => line.includes('APPDOCK-CARD'))
      const composerRow = lines.findIndex(line => line.includes('❯') || line.includes('>'))
      expect(cardRow).toBeGreaterThanOrEqual(0)
      if (composerRow >= 0) expect(cardRow).toBeLessThan(composerRow)
      // ambient widgets capture no input: typing still reaches the composer
      await probe.keys.typeText('hello dock')
      await probe.settle()
      expect(probe.frame()).toContain('hello dock')
    } finally {
      probe.destroy()
      cleanup()
      vi.restoreAllMocks()
    }
  })
})
