export type HotkeyRow = readonly [label: string, description: string]
export const DASHBOARD_NEW_SESSION_MESSAGE = 'starting a fresh dashboard chat...'

interface ActionKey {
  readonly ctrl: boolean
  readonly eventType?: string
  readonly meta: boolean
  readonly name: string
  readonly super?: boolean
}

interface AgentsKey extends ActionKey {
  readonly option?: boolean
  readonly shift?: boolean
}

export function isAgentsDashboardKey(key: AgentsKey): boolean {
  return (
    key.eventType !== 'release' &&
    key.ctrl &&
    !key.meta &&
    key.super !== true &&
    !key.option &&
    !key.shift &&
    key.name.toLowerCase() === 't'
  )
}

/** F7, or Ctrl+R (Ink 65ad5296ea): macOS terminals often reserve the function
 * row for hardware controls, so Ctrl+R is the portable dock toggle. */
export function isAgentsDockToggleKey(key: AgentsKey): boolean {
  if (key.eventType === 'release' || key.meta || key.super === true || key.option || key.shift) return false
  const name = key.name.toLowerCase()
  return (name === 'f7' && !key.ctrl) || (name === 'r' && key.ctrl)
}

interface ActionExitOverlayState {
  readonly backgroundPanel: boolean
  readonly billing: unknown
  readonly connection?: unknown
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
    state.connection ||
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

/** Ink's action+D exit gesture: Cmd+D on macOS, Ctrl+D everywhere. Literal
 * Ctrl+D is the terminal EOF convention, so macOS accepts it too (Ghostty
 * consumes Cmd+D for split panes; Ink b787fb9128). */
export function isExitHotkey(key: ActionKey, platform: NodeJS.Platform = process.platform): boolean {
  if (isActionHotkey(key, 'd', platform)) return true
  return (
    platform === 'darwin' &&
    key.eventType !== 'release' &&
    key.ctrl &&
    !key.meta &&
    key.super !== true &&
    key.name === 'd'
  )
}

interface ComposerContents {
  readonly composerDraft: string
  readonly pendingImages: readonly unknown[]
}

/** Text or attachments in the composer: Ctrl+D must not exit over an unsent draft. */
export function composerHasDraft(state: ComposerContents): boolean {
  return state.composerDraft !== '' || state.pendingImages.length > 0
}

/** Ctrl/Cmd+D exits only from an empty composer with no overlay up. With a
 * draft the key falls through to the textarea (forward delete). */
export function shouldExitOnHotkey(
  key: ActionKey,
  state: ActionExitOverlayState & ComposerContents,
  platform: NodeJS.Platform = process.platform
): boolean {
  return isExitHotkey(key, platform) && !actionExitBlocked(state) && !composerHasDraft(state)
}

export type DoubleEscAction = 'interrupt' | 'prompt-history'

/** Esc Esc on an EMPTY composer (Ink e49e359823): while a turn runs it is the
 * fast emergency brake (same path as Ctrl+C / /stop); idle it keeps opening
 * the session prompt history. A draft is discarded by the composer itself. */
export function emptyDoubleEscAction(busy: boolean, canInterrupt: boolean): DoubleEscAction {
  return busy && canInterrupt ? 'interrupt' : 'prompt-history'
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
    ['Ctrl+X', 'cut selection / delete queued message while editing'],
    ['Ctrl+T', 'open live agents'],
    ['Ctrl+R / F7', 'collapse / restore live-agent dock'],
    ['Enter Enter (empty)', 'stop the turn / force the next queued message'],
    ['Esc Esc', 'discard draft (recall with ↑) / stop the turn / open prompt history when empty'],
    ['Cmd/Super+Backspace/Delete', 'kill to current line start / end'],
    ['Option/Ctrl+Backspace', 'delete word'],
    ['Ctrl+U/K', 'kill to line start / end (repeat across lines)'],
    ['Shift+Enter / Alt+Enter', 'insert newline'],
    ['Home/End', 'start / end of line'],
    ['Ctrl+Home/End', 'start / end of input buffer'],
    ['!<cmd>', 'run a shell command (for example !git status)']
  ]
}
