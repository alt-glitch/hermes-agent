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

/** OpenTUI-native shortcuts actually implemented by this engine. */
export function openTuiHotkeys(platform: NodeJS.Platform = process.platform): readonly HotkeyRow[] {
  const action = actionModifier(platform)
  return [
    ['Ctrl+C', 'copy selection / interrupt / clear draft / arm quit'],
    [`${action}+D`, 'exit'],
    [`${action}+L`, 'redraw / repaint'],
    ['Tab', 'apply completion'],
    ['↑/↓', 'completions / queued edit / input history / cursor'],
    ['Ctrl+X', 'delete queued message while editing'],
    ['Enter Enter (empty)', 'stop the turn / force the next queued message'],
    ['Esc Esc', 'open session prompt history'],
    ['Shift+Enter / Alt+Enter', 'insert newline'],
    ['Home/End', 'start / end of line'],
    ['Ctrl+Home/End', 'start / end of input buffer'],
    ['!<cmd>', 'run a shell command (for example !git status)']
  ]
}
