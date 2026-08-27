import type { CompletionItem } from '../logic/store.ts'
import { rankSlashItems } from '../logic/slashFuzzy.ts'
import { listWidgetApps } from './registry.ts'

/** Client-side widget apps live in the TUI's registry, not the gateway — so
 *  `/` completions merge their id/help here (Ink `mergeWidgetAppItems`
 *  parity). Registry-driven: a new app surfaces automatically. The reload
 *  command rides along so the widget surface is discoverable. */
const RELOAD_ITEM: CompletionItem = {
  display: '/widgets-reload',
  meta: 'rescan $HERMES_HOME/tui-widgets and (re)register user widget apps',
  text: '/widgets-reload'
}

export function mergeWidgetCompletionItems(input: string, items: CompletionItem[]): CompletionItem[] {
  // Only complete the command NAME position (no args typed yet).
  if (input.includes(' ') || !input.startsWith('/')) return items

  const needle = input.toLowerCase()
  const apps = listWidgetApps()
  const local: CompletionItem[] = rankSlashItems(apps, input, app => ({ description: app.help, id: app.id }))
    .filter(app => !items.some(item => item.text === `/${app.id}`))
    .map(app => ({ display: `/${app.id}`, meta: app.help, text: `/${app.id}` }))
  if (
    apps.length > 0 &&
    RELOAD_ITEM.text.startsWith(needle) &&
    needle.length > 1 &&
    !items.some(item => item.text === RELOAD_ITEM.text)
  ) {
    local.push(RELOAD_ITEM)
  }
  return [...items, ...local]
}
