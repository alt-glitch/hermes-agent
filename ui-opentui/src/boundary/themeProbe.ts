/**
 * Terminal background probe → light/dark polarity, via @opentui/core's own
 * theme-mode machinery (`renderer.themeMode`, `waitForThemeMode`, the
 * `THEME_MODE` event). Core queries OSC 10/11 at startup and again on every
 * DSR 997 colour-scheme notification, so the answer is re-evaluated live.
 *
 * Renderer quirk kept here: core infers the mode from the OSC 11 background
 * alone, but exactly-`#000000` is the "unset default" fingerprint (xterm.js
 * hosts, tmux) rather than a measurement. Ink distrusts it and falls back to
 * the OSC 10 foreground. Core does not expose the raw replies, so a
 * PREPENDED, non-consuming input handler observes them (returns false, core's
 * own handler still runs) and the pure `resolveProbedPolarity` combines both.
 *
 * Total: a renderer without the API (older core, test fakes) simply never
 * reports, and the env fallback in `detectLightMode` keeps deciding.
 */
import type { CliRenderer } from '@opentui/core'

import { resolveProbedPolarity, type TerminalPolarity } from '../logic/theme.ts'
import { getLog } from './log.ts'

/** Same reply grammar core parses (OSC 10/11; rgb:R/G/B or #rrggbb; BEL or ST). */
const OSC_COLOR_REPLY =
  // eslint-disable-next-line no-control-regex
  /\u001b\](10|11);(?:rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)|#([0-9a-f]{6}))(?:\u0007|\u001b\\)/gi

/** `rgb:` channels may be 1–4 hex digits; scale to 8 bits like xterm. */
function channelHex(raw: string): string {
  const max = 16 ** raw.length - 1
  return Math.round((parseInt(raw, 16) / max) * 255)
    .toString(16)
    .padStart(2, '0')
}

/** Parse every OSC 10/11 reply in one input chunk. */
export function parseColorReplies(sequence: string): { foreground?: string; background?: string } {
  const out: { foreground?: string; background?: string } = {}
  OSC_COLOR_REPLY.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OSC_COLOR_REPLY.exec(sequence))) {
    const [, slot, r, g, b, hex] = match
    const color = hex ? `#${hex.toLowerCase()}` : r && g && b ? `#${channelHex(r)}${channelHex(g)}${channelHex(b)}` : ''
    if (!color) continue
    if (slot === '10') out.foreground = color
    else out.background = color
  }
  return out
}

/** The renderer surface the probe touches (runtime-verified on core 0.4.x). */
interface ThemeModeSeam {
  readonly themeMode?: TerminalPolarity | null
  waitForThemeMode?(timeoutMs?: number): Promise<TerminalPolarity | null>
  prependInputHandler?(handler: (sequence: string) => boolean): void
  removeInputHandler?(handler: (sequence: string) => boolean): void
  on(event: 'theme_mode', listener: (mode: TerminalPolarity) => void): unknown
  off?(event: 'theme_mode', listener: (mode: TerminalPolarity) => void): unknown
  once(event: 'destroy', listener: () => void): unknown
}

/** How long boot waits for the startup OSC 10/11 answer before giving up
 *  (env fallback stays in charge; a late THEME_MODE event still applies). */
const BOOT_WAIT_MS = 1000

/**
 * Observe the terminal's polarity. `onPolarity` fires with each EFFECTIVE
 * change (`null` = untrusted/unanswered → env fallback). Returns a disposer.
 */
export function installThemeProbe(
  renderer: CliRenderer,
  onPolarity: (mode: TerminalPolarity | null) => void
): () => void {
  const seam = renderer as unknown as ThemeModeSeam
  const replies: { foreground?: string; background?: string } = {}
  let last: TerminalPolarity | null = null
  let disposed = false

  const evaluate = () => {
    if (disposed) return
    const next = resolveProbedPolarity(seam.themeMode ?? null, replies)
    if (next === last) return
    last = next
    try {
      onPolarity(next)
    } catch (cause) {
      getLog().warn('chrome', 'theme polarity listener failed', { cause: String(cause) })
    }
  }

  const observe = (sequence: string): boolean => {
    if (!sequence.includes(']1')) return false
    const parsed = parseColorReplies(sequence)
    if (parsed.foreground) replies.foreground = parsed.foreground
    if (parsed.background) replies.background = parsed.background
    // Core's handler runs after this one; re-evaluate once it has applied.
    if (parsed.foreground || parsed.background) queueMicrotask(evaluate)
    return false
  }
  const onMode = () => evaluate()

  try {
    seam.prependInputHandler?.(observe)
    seam.on('theme_mode', onMode)
    seam.once('destroy', () => dispose())
    evaluate()
    void seam
      .waitForThemeMode?.(BOOT_WAIT_MS)
      .then(evaluate)
      .catch(() => {})
  } catch (cause) {
    getLog().warn('chrome', 'theme probe unavailable', { cause: String(cause) })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    try {
      seam.removeInputHandler?.(observe)
      seam.off?.('theme_mode', onMode)
    } catch {
      // teardown is best-effort
    }
  }
  return dispose
}
