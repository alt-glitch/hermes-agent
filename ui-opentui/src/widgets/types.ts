import type { Theme } from '../logic/theme.ts'
import type { WNode } from './element.ts'

/**
 * The native widget-app contract — the SAME authoring contract as the Ink
 * engine's `ui-tui/src/sdk/types.ts` (the tui-widgets skill documents it once
 * for both engines). A user widget file default-exports `register(sdk)` and
 * calls `sdk.defineWidgetApp({...})`; this module defines what that object is.
 */

/** One keypress, as the input pipeline delivers it (Ink `Key` field names —
 *  the shared template contract reads `key.escape`, `key.ctrl`, …). */
export interface WidgetKey {
  ctrl: boolean
  meta: boolean
  shift: boolean
  escape: boolean
  return: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageUp: boolean
  pageDown: boolean
}

export interface WidgetInput {
  ch: string
  key: WidgetKey
}

export interface WidgetRenderCtx<S> {
  /** Terminal columns available to the app. */
  cols: number
  /** Terminal rows available to the app. */
  rows: number
  state: S
  t: Theme
}

/**
 * A widget app: a self-contained surface with its own state, input reducer,
 * and render. Contract (identical to Ink):
 * - `init(arg)` parses the launch argument (slash-command tail) into initial
 *   state; `null` refuses the launch and the launcher prints `usage`.
 * - `reduce(state, input)` (modal only) returns the next state, the SAME
 *   reference to swallow the key unchanged, or `null` to close the app.
 * - `render(ctx)` returns an element tree built with the sdk's `h` +
 *   primitives (`Box`, `Text`, `Dialog`, …).
 */
export interface WidgetApp<S = unknown> {
  id: string
  /** One-line description — surfaces in `/` completions and command help. */
  help: string
  /**
   * `modal` (default): owns every keypress, blocks the composer.
   * `ambient`: glanceable panel — no input capture, no blocking; launching
   * the same id again toggles it closed.
   */
  mode?: 'ambient' | 'modal'
  /** Ambient placement. The native engine reserves in-flow dock rows only:
   *  corner/rail zones map to the nearest dock (`top-*` → `dock-top`,
   *  `bottom-*` → `dock-bottom`). Default `dock-bottom`. */
  zone?: AmbientZone
  /** Card width in cells (ambient). Default 44. */
  width?: number
  init(arg: string): null | S
  reduce(state: S, input: WidgetInput): null | S
  render(ctx: WidgetRenderCtx<S>): WNode
  usage?: string
}

/** Where an ambient widget asks to live (shared zone vocabulary with Ink). */
export type AmbientZone = 'bottom-left' | 'bottom-right' | 'dock-bottom' | 'dock-top' | 'top-left' | 'top-right'

/** The host's serializable record of an active app. */
export interface ActiveWidget {
  appId: string
  state: unknown
}

/** Ctrl+<letter> test, shared so app reducers match the core pipeline. */
export const isCtrl = (key: { ctrl: boolean }, ch: string, target: string): boolean =>
  key.ctrl && ch.toLowerCase() === target
