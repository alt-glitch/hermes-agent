import type { CommandsCatalogResponse } from '../boundary/schema/SessionCommandResponses.ts'
import { openTuiHotkeys, type HotkeyRow } from './hotkeys.ts'

export type HelpRow = HotkeyRow

const TUI_ROWS: readonly HelpRow[] = [
  ['/details [hidden|collapsed|expanded|cycle]', 'set global agent detail visibility mode'],
  [
    '/details <section> [hidden|collapsed|expanded|reset]',
    'override one section (thinking/tools/subagents/activity/delegation)'
  ],
  ['/fortune [random|daily]', 'show a random or daily local fortune']
]

function renderRows(rows: readonly HelpRow[]): string[] {
  if (rows.length === 0) return []
  const width = Math.max(...rows.map(([label]) => label.length))
  return rows.map(([label, description]) => `  ${label.padEnd(width)}  ${description}`)
}

/** Render Ink's categorized help-panel data into the existing OpenTUI pager.
 * The pager is the native long-form surface (focus/scroll/selection semantics)
 * and the caller supplies the skin's `helpHeader` as its title. */
export function formatHelp(catalog: CommandsCatalogResponse | undefined): string {
  const sections: string[] = []
  const categories = catalog?.categories?.length
    ? catalog.categories
    : catalog?.pairs.length
      ? [{ name: 'Commands', pairs: catalog.pairs }]
      : []
  for (const category of categories) {
    sections.push(category.name, ...renderRows(category.pairs), '')
  }

  if (catalog?.skill_count) {
    sections.push(`${catalog.skill_count} skill commands available — /skills to browse`, '')
  }

  const warning = catalog?.warning?.trim()
  if (warning) sections.push('Warning', `  ${warning}`, '')

  sections.push('TUI', ...renderRows(TUI_ROWS), '', 'Hotkeys', ...renderRows(openTuiHotkeys()))
  return sections.join('\n').trimEnd()
}
