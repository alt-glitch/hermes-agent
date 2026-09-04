/**
 * <TerminalChrome> — render-nothing wiring between store state and the
 * terminal-chrome seam (window title + waiting-on-you notifications).
 *
 *   title:   tracks `info.title` — "Hermes Agent" until the gateway titles
 *            the session (first-exchange auto-title / picker rename), then
 *            "{title} — Hermes". Runs immediately on mount so the generic
 *            title is set at boot.
 *   notify:  fires on the EDGES the user must act on —
 *              · a blocking prompt appearing (clarify/approval/sudo/secret/
 *                confirm — `state.prompt` undefined → defined), and
 *              · a turn finishing (`info.running` true → false).
 *            Both deferred (no notification for the initial state) and
 *            de-duplicated by the seam's focus gate.
 *
 * The seam is injectable for headless tests; production resolves it from
 * the live renderer via useRenderer().
 */
import { useRenderer } from '@opentui/solid'
import { createEffect, on } from 'solid-js'

import { installTerminalChrome, type TerminalChromeSeam } from '../boundary/termChrome.ts'
import { notificationOsc } from '../logic/notificationDispatcher.ts'
import type { createSessionStore } from '../logic/store.ts'
import { promptNotification, TURN_COMPLETE_NOTIFICATION } from '../logic/termChrome.ts'

type Store = ReturnType<typeof createSessionStore>

export function TerminalChrome(props: { store: Store; chrome?: TerminalChromeSeam }) {
  // Injected seam (tests) skips useRenderer() — headless mounts have no
  // opentui context to read.
  const chrome = props.chrome ?? installTerminalChrome(useRenderer())

  // Window title — immediate (sets the generic title at boot) and reactive.
  createEffect(() => {
    chrome.setTitle(props.store.state.info.title)
  })

  // Blocking prompt appeared → the agent is waiting on the user.
  createEffect(
    on(
      () => props.store.state.prompt,
      (prompt, previous) => {
        if (prompt && !previous) {
          chrome.notify(promptNotification(prompt.kind))
          if (props.store.state.bellOnPrompt) chrome.bell()
        }
      },
      { defer: true }
    )
  )

  // Turn finished → control is back with the user.
  createEffect(
    on(
      () => props.store.state.info.running,
      (running, previous) => {
        if (previous === true && running === false) chrome.notify(TURN_COMPLETE_NOTIFICATION)
      },
      { defer: true }
    )
  )

  // Background-activity notification → desktop OSC ping for the "important" ones
  // (errors/warnings/completions); the inline card already covers in-transcript.
  // The seam's own focus gate suppresses it when the terminal is focused.
  createEffect(
    on(
      () => props.store.state.lastNotification,
      n => {
        if (!n) return
        const osc = notificationOsc(n)
        if (osc) chrome.notify(osc)
      },
      { defer: true }
    )
  )

  return null
}
