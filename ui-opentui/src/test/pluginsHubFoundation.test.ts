import { describe, expect, test } from 'vitest'

import {
  decodePluginsListResponse,
  decodePluginsToggleResponse,
  type PluginRow
} from '../boundary/schema/PluginResponses.ts'
import {
  pluginCursor,
  pluginLabel,
  pluginQuickIndex,
  pluginToggleTarget,
  pluginWindow,
  scopePlugins
} from '../logic/pluginsHub.ts'

const ALPHA: PluginRow = { name: 'alpha', source: 'user', status: 'enabled', version: '1.2.3' }
const BETA: PluginRow = { name: 'beta', source: 'bundled', status: 'disabled' }
const GAMMA: PluginRow = { name: 'gamma', source: 'bundled', status: 'available' }
const ROWS: PluginRow[] = [ALPHA, BETA, GAMMA]

describe('Plugins Hub Effect boundaries', () => {
  test('decodes list/toggle responses leniently and rejects malformed contract fields', () => {
    const list = decodePluginsListResponse({
      plugins: ROWS,
      user_count: 1,
      bundled_count: 2,
      future: { compatible: true }
    })
    expect(list?.plugins).toHaveLength(3)
    expect(list?.future).toEqual({ compatible: true })
    expect(decodePluginsListResponse({ plugins: [{ name: 7 }] })).toBeUndefined()

    expect(
      decodePluginsToggleResponse({ ok: true, unchanged: false, name: 'beta', plugin: BETA, future: 1 })
    ).toMatchObject({ ok: true, name: 'beta', plugin: { name: 'beta' } })
    expect(decodePluginsToggleResponse({ ok: 'yes' })).toBeUndefined()
  })
})

describe('Plugins Hub pure model', () => {
  test('defaults to user plugins and falls back to all when only bundled rows exist', () => {
    expect(scopePlugins(ROWS, 'user')).toMatchObject({ scope: 'user', rows: [ALPHA] })
    expect(scopePlugins(ROWS.slice(1), 'user')).toMatchObject({ scope: 'all', rows: ROWS.slice(1) })
    expect(scopePlugins([], 'user')).toEqual({ scope: 'user', rows: [] })
    expect(scopePlugins(ROWS, 'all')).toEqual({ scope: 'all', rows: ROWS })
  })

  test('formats status/source labels and computes the next toggle state', () => {
    expect(pluginLabel(ALPHA, 'user')).toBe('✓ alpha v1.2.3')
    expect(pluginLabel(BETA, 'all')).toBe('✗ beta [bundled] (disabled)')
    expect(pluginLabel(GAMMA, 'all')).toBe('○ gamma [bundled] (available)')
    expect(pluginToggleTarget(ALPHA)).toBe(false)
    expect(pluginToggleTarget(BETA)).toBe(true)
  })

  test('clamps navigation, centers a bounded window, and resolves 1-9/0 quick keys', () => {
    const rows = Array.from({ length: 20 }, (_, index) => index)
    expect(pluginCursor(20, 0, -1)).toBe(0)
    expect(pluginCursor(20, 19, 1)).toBe(19)
    expect(pluginWindow(rows, 10)).toEqual({ offset: 4, rows: rows.slice(4, 16) })
    expect(pluginQuickIndex('1', 20, 10)).toBe(4)
    expect(pluginQuickIndex('0', 20, 10)).toBe(13)
    expect(pluginQuickIndex('x', 20, 10)).toBeUndefined()
    expect(pluginQuickIndex('0', 5, 0)).toBeUndefined()
  })
})
