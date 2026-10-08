/**
 * Terminal chrome logic — window-title text and notification message shaping.
 * Pure string work (no OpenTUI imports); the boundary shim
 * (`boundary/termChrome.ts`) owns the renderer writes and focus tracking.
 *
 * Title: split tab (OSC 1) / window (OSC 2) titles with a busy/blocked/idle
 * marker plus model and cwd (Ink f1a91ad416) — `terminalTitlesFor` shapes the
 * text and `titleSequences` the escapes; the boundary writes them.
 *
 * Terminal defaults: `defaultColorSlot` is the OSC 10/11 paint + OSC 110/111
 * restore state machine (Ink 727f6704a7 / 1f652214df); `terminalDefaultsFor`
 * picks the colors from a theme (ansi256 tones resolved to hex, 0b1ee22b9e).
 *
 * Notifications: the desktop ping itself is the renderer's native
 * `triggerNotification(message, title)` (boundary/termChrome.ts) — protocol
 * detection + tmux/Zellij wrapping live in the zig side. This module only
 * supplies the message TEXT (promptNotification / TURN_COMPLETE_NOTIFICATION)
 * and the sanitizer; it no longer hand-rolls OSC 9/99/777 escape strings.
 */

const ESC = '\u001b'
const BEL = '\u0007'

/** Strip control chars (C0/C1, incl. ESC/BEL) so user text can never
 *  terminate or splice an escape sequence; collapse runs of whitespace;
 *  cap the length. */
export function sanitizeOscText(text: string, max = 120): string {
  const clean = (text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > max ? clean.slice(0, Math.max(1, max - 1)) + '…' : clean
}

/** Activity marker leading both titles (Ink f1a91ad416): `⚠` blocked on the
 *  user, `⏳` turn running, `✓` idle. */
export type TitleMarker = '⚠' | '⏳' | '✓'

/** Prompt kinds that block the AGENT on the user (Ink: approval, clarify and
 *  the sensitive prompts). The client-local `confirm` dialog is not one. */
const BLOCKING_PROMPT_KINDS: ReadonlySet<string> = new Set(['approval', 'clarify', 'secret', 'sudo', 'vaultUnlock'])

export function titleMarker(promptKind: string | undefined, running: boolean | undefined): TitleMarker {
  if (promptKind !== undefined && BLOCKING_PROMPT_KINDS.has(promptKind)) return '⚠'
  return running === true ? '⏳' : '✓'
}

/** Brand title before the session's model is known (Ink `'Hermes'`). */
export const GENERIC_TITLE = 'Hermes'

/** Ink `shortCwd`: `~`-relative, head-elided to `max` cells. */
export function shortTitleCwd(cwd: string, max = 24, home: string | undefined = process.env.HOME): string {
  const p = home && (cwd === home || cwd.startsWith(home + '/')) ? `~${cwd.slice(home.length)}` : cwd
  return p.length <= max ? p : `…${p.slice(-(max - 1))}`
}

/** Ink `composeTabTitle`: `<marker> <name> · <model> · <cwd>`, empty parts dropped. */
function composeTitle(marker: TitleMarker, name: string, model: string, cwd: string, maxName = 28): string {
  const trimmed = name.trim()
  const shortName = trimmed.length > maxName ? `${trimmed.slice(0, maxName - 1)}…` : trimmed
  const segments = [shortName, model, cwd].filter(Boolean)
  return segments.length ? `${marker} ${segments.join(' · ')}` : marker
}

/** The tab (OSC 1) and window (OSC 2) titles. `tab` undefined ⇒ one shared
 *  title (OSC 0) — the generic brand before the model is known. */
export interface TerminalTitles {
  readonly window: string
  readonly tab?: string
}

export interface TitleInputs {
  readonly marker: TitleMarker
  readonly sessionTitle?: string | undefined
  readonly model?: string | undefined
  readonly cwd?: string | undefined
}

/** Split titles (Ink f1a91ad416): Terminal.app truncates narrow background tabs
 *  from the LEFT, so the tab gets only `<marker> <session>` while the window
 *  bar carries the full `· model · cwd` string. */
export function terminalTitlesFor(inputs: TitleInputs, home: string | undefined = process.env.HOME): TerminalTitles {
  const model = sanitizeOscText((inputs.model ?? '').replace(/^.*\//, ''), 60)
  if (!model) return { window: GENERIC_TITLE }
  const name = sanitizeOscText(inputs.sessionTitle ?? '', 80)
  const rawCwd = sanitizeOscText(inputs.cwd ?? '', 400)
  const cwd = rawCwd ? shortTitleCwd(rawCwd, 24, home) : ''
  return {
    tab: composeTitle(inputs.marker, name, '', ''),
    window: composeTitle(inputs.marker, name, model, cwd)
  }
}

/** OSC 1 (icon/tab) + OSC 2 (window) for a split pair. Text must already be
 *  sanitized (terminalTitlesFor does it). */
export function titleSequences(titles: TerminalTitles): string {
  return titles.tab === undefined
    ? `${ESC}]0;${titles.window}${BEL}`
    : `${ESC}]1;${titles.tab}${BEL}${ESC}]2;${titles.window}${BEL}`
}

/** A notification's two text parts (body optional). */
export interface TermNotification {
  readonly title: string
  readonly body?: string
}

/** The XTWINOPS title-stack pushes/pops bracketing our title ownership: save
 *  the user's title on install, restore it on teardown (terminals without the
 *  stack ignore these — they just keep our last title, same as today). */
export const TITLE_STACK_SAVE = `${ESC}[22;0t`
export const TITLE_STACK_RESTORE = `${ESC}[23;0t`

/** What to announce for a blocking prompt, by kind. Kinds arrive from the
 *  store's ActivePrompt union; unknown kinds get the generic line so a new
 *  prompt type can never silently drop notifications. */
export function promptNotification(kind: string): TermNotification {
  switch (kind) {
    case 'clarify':
      return { title: 'Hermes', body: 'needs an answer to continue' }
    case 'approval':
      return { title: 'Hermes', body: 'wants approval to run a command' }
    case 'sudo':
      return { title: 'Hermes', body: 'needs your sudo password' }
    case 'secret':
      return { title: 'Hermes', body: 'needs a secret/API key' }
    case 'vaultUnlock':
      return { title: 'Hermes', body: 'needs your password manager unlocked' }
    case 'confirm':
      return { title: 'Hermes', body: 'is asking you to confirm' }
    default:
      return { title: 'Hermes', body: 'is waiting for your input' }
  }
}

/** Turn-complete announcement. */
export const TURN_COMPLETE_NOTIFICATION: TermNotification = {
  title: 'Hermes',
  body: 'finished — awaiting your input'
}

/**
 * `HERMES_TUI_NOTIFY` kill-switch (TUI-only env var, same family as
 * HERMES_TUI_TOOL_OUTPUT_LINES): unset/anything-else = on, `0`/`false`/`off`
 * = no notification sequences are ever written. The window title is NOT
 * gated by this — it's chrome, not interruption.
 */
export function notifyEnabled(env: { readonly [k: string]: string | undefined } = process.env): boolean {
  const raw = (env.HERMES_TUI_NOTIFY ?? '').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

// ── Terminal default fg/bg (OSC 10/11) ───────────────────────────────

const HEX6_RE = /^#[0-9a-f]{6}$/i

/** True when `hex` can be painted as a terminal default (OSC 10/11 speak `#rrggbb`). */
export const isPaintableHex = (hex: string): boolean => HEX6_RE.test(hex)

/** The terminal defaults a theme owns: a skin with a paintable canvas (`bg` =
 *  ui_bg ?? background) owns BOTH defaults — the backdrop and the default-fg
 *  text tone — otherwise both are '' (restore the terminal's own). */
export function terminalDefaultsFor(
  theme: { readonly color: { readonly bg: string; readonly text: string } },
  toneHex: (tone: string) => string
): { readonly fg: string; readonly bg: string } {
  const bg = isPaintableHex(theme.color.bg) ? theme.color.bg : ''
  return { bg, fg: bg ? toneHex(theme.color.text) : '' }
}

/** One paintable terminal default (fg=10, bg=11). `set(hex)` returns the bytes
 *  to write: a paint for a valid hex, a restore (OSC 1xx) only if we painted
 *  earlier, '' otherwise — a skinless session never touches the terminal.
 *  `restoreSeq()` is the exit-time restore ('' when nothing is painted). */
export function defaultColorSlot(osc: 10 | 11): {
  readonly set: (hex: string) => string
  readonly restoreSeq: () => string
  readonly painted: () => boolean
} {
  const restore = `${ESC}]1${osc}${BEL}`
  let current = ''
  return {
    set: hex => {
      if (isPaintableHex(hex)) {
        if (hex.toLowerCase() === current) return ''
        current = hex.toLowerCase()
        return `${ESC}]${osc};${current}${BEL}`
      }
      if (!current) return ''
      current = ''
      return restore
    },
    restoreSeq: () => (current ? restore : ''),
    painted: () => current !== ''
  }
}
