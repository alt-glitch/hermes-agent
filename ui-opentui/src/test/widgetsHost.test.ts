/**
 * Widget host behavior — registry catalog rules, launch/toggle/close,
 * modal input dispatch, late-update guards, per-widget failure isolation.
 */
import { afterEach, describe, expect, test } from 'vitest'

import {
  ambientWidgets,
  closeWidget,
  disposeAllWidgets,
  dispatchWidgetInput,
  launchWidget,
  modalWidget,
  registerWidgetNotifier,
  updateWidget,
  widgetInstanceFor
} from '../widgets/host.ts'
import { defineWidgetApp, getWidgetApp, listWidgetApps, removeWidgetApp } from '../widgets/registry.ts'
import { h, Text } from '../widgets/element.ts'
import type { WidgetApp, WidgetInput } from '../widgets/types.ts'

const KEY = {
  backspace: false,
  ctrl: false,
  delete: false,
  downArrow: false,
  escape: false,
  leftArrow: false,
  meta: false,
  pageDown: false,
  pageUp: false,
  return: false,
  rightArrow: false,
  shift: false,
  tab: false,
  upArrow: false
}

const key = (over: Partial<typeof KEY> = {}): WidgetInput => ({ ch: '', key: { ...KEY, ...over } })

function ambientApp(id: string, over: Partial<WidgetApp<{ label: string }>> = {}): WidgetApp<{ label: string }> {
  return defineWidgetApp<{ label: string }>({
    help: `${id} help`,
    id,
    init: arg => ({ label: arg || 'default' }),
    mode: 'ambient',
    reduce: s => s,
    render: c => h(Text, null, c.state.label),
    ...over
  })
}

afterEach(() => {
  disposeAllWidgets()
  for (const app of listWidgetApps()) removeWidgetApp(app.id)
  registerWidgetNotifier(() => {})
})

describe('registry', () => {
  test('defineWidgetApp registers; a duplicate id is last-writer-wins', () => {
    ambientApp('dup')
    expect(getWidgetApp('dup')?.help).toBe('dup help')
    defineWidgetApp({ ...ambientApp('dup'), help: 'shadowed' })
    expect(getWidgetApp('dup')?.help).toBe('shadowed')
    expect(listWidgetApps().filter(app => app.id === 'dup')).toHaveLength(1)
  })

  test('removeWidgetApp unregisters and reports whether it existed', () => {
    ambientApp('gone')
    expect(removeWidgetApp('gone')).toBe(true)
    expect(removeWidgetApp('gone')).toBe(false)
    expect(getWidgetApp('gone')).toBeUndefined()
  })
})

describe('launch / toggle', () => {
  test('unknown id fails closed with a printable line', () => {
    expect(launchWidget('nope')).toBe('unknown widget app: nope')
  })

  test('init returning null refuses the launch and surfaces usage', () => {
    ambientApp('picky', { init: () => null, usage: 'usage: /picky <thing>' })
    expect(launchWidget('picky')).toBe('usage: /picky <thing>')
    expect(ambientWidgets()).toHaveLength(0)
  })

  test('a THROWING init is isolated into a printable line', () => {
    ambientApp('bomb', {
      init: () => {
        throw new Error('bad parse')
      }
    })
    expect(launchWidget('bomb')).toBe('/bomb: bad parse')
    expect(ambientWidgets()).toHaveLength(0)
  })

  test('/id opens an ambient app; /id again toggles it closed and disposes its instance', () => {
    ambientApp('clocky')
    expect(launchWidget('clocky')).toBeNull()
    expect(ambientWidgets().map(a => a.appId)).toEqual(['clocky'])
    const instance = widgetInstanceFor('clocky')
    expect(instance?.isDisposed()).toBe(false)
    expect(launchWidget('clocky')).toBeNull()
    expect(ambientWidgets()).toHaveLength(0)
    expect(instance?.isDisposed()).toBe(true)
  })

  test('relaunching WITH an argument re-inits instead of toggling', () => {
    ambientApp('tz')
    launchWidget('tz', 'UTC')
    launchWidget('tz', 'Asia/Tokyo')
    expect(ambientWidgets()).toHaveLength(1)
    expect(ambientWidgets()[0]?.state).toEqual({ label: 'Asia/Tokyo' })
  })
})

describe('updateWidget (async state delivery)', () => {
  test('patches state while active; a late resolution cannot resurrect a closed app', () => {
    const app = ambientApp('fetchy')
    launchWidget('fetchy')
    updateWidget(app, () => ({ label: 'loaded' }))
    expect(ambientWidgets()[0]?.state).toEqual({ label: 'loaded' })
    launchWidget('fetchy') // toggle closed
    updateWidget(app, () => ({ label: 'zombie' })) // late fetch lands after close
    expect(ambientWidgets()).toHaveLength(0)
  })

  test('never clobbers a DIFFERENT app of the same mode', () => {
    const a = ambientApp('a1')
    ambientApp('b1')
    launchWidget('b1')
    updateWidget(a, () => ({ label: 'stolen' }))
    expect(ambientWidgets()[0]?.state).toEqual({ label: 'default' })
  })

  test('a throwing update fn is contained', () => {
    const app = ambientApp('thrower')
    launchWidget('thrower')
    expect(() =>
      updateWidget(app, () => {
        throw new Error('mid-flight')
      })
    ).not.toThrow()
    expect(ambientWidgets()[0]?.state).toEqual({ label: 'default' })
  })
})

describe('modal dispatch', () => {
  function modalApp(id: string, over: Partial<WidgetApp<{ n: number }>> = {}): WidgetApp<{ n: number }> {
    return defineWidgetApp<{ n: number }>({
      help: 'modal',
      id,
      init: () => ({ n: 0 }),
      mode: 'modal',
      reduce: (s, input) => (input.key.escape ? null : input.ch === '+' ? { n: s.n + 1 } : s),
      render: c => h(Text, null, `n=${c.state.n}`),
      ...over
    })
  }

  test('a modal app takes the modal slot and swallows keys via reduce', () => {
    modalApp('calc')
    launchWidget('calc')
    expect(modalWidget()?.appId).toBe('calc')
    expect(dispatchWidgetInput({ ch: '+', key: KEY })).toBe(true)
    expect(modalWidget()?.state).toEqual({ n: 1 })
    expect(dispatchWidgetInput(key())).toBe(true) // same-ref swallow, state kept
    expect(modalWidget()?.state).toEqual({ n: 1 })
  })

  test('reduce returning null closes the app; dispatch reports inactive after', () => {
    modalApp('closeme')
    launchWidget('closeme')
    expect(dispatchWidgetInput(key({ escape: true }))).toBe(true)
    expect(modalWidget()).toBeUndefined()
    expect(dispatchWidgetInput(key())).toBe(false)
  })

  test('a THROWING reducer closes the app and surfaces a notice (fail closed)', () => {
    const notices: string[] = []
    registerWidgetNotifier(text => notices.push(text))
    modalApp('crashy', {
      reduce: () => {
        throw new Error('reducer exploded')
      }
    })
    launchWidget('crashy')
    expect(dispatchWidgetInput(key())).toBe(true)
    expect(modalWidget()).toBeUndefined()
    expect(notices.join('\n')).toContain('/crashy crashed and was closed: reducer exploded')
  })

  test('closeWidget clears the modal slot without touching the ambient dock', () => {
    ambientApp('dockmate')
    modalApp('front')
    launchWidget('dockmate')
    launchWidget('front')
    closeWidget()
    expect(modalWidget()).toBeUndefined()
    expect(ambientWidgets().map(a => a.appId)).toEqual(['dockmate'])
  })
})
