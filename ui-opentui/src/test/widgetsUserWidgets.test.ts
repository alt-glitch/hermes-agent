/**
 * User-widget hot loader — $HERMES_HOME/tui-widgets scan/import/register,
 * per-file failure isolation, cache-busted edits, delete-sync (a removed file
 * unregisters AND undocks its apps). Uses real files under a temp dir and the
 * SHIPPED skill template to prove the native sdk runs it unmodified.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

import { ambientWidgets, disposeAllWidgets, launchWidget, widgetInstanceFor } from '../widgets/host.ts'
import { getWidgetApp, listWidgetApps, removeWidgetApp } from '../widgets/registry.ts'
import type { RBox } from '../widgets/runtime.ts'
import { loadUserWidgets, resetUserWidgetFiles } from '../widgets/userWidgets.ts'
import { DARK_THEME } from '../logic/theme.ts'

// Upstream e3d524b482d absorbed skills/productivity/tui-widgets into the
// hermes-agent hub skill; the shipped clock template lives there now.
const TEMPLATE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../skills/autonomous-ai-agents/hermes-agent/templates/clock.mjs'
)

const widgetFile = (id: string, help = `${id} help`) => `
export default function register(sdk) {
  const { Text, defineWidgetApp, h } = sdk
  defineWidgetApp({
    id: '${id}',
    help: '${help}',
    mode: 'ambient',
    init: arg => ({ label: arg || 'x' }),
    reduce: s => s,
    render: ({ state }) => h(Text, null, state.label)
  })
}
`

let dirs: string[] = []
const makeDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-widgets-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  disposeAllWidgets()
  for (const app of listWidgetApps()) removeWidgetApp(app.id)
  resetUserWidgetFiles()
  for (const dir of dirs) await rm(dir, { force: true, recursive: true })
  dirs = []
})

describe('user widget loader', () => {
  test('a missing directory yields an empty result, no throw', async () => {
    const result = await loadUserWidgets(join(tmpdir(), 'definitely-missing-widgets-dir'))
    expect(result).toEqual({ added: [], errors: [], loaded: [], removed: [] })
  })

  test('loads .mjs files, registers their apps, reports added ids', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'one.mjs'), widgetFile('one'))
    const result = await loadUserWidgets(dir)
    expect(result.loaded).toEqual(['one.mjs'])
    expect(result.added).toEqual(['one'])
    expect(result.errors).toEqual([])
    expect(getWidgetApp('one')?.help).toBe('one help')
  })

  test('a broken file is isolated: it errors, siblings still load', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'aaa-broken.mjs'), 'export const nope = 1\n')
    await writeFile(join(dir, 'bbb-throws.mjs'), 'export default () => { throw new Error("register exploded") }\n')
    await writeFile(join(dir, 'ccc-good.mjs'), widgetFile('good'))
    const result = await loadUserWidgets(dir)
    expect(result.loaded).toEqual(['ccc-good.mjs'])
    expect(result.errors.map(e => e.file).sort()).toEqual(['aaa-broken.mjs', 'bbb-throws.mjs'])
    expect(result.errors.find(e => e.file === 'aaa-broken.mjs')?.message).toContain('default export')
    expect(result.errors.find(e => e.file === 'bbb-throws.mjs')?.message).toContain('register exploded')
    expect(getWidgetApp('good')).toBeDefined()
  })

  test('editing a file re-imports it (cache-busted) and the new definition wins', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'w.mjs'), widgetFile('w', 'old help'))
    await loadUserWidgets(dir)
    expect(getWidgetApp('w')?.help).toBe('old help')
    await writeFile(join(dir, 'w.mjs'), widgetFile('w', 'new help'))
    const result = await loadUserWidgets(dir)
    expect(result.loaded).toEqual(['w.mjs'])
    expect(getWidgetApp('w')?.help).toBe('new help')
  })

  test('an edit while DOCKED swaps in a fresh instance for the new definition', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'w.mjs'), widgetFile('w'))
    await loadUserWidgets(dir)
    expect(launchWidget('w')).toBeNull()
    const stale = widgetInstanceFor('w')
    await writeFile(join(dir, 'w.mjs'), widgetFile('w', 'reloaded'))
    await loadUserWidgets(dir)
    expect(stale?.isDisposed()).toBe(true) // old hooks/timers torn down
    const fresh = widgetInstanceFor('w')
    expect(fresh).not.toBe(stale)
    expect(ambientWidgets().map(a => a.appId)).toEqual(['w']) // stays docked
  })

  test('deleting a file unregisters its apps and undocks them on the next scan', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'gone.mjs'), widgetFile('gone'))
    await loadUserWidgets(dir)
    launchWidget('gone')
    expect(ambientWidgets()).toHaveLength(1)
    await rm(join(dir, 'gone.mjs'))
    const result = await loadUserWidgets(dir)
    expect(result.removed).toEqual(['gone'])
    expect(getWidgetApp('gone')).toBeUndefined()
    expect(ambientWidgets()).toHaveLength(0) // no ghost card
  })
})

describe('the SHIPPED clock template runs on the native sdk unmodified', () => {
  test('registers /clock, validates its arg, and renders a Dialog card', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'clock.mjs'), await readFile(TEMPLATE, 'utf8'))
    const result = await loadUserWidgets(dir)
    expect(result.loaded).toEqual(['clock.mjs'])
    expect(result.errors).toEqual([])
    const clock = getWidgetApp('clock')
    expect(clock).toBeDefined()
    expect(clock?.mode).toBe('ambient')
    expect(clock?.help).toContain('live clock')

    // init: bad timezone refused (usage line), good one accepted
    expect(launchWidget('clock', 'Not/AZone')).toContain('usage: /clock')
    expect(launchWidget('clock', 'UTC')).toBeNull()
    expect(ambientWidgets()[0]?.state).toEqual({ label: 'UTC' })

    // render: resolves through the hook runtime (useState + useEffect timer)
    const instance = widgetInstanceFor('clock')
    expect(instance).toBeDefined()
    instance?.render({ cols: 80, rows: 24, state: { label: 'UTC' }, t: DARK_THEME })
    const tree = instance?.tree() as RBox
    expect(tree.kind).toBe('box') // the Dialog card
    expect(tree.border).toBe(true)
    expect(tree.style['width']).toBe(30)
    const text = JSON.stringify(tree)
    expect(text).toContain('UTC')
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}/) // the live time face painted
    instance?.dispose()
  })
})
