/**
 * Widget slash surface — /<id> dispatches off the live registry (open/toggle),
 * /widgets-reload rescans and reports, non-widget commands still fall through
 * to the gateway ladder, and widget ids merge into slash-name completion.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { completionEdit } from '../logic/completionMenu.ts'
import { clientCommandNames, dispatchSlash, parseSlash, type SlashContext } from '../logic/slash.ts'
import { mergeWidgetCompletionItems } from '../widgets/completion.ts'
import { ambientWidgets, disposeAllWidgets } from '../widgets/host.ts'
import { defineWidgetApp, listWidgetApps, removeWidgetApp } from '../widgets/registry.ts'
import { resetUserWidgetFiles } from '../widgets/userWidgets.ts'
import { h, Text } from '../widgets/element.ts'

interface Probe {
  ctx: SlashContext
  system: string[]
  requests: { method: string; params: Record<string, unknown> }[]
}

function makeCtx(request?: (method: string) => Promise<unknown>): Probe {
  const system: string[] = []
  const requests: Probe['requests'] = []
  const ctx = {
    pushSystem: (text: string) => system.push(text),
    request: (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      return request ? request(method) : Promise.reject(new Error('no gateway'))
    },
    sessionId: () => 'sid-1',
    sessionOwnerId: () => 'sid-1'
  } as unknown as SlashContext
  return { ctx, requests, system }
}

function registerAmbient(id: string, help = `${id} help`): void {
  defineWidgetApp<{ label: string }>({
    help,
    id,
    init: arg => ({ label: arg || 'x' }),
    mode: 'ambient',
    reduce: s => s,
    render: c => h(Text, null, c.state.label)
  })
}

let tempDirs: string[] = []
const savedHome = process.env.HERMES_HOME

afterEach(async () => {
  disposeAllWidgets()
  for (const app of listWidgetApps()) removeWidgetApp(app.id)
  resetUserWidgetFiles()
  for (const dir of tempDirs) await rm(dir, { force: true, recursive: true })
  tempDirs = []
  if (savedHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = savedHome
})

describe('widget slash dispatch', () => {
  test('/<id> opens the widget off the live registry with no gateway round-trip', async () => {
    registerAmbient('wslash')
    const probe = makeCtx()
    await dispatchSlash('/wslash Tokyo', probe.ctx)
    expect(ambientWidgets()[0]).toEqual({ appId: 'wslash', state: { label: 'Tokyo' } })
    expect(probe.requests).toEqual([])
    expect(probe.system).toEqual([])
  })

  test('/<id> again toggles the ambient widget closed', async () => {
    registerAmbient('wtoggle')
    const probe = makeCtx()
    await dispatchSlash('/wtoggle', probe.ctx)
    expect(ambientWidgets()).toHaveLength(1)
    await dispatchSlash('/wtoggle', probe.ctx)
    expect(ambientWidgets()).toHaveLength(0)
  })

  test('a refused launch (usage) prints instead of opening', async () => {
    defineWidgetApp({
      help: 'picky',
      id: 'wpicky',
      init: () => null,
      mode: 'ambient',
      reduce: (s: never) => s,
      render: () => h(Text, null, ''),
      usage: 'usage: /wpicky <thing>'
    })
    const probe = makeCtx()
    await dispatchSlash('/wpicky', probe.ctx)
    expect(probe.system).toEqual(['usage: /wpicky <thing>'])
    expect(ambientWidgets()).toHaveLength(0)
  })

  test('a non-widget command still falls through to the gateway ladder', async () => {
    registerAmbient('wother')
    const probe = makeCtx(() => Promise.resolve({ output: 'server said hi' }))
    await dispatchSlash('/serverthing', probe.ctx)
    expect(probe.requests.map(r => r.method)).toEqual(['slash.exec'])
    expect(probe.system).toEqual(['server said hi'])
  })

  test('/widgets-reload rescans $HERMES_HOME/tui-widgets and reports loaded files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-home-'))
    tempDirs.push(home)
    await mkdir(join(home, 'tui-widgets'), { recursive: true })
    await writeFile(
      join(home, 'tui-widgets', 'fresh.mjs'),
      `export default function register(sdk) {
        sdk.defineWidgetApp({ id: 'fresh', help: 'fresh', mode: 'ambient',
          init: () => ({}), reduce: s => s, render: () => sdk.h(sdk.Text, null, 'hi') })
      }`
    )
    process.env.HERMES_HOME = home
    const probe = makeCtx()
    await dispatchSlash('/widgets-reload', probe.ctx)
    expect(probe.system).toHaveLength(1)
    expect(probe.system[0]).toContain('loaded: fresh.mjs')
    expect(clientCommandNames()).toContain('widgets-reload')
    // and the freshly loaded widget dispatches immediately
    await dispatchSlash('/fresh', probe.ctx)
    expect(ambientWidgets().map(a => a.appId)).toEqual(['fresh'])
  })

  test('/widgets-reload with no user widgets reports that honestly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-home-'))
    tempDirs.push(home)
    process.env.HERMES_HOME = home
    const probe = makeCtx()
    await dispatchSlash('/widgets-reload', probe.ctx)
    expect(probe.system[0]).toContain('no user widgets found')
  })
})

describe('widget completion merge', () => {
  test('widget ids merge into slash-name completion with their help as meta', () => {
    registerAmbient('wcomp')
    expect(mergeWidgetCompletionItems('/wc', [])).toEqual([{ display: '/wcomp', meta: 'wcomp help', text: '/wcomp' }])
    // the reload command rides along on a shared prefix for discoverability
    expect(mergeWidgetCompletionItems('/w', [])).toEqual([
      { display: '/wcomp', meta: 'wcomp help', text: '/wcomp' },
      {
        display: '/widgets-reload',
        meta: expect.stringContaining('rescan') as unknown as string,
        text: '/widgets-reload'
      }
    ])
  })

  test('description-only matches discover client-local widgets', () => {
    registerAmbient('clock', 'Start a countdown timer')
    expect(mergeWidgetCompletionItems('/timer', [])).toEqual([
      { display: '/clock', meta: 'Start a countdown timer', text: '/clock' }
    ])
  })

  test('id substring matches are ranked above description matches', () => {
    registerAmbient('stopwatch', 'Measure elapsed time')
    registerAmbient('clock', 'Open the stopwatch timer')
    expect(mergeWidgetCompletionItems('/watch', []).map(item => item.text)).toEqual(['/stopwatch', '/clock'])
  })

  test('all finite score tiers remain ordered and true ties keep registry order', () => {
    registerAmbient('timer-first', 'first')
    registerAmbient('timer-second', 'second')
    registerAmbient('kitchen', 'timer')
    registerAmbient('oldtimer', 'archive')
    expect(mergeWidgetCompletionItems('/timer', []).map(item => item.text)).toEqual([
      '/timer-first',
      '/timer-second',
      '/oldtimer',
      '/kitchen'
    ])
  })

  test('gateway items keep precedence and duplicates are dropped', () => {
    registerAmbient('wdup')
    const gateway = [{ display: '/wdup', meta: 'from gateway', text: '/wdup' }]
    const items = mergeWidgetCompletionItems('/wd', gateway)
    expect(items.filter(i => i.text === '/wdup')).toEqual(gateway)
  })

  test('arg position (a space) never merges widget names', () => {
    registerAmbient('wargs', 'countdown timer')
    expect(mergeWidgetCompletionItems('/wargs UTC', [])).toEqual([])
    expect(mergeWidgetCompletionItems('/timer UTC', [])).toEqual([])
  })

  test('/widgets-reload keeps its prefix-only discovery and gateway dedup behavior', () => {
    registerAmbient('clock', 'Start a countdown timer')
    const reload = {
      display: '/widgets-reload',
      meta: 'from gateway',
      text: '/widgets-reload'
    }
    expect(mergeWidgetCompletionItems('/widgets-r', [])).toEqual([
      {
        display: '/widgets-reload',
        meta: expect.stringContaining('rescan') as unknown as string,
        text: '/widgets-reload'
      }
    ])
    expect(mergeWidgetCompletionItems('/widgets-r', [reload])).toEqual([reload])
    expect(mergeWidgetCompletionItems('/reload', [])).toEqual([])
  })

  test('a slash-ending widget completion keeps its argument separator', () => {
    registerAmbient('ops/')
    const [row] = mergeWidgetCompletionItems('/op', [])
    expect(row).toEqual({ display: '/ops/', meta: 'ops/ help', text: '/ops/' })
    if (!row) return

    const accepted = completionEdit('/op', row.text, 0, 3)
    expect(accepted).toEqual({ cursor: '/ops/ '.length, text: '/ops/ ' })
    expect(parseSlash(`${accepted.text}status`)).toEqual({ arg: 'status', name: 'ops/' })
  })

  test('a non-matching prefix contributes nothing', () => {
    registerAmbient('wxyz')
    expect(mergeWidgetCompletionItems('/zzz', [])).toEqual([])
  })
})
