/**
 * <TerminalChrome> — render-nothing wiring between store state and the
 * terminal-chrome seam (window title + waiting-on-you notifications).
 *
 *   titles:  split tab (OSC 1) `<marker> <session>` / window (OSC 2)
 *            `<marker> <session> · <model> · <cwd>` (Ink f1a91ad416); marker
 *            ⚠ blocked on a prompt, ⏳ turn running, ✓ idle. "Hermes" until the
 *            model is known. Runs immediately on mount.
 *   colors:  the theme's paintable canvas owns the terminal default fg/bg
 *            (OSC 10/11; ansi256 text tones resolved to hex); a skin without
 *            one restores the terminal's own (OSC 110/111).
 *   polarity: the terminal background probe (core themeMode / THEME_MODE)
 *            feeds `setProbedPolarity`; an effective change re-derives the
 *            theme live against the current skin.
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
import type { CliRenderer } from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { createEffect, on, onCleanup } from 'solid-js'

import { installTerminalChrome, type TerminalChromeSeam } from '../boundary/termChrome.ts'
import { notificationOsc } from '../logic/notificationDispatcher.ts'
import type { createSessionStore } from '../logic/store.ts'
import {
  promptNotification,
  terminalDefaultsFor,
  terminalTitlesFor,
  titleMarker,
  TURN_COMPLETE_NOTIFICATION
} from '../logic/termChrome.ts'
import { setProbedPolarity, type TerminalPolarity, themeToneHex } from '../logic/theme.ts'
import { installThemeProbe } from '../boundary/themeProbe.ts'

type Store = ReturnType<typeof createSessionStore>

/** Subscribe to terminal polarity; returns a disposer. */
export type ThemeProbe = (onPolarity: (mode: TerminalPolarity | null) => void) => () => void

export function TerminalChrome(props: { store: Store; chrome?: TerminalChromeSeam; themeProbe?: ThemeProbe }) {
  // Injected seams (tests) skip useRenderer() — headless mounts have no
  // opentui context to read.
  let renderer: CliRenderer | undefined
  const live = (): CliRenderer => (renderer ??= useRenderer())
  const chrome = props.chrome ?? installTerminalChrome(live())
  const themeProbe: ThemeProbe = props.themeProbe ?? (cb => installThemeProbe(live(), cb))

  // Tab + window titles — immediate (generic brand at boot) and reactive.
  createEffect(() => {
    const state = props.store.state
    chrome.setTitles(
      terminalTitlesFor({
        marker: titleMarker(state.prompt?.kind, state.info.running),
        sessionTitle: state.info.title,
        model: state.info.model,
        cwd: state.info.cwd
      })
    )
  })

  // Skin-owned terminal defaults — repaint on every theme change (skin swap,
  // polarity flip re-deriving the text tone); restore when no canvas.
  createEffect(() => {
    chrome.setDefaultColors(terminalDefaultsFor(props.store.state.theme, themeToneHex))
  })

  // Live terminal polarity → re-derive the theme for the current skin.
  const disposeProbe = themeProbe(mode => {
    if (setProbedPolarity(mode)) props.store.reapplyTheme()
  })
  onCleanup(disposeProbe)

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
