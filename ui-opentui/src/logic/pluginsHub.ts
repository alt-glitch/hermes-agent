import type { PluginRow } from '../boundary/schema/PluginResponses.ts'

export const PLUGINS_VISIBLE_ROWS = 12

export type PluginScope = 'all' | 'user'

export interface ScopedPlugins {
  rows: readonly PluginRow[]
  scope: PluginScope
}

export type PluginToggleParams =
  | { action: 'toggle'; enable: boolean; key: string }
  | { action: 'toggle'; enable: boolean; name: string }

export function pluginIdentity(row: PluginRow): string {
  return row.key?.trim() || row.name
}

/** New gateways address canonical keys; legacy rows remain name-addressed. */
export function pluginToggleParams(row: PluginRow, enable: boolean): PluginToggleParams {
  const key = row.key?.trim()
  return key ? { action: 'toggle', enable, key } : { action: 'toggle', enable, name: row.name }
}

/** Replace only the selected canonical row, even when another category shares its bare name. */
export function replacePluginRow(
  rows: readonly PluginRow[],
  selected: PluginRow,
  updated: PluginRow
): readonly PluginRow[] {
  const identity = pluginIdentity(selected)
  const replacement = selected.key && !updated.key ? { ...updated, key: selected.key } : updated
  return rows.map(row => (pluginIdentity(row) === identity ? replacement : row))
}

/** Apply the Ink hub's user-only default, falling back to all when only bundled plugins exist. */
export function scopePlugins(rows: readonly PluginRow[], requested: PluginScope): ScopedPlugins {
  if (requested === 'all') return { rows, scope: 'all' }
  const userRows = rows.filter(row => row.source !== 'bundled')
  return userRows.length || rows.length === 0 ? { rows: userRows, scope: 'user' } : { rows, scope: 'all' }
}

export function pluginToggleTarget(row: PluginRow): boolean {
  return row.status !== 'enabled'
}

export function pluginLabel(row: PluginRow, scope: PluginScope): string {
  const status = row.status ?? 'not enabled'
  const glyph = status === 'enabled' ? '✓' : status === 'disabled' ? '✗' : '○'
  const version = row.version ? ` v${row.version}` : ''
  const source = scope === 'all' && row.source === 'bundled' ? ' [bundled]' : ''
  const state = status === 'enabled' ? '' : ` (${status})`
  return `${glyph} ${row.name}${version}${source}${state}`
}

export function pluginCursor(count: number, current: number, delta: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), current + delta))
}

export function pluginWindowOffset(count: number, selected: number, visible: number = PLUGINS_VISIBLE_ROWS): number {
  return Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible))
}

export function pluginWindow<T>(
  rows: readonly T[],
  selected: number,
  visible: number = PLUGINS_VISIBLE_ROWS
): { rows: readonly T[]; offset: number } {
  const offset = pluginWindowOffset(rows.length, selected, visible)
  return { rows: rows.slice(offset, offset + visible), offset }
}

/** Resolve Ink's 1-9/0 quick-toggle key to an absolute row index in the current window. */
export function pluginQuickIndex(
  key: string,
  count: number,
  selected: number,
  visible: number = PLUGINS_VISIBLE_ROWS
): number | undefined {
  const ordinal = key === '0' ? 10 : Number.parseInt(key, 10)
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > Math.min(10, count)) return undefined
  return pluginWindowOffset(count, selected, visible) + ordinal - 1
}
