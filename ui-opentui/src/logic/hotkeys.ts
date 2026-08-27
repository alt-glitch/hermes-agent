export type HotkeyRow = readonly [label: string, description: string]
export const DASHBOARD_NEW_SESSION_MESSAGE = 'starting a fresh dashboard chat...'

interface ActionKey {
  readonly ctrl: boolean
  readonly eventType?: string
  readonly meta: boolean
  readonly name: string
  readonly super?: boolean
}

interface ActionExitOverlayState {
  readonly backgroundPanel: boolean
  readonly billing: unknown
  readonly dashboard: boolean
  readonly journey?: boolean
  readonly pluginsHub?: boolean
  readonly petPicker?: boolean
  readonly pager: unknown
  readonly picker: unknown
  readonly prompt: unknown
  readonly promptHistory: boolean
  readonly sessionPicker: unknown
}

/** Full App overlay contract. Ink routes overlay input before action+D, so an
 * overlay must never accidentally exit the TUI or replace a hosted chat. */
export function actionExitBlocked(state: ActionExitOverlayState): boolean {
  return Boolean(
    state.prompt ||
    state.pager ||
    state.sessionPicker ||
    state.picker ||
    state.billing ||
    state.dashboard ||
    state.journey ||
    state.pluginsHub ||
    state.petPicker ||
    state.backgroundPanel ||
    state.promptHistory
  )
}

export function actionModifier(platform: NodeJS.Platform = process.platform): 'Cmd' | 'Ctrl' {
  return platform === 'darwin' ? 'Cmd' : 'Ctrl'
}

export function isActionHotkey(key: ActionKey, name: string, platform: NodeJS.Platform = process.platform): boolean {
  const action = platform === 'darwin' ? key.meta || key.super === true : key.ctrl
  return key.eventType !== 'release' && action && key.name === name
}

export function isRedrawHotkey(key: ActionKey, platform: NodeJS.Platform = process.platform): boolean {
  return isActionHotkey(key, 'l', platform)
}

/** Ink's action+D exit gesture: Cmd+D on macOS, Ctrl+D everywhere else. */
export function isExitHotkey(key: ActionKey, platform: NodeJS.Platform = process.platform): boolean {
  return isActionHotkey(key, 'd', platform)
}

export type CtrlCAction = 'clear-draft' | 'interrupt' | 'exit'

/** Ink's input-first Ctrl+C precedence. A typed draft belongs to the composer,
 * even while a turn is streaming, so the first press clears it before a later
 * press can interrupt the turn or enter the surface-specific exit flow. */
export function ctrlCAction(busy: boolean, hasDraft: boolean): CtrlCAction {
  if (hasDraft) return 'clear-draft'
  return busy ? 'interrupt' : 'exit'
}

/** OpenTUI-native shortcuts actually implemented by this engine. */
export function openTuiHotkeys(platform: NodeJS.Platform = process.platform): readonly HotkeyRow[] {
  const action = actionModifier(platform)
  return [
    ['Ctrl+C', 'copy selection / clear draft / interrupt / arm quit'],
    [`${action}+D`, 'exit'],
    [`${action}+L`, 'redraw / repaint'],
    ['Tab', 'apply completion'],
    ['↑/↓', 'completions / queued edit / input history / cursor'],
    ['Ctrl+X', 'delete queued message while editing'],
    ['Enter Enter (empty)', 'stop the turn / force the next queued message'],
    ['Esc Esc', 'discard draft (recall with ↑) / open prompt history when empty'],
    ['Cmd/Super+Backspace/Delete', 'kill to current line start / end'],
    ['Option/Ctrl+Backspace', 'delete word'],
    ['Ctrl+U/K', 'kill to line start / end (repeat across lines)'],
    ['Shift+Enter / Alt+Enter', 'insert newline'],
    ['Home/End', 'start / end of line'],
    ['Ctrl+Home/End', 'start / end of input buffer'],
    ['!<cmd>', 'run a shell command (for example !git status)']
  ]
}
