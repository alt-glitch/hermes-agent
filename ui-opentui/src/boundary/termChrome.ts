/**
 * Terminal chrome seam — window title (OSC 0/2) + desktop notifications
 * through the renderer's native primitives.
 *
 * Why the renderer and not process.stdout: the zig side owns the terminal —
 * `setTerminalTitle` and `triggerNotification` are native FFI calls and
 * `writeOut` serializes raw control bytes with frame presentation, so chrome
 * writes can never tear a frame.
 *
 * Notifications go through the native `renderer.triggerNotification(message,
 * title)` (zig `lib.triggerNotification`), NOT a hand-rolled OSC 9/99/777 spray.
 * The zig side does what raw OSC can't: authoritative protocol detection
 * (query > heuristic) so it picks the ONE protocol the terminal speaks, **tmux
 * DCS passthrough wrapping** (raw OSC is silently eaten by tmux), and Zellij
 * OSC-99 enforcement. It returns `false` when no protocol was detected.
 *
 * Focus suppression: core parses mode-1004 focus reports (`ESC[I`/`ESC[O`)
 * and re-emits them as renderer `focus`/`blur` events — notifications are
 * skipped while the terminal reports focused (you're already looking at it).
 * Native `triggerNotification` does NOT do focus suppression, so it stays our
 * policy here. Terminals that never report focus leave the state at the
 * assumed-focused initial value… which would swallow every notification, so
 * the FIRST blur is what arms suppression: until a blur arrives we treat focus
 * as unknown and notify unconditionally (worst case: a redundant ping while
 * focused).
 *
 * Everything here is total — chrome must never throw into the render loop
 * or a teardown path.
 */
import type { CliRenderer } from '@opentui/core'

import type { TermNotification } from '../logic/termChrome.ts'
import {
  notifyEnabled,
  sanitizeOscText,
  TITLE_STACK_RESTORE,
  TITLE_STACK_SAVE,
  windowTitleFor
} from '../logic/termChrome.ts'
import { getLog } from './log.ts'
const BEL = '\u0007'

/** What the view layer needs from the chrome seam (DI-friendly for tests). */
export interface TerminalChromeSeam {
  /** Set the window title from the session title (undefined → generic). */
  readonly setTitle: (sessionTitle: string | undefined) => void
  /** Announce "waiting on you" to the hosting terminal (no-op while focused). */
  readonly notify: (notification: TermNotification) => void
  /** Ring the terminal bell; no-op when stdout is not interactive. */
  readonly bell: () => void
}

/** The renderer surface the seam writes through (runtime-verified shapes). */
interface RendererSeam {
  setTerminalTitle(title: string): void
  /** Native desktop notification (protocol detection + tmux/Zellij wrapping). */
  triggerNotification(message: string, title?: string): boolean
  writeOut(chunk: string): void
  on(event: 'focus' | 'blur', listener: () => void): unknown
  once(event: 'destroy', listener: () => void): unknown
  readonly isDestroyed: boolean
}

/** Install the chrome seam on a live renderer. Idempotent per renderer use —
 *  the entry calls it once, right next to the render bridge. */
export function installTerminalChrome(
  renderer: CliRenderer,
  output: Pick<NodeJS.WriteStream, 'isTTY'> = process.stdout
): TerminalChromeSeam {
  const seam = renderer as unknown as RendererSeam
  const notificationsOn = notifyEnabled()

  // unknown (null) until the terminal proves it reports focus; then boolean.
  let focused: boolean | null = null
  try {
    seam.on('focus', () => {
      focused = true
    })
    seam.on('blur', () => {
      focused = false
    })
  } catch (cause) {
    getLog().warn('chrome', 'focus tracking unavailable', { cause: String(cause) })
  }

  // Bracket our title ownership: save the user's title now, restore on quit.
  // Best-effort — terminals without the XTWINOPS title stack ignore both.
  writeRaw(seam, TITLE_STACK_SAVE)
  seam.once('destroy', () => writeRaw(seam, TITLE_STACK_RESTORE, { evenIfDestroyed: true }))

  let lastTitle = ''
  return {
    bell: () => {
      if (output.isTTY) writeRaw(seam, BEL)
    },
    setTitle: sessionTitle => {
      const title = windowTitleFor(sessionTitle)
      if (title === lastTitle) return
      lastTitle = title
      try {
        if (!seam.isDestroyed) seam.setTerminalTitle(title)
      } catch (cause) {
        getLog().warn('chrome', 'setTerminalTitle failed', { cause: String(cause) })
      }
    },
    notify: notification => {
      if (!notificationsOn || focused === true) return
      // Map our {title:'Hermes', body:'finished — …'} → native (message, title):
      // native API takes the BODY as the message and the heading as the title.
      const title = sanitizeOscText(notification.title)
      const body = sanitizeOscText(notification.body ?? '')
      if (!title) return
      const message = body || title
      try {
        if (!seam.isDestroyed) seam.triggerNotification(message, title)
      } catch (cause) {
        getLog().warn('chrome', 'triggerNotification failed', { cause: String(cause) })
      }
    }
  }
}

/** Raw control write through the renderer; falls back to process.stdout when
 *  the renderer is already gone (the title-stack restore on destroy — at that
 *  point there is no frame left to tear). */
function writeRaw(seam: RendererSeam, chunk: string, options?: { evenIfDestroyed?: boolean }): void {
  try {
    if (!seam.isDestroyed) {
      seam.writeOut(chunk)
      return
    }
    if (options?.evenIfDestroyed) process.stdout.write(chunk)
  } catch (cause) {
    getLog().warn('chrome', 'control write failed', { cause: String(cause) })
  }
}
