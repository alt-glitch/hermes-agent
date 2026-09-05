/**
 * test/lib/render.ts — headless renderable verification helpers (spec v4 §5
 * Layer 2). Wraps the Solid binding's `testRender` + the settle dance.
 *
 * Settling needs care: Solid mounts async; a `<scrollbox>` needs a couple of
 * passes to measure content + apply stickyStart; and the native `<markdown>`
 * (Tree-sitter) tokenizes ASYNCHRONOUSLY — a plain `renderOnce` loop captures
 * before its text paints. So we `flush()` (wait until scheduled rendering
 * settles) between passes, and `captureFrame` can wait for specific content via
 * `until` (retries with `waitForFrame`) for markdown-bearing frames.
 *
 * `exitOnCtrlC: false` is forced (gotcha §8 #7 — the test renderer defaults true
 * and would tear down on the first simulated Ctrl+C, blanking later frames).
 *
 * Keymap (Phase 3): overlays/prompts register close layers via `@opentui/keymap`,
 * whose hooks throw without a `<KeymapProvider>`. The entry provides one in the
 * real app; here we provide a test keymap built from the test renderer (read via
 * `useRenderer()` inside the tree) so headless mounts of those views work.
 */
import type { CapturedFrame } from '@opentui/core'
import type { TestRendererSetup } from '@opentui/core/testing'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { KeymapProvider } from '@opentui/keymap/solid'
import { testRender, useRenderer } from '@opentui/solid'
import type { JSX } from '@opentui/solid'
import { createMemo } from 'solid-js'

import { installFfiCoordSafety } from '../../boundary/ffiSafe.ts'
import { installMultiClickSelection } from '../../boundary/multiClickSelect.ts'

// Headless renders go through the same node:ffi seam as the live TUI — install
// the negative-coordinate shim here too (the live path installs it in
// boundary/renderer.ts, which tests don't import).
installFfiCoordSafety()

/** Wrap a node in a KeymapProvider whose keymap is bound to the test renderer. */
function withKeymap(node: () => JSX.Element): () => JSX.Element {
  return () => {
    const renderer = useRenderer()
    const keymap = createMemo(() => createDefaultOpenTuiKeymap(renderer))
    return KeymapProvider({
      keymap: keymap(),
      get children() {
        return node()
      }
    })
  }
}

export interface RenderProbe {
  readonly frame: () => string
  /** Styled spans of the current frame (per-span fg/bg/attributes) — for
   *  asserting COLOR, e.g. the composer's slash-token highlight (Epic 6). */
  readonly spans: () => CapturedFrame
  readonly waitForFrame: (predicate: (frame: string) => boolean) => Promise<string>
  readonly resize: (width: number, height: number) => void
  /** Left-click at screen cell (x, y) via the mock mouse, then settle a pass. */
  readonly click: (x: number, y: number) => Promise<void>
  /** The raw mock mouse (pressDown / moveTo / release / doubleClick / …) for
   *  multi-click + drag scenarios — pair with `settle()`. */
  readonly mouse: TestRendererSetup['mockMouse']
  /** The live selection's copyable text ('' when there is none). */
  readonly selectedText: () => string
  /** Mouse-wheel at screen cell (x, y) via the mock mouse, then settle a pass. */
  readonly scroll: (x: number, y: number, direction: 'up' | 'down') => Promise<void>
  /** The mock keyboard (typeText / pressArrow / pressEnter / …) — pair with `settle()`. */
  readonly keys: TestRendererSetup['mockInput']
  /** The live test renderer (e.g. `getSelection()` assertions). */
  readonly renderer: TestRendererSetup['renderer']
  /** Run a render pass + flush so simulated input lands in the next `frame()`. */
  readonly settle: () => Promise<void>
  readonly destroy: () => void
}

/** Mount a Solid node headlessly and return a probe with a settled first frame. */
export async function renderProbe(
  node: () => JSX.Element,
  options?: { width?: number; height?: number; kittyKeyboard?: boolean }
): Promise<RenderProbe> {
  const setup = await testRender(withKeymap(node), {
    width: options?.width ?? 80,
    height: options?.height ?? 24,
    exitOnCtrlC: false,
    // kitty protocol makes a SIMULATED lone ESC parse deterministically (legacy
    // input leaves it in the escape-sequence ambiguity window forever — the mock
    // never flushes it), so keyboard-driven tests can press Escape.
    kittyKeyboard: options?.kittyKeyboard ?? false
  })
  // Same multi-click selection seam as the live renderer (boundary/renderer.ts
  // installs it after createCliRenderer) so mouse tests exercise the shim.
  try {
    installMultiClickSelection(setup.renderer)
    // Forced passes verify settled layout, not whether live work schedules paint.
    // Use waitForFrame after mounted updates for that separate contract.
    await setup.renderOnce()
    await setup.flush()
    await setup.waitForVisualIdle()
    await setup.renderOnce()
    await setup.flush()
  } catch (error) {
    setup.renderer.destroy()
    throw error
  }

  return {
    frame: () => setup.captureCharFrame(),
    spans: () => setup.captureSpans(),
    waitForFrame: predicate => setup.waitForFrame(predicate),
    resize: (width, height) => setup.resize(width, height),
    click: async (x, y) => {
      await setup.mockMouse.click(x, y)
      await setup.renderOnce()
      await setup.flush()
    },
    mouse: setup.mockMouse,
    selectedText: () => {
      try {
        return setup.renderer.getSelection()?.getSelectedText() ?? ''
      } catch {
        return ''
      }
    },
    scroll: async (x, y, direction) => {
      await setup.mockMouse.scroll(x, y, direction)
      await setup.renderOnce()
      await setup.flush()
    },
    keys: setup.mockInput,
    renderer: setup.renderer,
    settle: async () => {
      await setup.renderOnce()
      await setup.flush()
    },
    destroy: () => setup.renderer.destroy?.()
  }
}

/**
 * Mount, capture one settled frame, tear down. When `until` is given (string or
 * RegExp), waits for the frame to contain/match it first — use for async
 * markdown content that may not be painted on the first settled pass.
 */
export async function captureFrame(
  node: () => JSX.Element,
  options?: { width?: number; height?: number; until?: string | RegExp }
): Promise<string> {
  const probe = await renderProbe(node, options)
  try {
    const until = options?.until
    if (until !== undefined) {
      const match = (frame: string) => (typeof until === 'string' ? frame.includes(until) : until.test(frame))
      return await probe.waitForFrame(match)
    }
    return probe.frame()
  } finally {
    probe.destroy()
  }
}
