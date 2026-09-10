/**
 * Terminal chrome logic — window-title text and notification message shaping.
 * Pure string work (no OpenTUI imports); the boundary shim
 * (`boundary/termChrome.ts`) owns the renderer writes and focus tracking.
 *
 * Title: OSC 0/2 content is set natively via `renderer.setTerminalTitle`
 * (the zig side emits the escape) — this module only SHAPES the text:
 * `"{session title} — Hermes"` once the gateway titles the session,
 * `"Hermes Agent"` until then.
 *
 * Notifications: the desktop ping itself is the renderer's native
 * `triggerNotification(message, title)` (boundary/termChrome.ts) — protocol
 * detection + tmux/Zellij wrapping live in the zig side. This module only
 * supplies the message TEXT (promptNotification / TURN_COMPLETE_NOTIFICATION)
 * and the sanitizer; it no longer hand-rolls OSC 9/99/777 escape strings.
 */

const ESC = '\u001b'

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

/** The window-title string: session title when known, Ink-era generic otherwise. */
export function windowTitleFor(sessionTitle: string | undefined): string {
  const title = sanitizeOscText(sessionTitle ?? '', 80)
  return title ? `${title} — Hermes` : 'Hermes Agent'
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
