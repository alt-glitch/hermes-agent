/**
 * The persisted light/dark mode pin (`display.tui_theme`, written by
 * `/theme auto|light|dark`). Ink parity: `applyConfiguredTuiTheme` in
 * ui-tui/src/app/createGatewayEventHandler.ts.
 *
 * 'light'/'dark' bridge to `HERMES_TUI_THEME` — the signal `detectLightMode`
 * already honors (only an explicit `HERMES_TUI_LIGHT` outranks it). 'auto'
 * clears the pin, but only one CONFIG set: a `HERMES_TUI_THEME` the user
 * exported in their shell is an explicit override and stays.
 *
 * `apply` returns whether the effective env changed, so the caller re-themes
 * the store only on a real polarity input change.
 */

export type ThemePinOwner = 'config' | 'none' | 'shell'

export interface ThemePin {
  /** A user `/theme` write the gateway confirmed: always wins. */
  readonly apply: (raw: unknown) => boolean
  /** A config hydrate (startup / mtime sync) that captured `revision()` before
   *  its `config.get full` request: dropped when a `/theme` landed in between,
   *  so a stale read can never revert the user's fresh pin. */
  readonly hydrate: (raw: unknown, revision: number) => boolean
  readonly revision: () => number
  readonly owner: () => ThemePinOwner
}

export function createThemePin(env: Record<string, string | undefined> = process.env): ThemePin {
  let configPinned = false
  let revision = 0

  const set = (raw: unknown): boolean => {
    const mode = (typeof raw === 'string' ? raw : '').trim().toLowerCase()
    const current = env.HERMES_TUI_THEME ?? ''
    if (mode === 'light' || mode === 'dark') {
      // Record ownership BEFORE the match short-circuit (Ink c543c691fc):
      // otherwise env and config agreeing at boot leaves the pin unowned and
      // a later 'auto' could never clear it.
      configPinned = true
      if (current === mode) return false
      env.HERMES_TUI_THEME = mode
      return true
    }
    if (!current || !configPinned) return false
    configPinned = false
    delete env.HERMES_TUI_THEME
    return true
  }

  return {
    apply(raw) {
      revision += 1
      return set(raw)
    },
    hydrate: (raw, captured) => (captured === revision ? set(raw) : false),
    revision: () => revision,
    owner: () => (configPinned ? 'config' : env.HERMES_TUI_THEME ? 'shell' : 'none')
  }
}

/** The process-wide pin (the env it mutates is process-wide too). */
export const themePin: ThemePin = createThemePin()

/** `display.tui_theme` from a decoded `config.get full` payload. */
export function tuiThemeFromConfig(config: Record<string, unknown>): string | undefined {
  const display = config.display
  if (typeof display !== 'object' || display === null) return undefined
  const raw = (display as Record<string, unknown>).tui_theme
  return typeof raw === 'string' ? raw : undefined
}
