/**
 * Renderer lifecycle — the Effect-side resource boundary (spec v4 §3.1).
 *
 * `acquireRelease(createCliRenderer)` so the renderer is always destroyed on
 * scope exit; a `Deferred` resolved on the renderer's "destroy" event lets the
 * entry block until the user quits. Mirrors opencode `app.tsx:177` /
 * `:185-225`.
 *
 * No throw / try-catch here: acquisition failure surfaces as a typed
 * `RendererError` via `Effect.tryPromise`'s `catch`.
 */
import { createCliRenderer, type CliRenderer, type KeyEvent, type Selection } from '@opentui/core'
import { Deferred, Effect } from 'effect'

import { RendererError } from './errors.ts'
import { installFfiCoordSafety } from './ffiSafe.ts'
import { getLog } from './log.ts'
import { installMultiClickSelection } from './multiClickSelect.ts'
import { installSyntaxStyleDegrade } from './nativeHandles.ts'

// Node-FFI seam: clamp negative draw coordinates BEFORE the u32 FFI marshaling
// (see ffiSafe.ts — scrolled-out <diff> line backgrounds crashed the render loop).
installFfiCoordSafety()
// Native handle-table seam: SyntaxStyle allocation failure (global 65,534-slot
// registry exhausted) degrades to an unstyled detached style instead of throwing
// out of a Solid mount effect (see nativeHandles.ts for the full root cause).
installSyntaxStyleDegrade()

/**
 * The text a finished selection copies: the RENDERED text the user highlighted,
 * verbatim (`getSelectedText()` does correct same-line merging). Markdown markers
 * are concealed in the pretty render, so a partial selection cannot recover source —
 * this copies exactly what was highlighted (the `/copy` command gives full source).
 * Total by construction — a copy must NEVER throw out of an input/event handler
 * (that would tear down the render loop).
 */
function selectionCopyText(selection: Selection): string {
  try {
    return selection.getSelectedText()
  } catch (cause) {
    getLog().warn('copy', 'getSelectedText failed', { cause: String(cause) })
    return ''
  }
}

export interface RendererOptions {
  /** Mouse tracking on/off (from decoded display config). */
  readonly mouse: boolean
  /** When true, an overlay/prompt owns Ctrl+C — global interrupt/quit is suppressed. */
  readonly isBlocked?: () => boolean
  /**
   * Ctrl+C handler (item 11). When set, it OWNS Ctrl+C while not blocked — the
   * entry's state machine decides interrupt-the-turn vs quit. When omitted, the
   * default is an immediate `renderer.destroy()` (quit).
   */
  readonly onCtrlC?: () => void
  /**
   * Copy a mouse selection (item 1). When there's a live selection, Ctrl+C copies
   * it (this callback) instead of interrupting/quitting — opencode's selection
   * key precedence (`app.tsx:388`). Receives the rendered text the user highlighted.
   */
  readonly onCopySelection?: (text: string) => void
  /** Hosted dashboard PTYs have no in-page restart path. Keep a raw SIGINT
   *  from destroying the renderer if terminal raw mode briefly drops. */
  readonly ignoreSigint?: boolean
}

/**
 * Acquire a CliRenderer inside the current scope and register its release.
 * Returns the renderer plus a Deferred that resolves when the renderer is
 * destroyed (user quit) — `await` it to keep the entry alive.
 */
export const acquireRenderer = Effect.fn('Renderer.acquire')(function* (options: RendererOptions) {
  const renderer = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        // Snapshot process error listeners so we can guard exactly the ones the
        // renderer installs (its `handleError` — see guardRendererErrorHandlers).
        const preexisting = snapshotErrorListeners()
        const created = await createCliRenderer({
          // Root canvas: TRANSPARENT by default — the terminal's own background
          // shows through (do not paint a "default dark" canvas; glitch hated
          // it). A skin's explicit ui_bg lands reactively via the header's
          // theme effect (view/header.tsx setBackgroundColor).
          // scrollbox clips growing output → no terminal-scrollback corruption (gotcha §8 #2).
          externalOutputMode: 'passthrough',
          targetFps: 60,
          // Don't let core's uncaught-error handler call the ALLOCATING
          // `console.show()` (0.4.1 public option; defaults true-in-dev). That
          // call needs a native handle, so under handle-table exhaustion — the
          // very condition being reported — it throws and exit-7-masks the
          // original error (the bench mem3000 postmortem). Disabling it removes
          // that failure mode at the source; `guardRendererErrorHandlers` below
          // stays as belt-and-suspenders (honest logging if any core handler
          // still throws), but is no longer load-bearing for the exit-7 mask.
          openConsoleOnError: false,
          // prompts own Ctrl+C → deny/cancel (gotcha §8 #6); the global quit is gated on !blocked.
          exitOnCtrlC: false,
          // OpenTUI's default exitSignals include SIGPIPE + SIGBUS, and its handler
          // calls renderer.destroy() — so a broken clipboard pipe (writeClipboard
          // spawning xclip/wl-copy that dies) raises SIGPIPE and QUITS THE TUI on
          // copy. SIGPIPE/SIGBUS are not shutdown intents; restrict to the genuine
          // termination signals so a stray pipe error can never tear down the UI.
          exitSignals: options.ignoreSigint
            ? ['SIGTERM', 'SIGQUIT', 'SIGHUP']
            : ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGHUP'],
          useKittyKeyboard: {},
          useMouse: options.mouse
        })
        guardRendererErrorHandlers(created, preexisting)
        // Editor-grade mouse selection: double-click word, triple-click line,
        // drag extends with the clicked span held (see multiClickSelect.ts).
        installMultiClickSelection(created)
        return created
      },
      catch: cause => new RendererError({ cause })
    }),
    renderer => Effect.sync(() => destroyRenderer(renderer))
  )

  const shutdown = yield* Deferred.make<void>()
  renderer.once('destroy', () => {
    Deferred.doneUnsafe(shutdown, Effect.void)
  })

  // Removing SIGINT from OpenTUI's exitSignals is not sufficient on its own:
  // with zero process listeners Node restores the OS default (terminate). Keep
  // one scoped no-op listener in hosted mode, exactly like Ink's ignoredSignals
  // lifecycle, and remove it with the renderer scope.
  if (options.ignoreSigint) {
    const ignoreSigint = () => {}
    process.on('SIGINT', ignoreSigint)
    yield* Effect.addFinalizer(() => Effect.sync(() => process.off('SIGINT', ignoreSigint)))
  }

  // Global quit on Ctrl+C. `exitOnCtrlC:false` hands Ctrl+C to us as a key event
  // (not SIGINT), so destroying here fires 'destroy' → resolves `shutdown` → the
  // entry scope closes → finalizers run: renderer teardown + the gateway layer's
  // `client.stop()` EOFs the Python child's stdin so it exits (no orphan). When a
  // blocking prompt is up, it owns Ctrl+C (→ deny/cancel) so we suppress the quit
  // (gotcha §8 #6) — the prompt's own handler sends the cancel reply.
  const isBlocked = options.isBlocked ?? (() => false)
  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (!(key.ctrl && key.name === 'c') || renderer.isDestroyed) return
    // Copy a live mouse selection first (item 1) — takes precedence over the
    // interrupt/quit machine and over a blocking prompt's cancel.
    if (options.onCopySelection) {
      const selection = renderer.getSelection()
      const text = selection ? selectionCopyText(selection) : ''
      if (text) {
        options.onCopySelection(text)
        renderer.clearSelection()
        return
      }
    }
    if (isBlocked()) return // an overlay/prompt owns Ctrl+C (close/cancel)
    if (options.onCtrlC) options.onCtrlC()
    else renderer.destroy()
  })

  // Copy-on-select (item 1 parity with free-code/Ink): the renderer's "selection"
  // event fires ONCE when a free-form mouse selection COMPLETES (drag finish);
  // auto-copy the spanned selectable text. Unlike the Ctrl+C path above we do NOT
  // clearSelection() — the highlight persists so the user sees what was copied and
  // Ctrl+C still works on it. `writeClipboard` is idempotent, so both paths writing
  // the same text is harmless (no double-write bug). `CliRenderer extends
  // EventEmitter`, so `on('selection', …)` is untyped → annotate `selection`.
  const onCopy = options.onCopySelection
  if (onCopy) {
    renderer.on('selection', (selection: Selection) => {
      const text = selectionCopyText(selection)
      if (text) onCopy(text)
    })
  }

  return { renderer, shutdown } as const
})

const CLEAR_SCREEN_AND_HOME = '\u001b[2J\u001b[H'

/**
 * Force a full OpenTUI repaint without suspending the renderer. `requestRender()`
 * alone can emit no bytes when the native diff still believes the old frame is
 * current. Invalidating both public frame buffers and clearing the terminal
 * forces the next scheduled frame to repaint every cell while preserving the
 * input parser (suspend/resume can drop later bytes from the same stdin chunk).
 */
export function redrawRenderer(
  renderer: CliRenderer,
  options: {
    readonly clearSelection?: boolean
    readonly output?: Pick<NodeJS.WriteStream, 'write'>
  } = {}
): void {
  if (renderer.isDestroyed) return
  if (options.clearSelection) {
    try {
      renderer.clearSelection()
    } catch {
      // Selection cleanup is cosmetic; repaint must continue.
    }
  }
  try {
    // Invalidate BOTH public frame buffers. Clearing only the terminal and
    // calling requestRender can emit no bytes when OpenTUI's native diff still
    // believes the old frame is current.
    renderer.currentRenderBuffer.clear()
    renderer.nextRenderBuffer.clear()
  } catch {
    // A concurrently-destroyed native buffer must not break input handling.
  }
  try {
    ;(options.output ?? process.stdout).write(CLEAR_SCREEN_AND_HOME)
  } catch {
    // A closed output stream still leaves requestRender as best effort.
  }
  try {
    renderer.requestRender()
  } catch {
    // Ignore a renderer that was concurrently destroyed.
  }
}

/** Best-effort renderer teardown; never throws out of the finalizer. */
function destroyRenderer(renderer: CliRenderer): void {
  try {
    if (!renderer.isDestroyed) renderer.destroy()
  } catch {
    // teardown is best-effort; a failed destroy must not mask the real exit cause.
  }
}

// ── honest-crash guard for the renderer's process error handlers ─────────────
//
// CliRenderer installs its own `uncaughtException`/`unhandledRejection` handler
// (`handleError`: console.error + console.show()). `console.show()` ALLOCATES —
// the console-overlay OptimizedBuffer needs a native handle — so under native
// handle-table exhaustion (the very condition being reported, see
// nativeHandles.ts) the handler itself throws `Failed to create optimized
// buffer: WxH`, and Node kills the process with exit 7, MASKING the original
// error (this is exactly the bench mem3000 postmortem). Wrap the listeners the
// renderer added so a handler failure is logged honestly and the original
// error stays the story; while the renderer is alive the process keeps running
// (core's own contract: handled uncaught exceptions don't exit).

type ProcessErrorEvent = 'uncaughtException' | 'unhandledRejection'
const PROCESS_ERROR_EVENTS: readonly ProcessErrorEvent[] = ['uncaughtException', 'unhandledRejection']
type ErrorListener = (...args: unknown[]) => void

// Node's typings don't accept the union event name in listeners/on/removeListener
// overloads — view the process emitter through a minimal untyped seam.
const proc = process as unknown as {
  listeners(event: ProcessErrorEvent): ErrorListener[]
  on(event: ProcessErrorEvent, listener: ErrorListener): void
  removeListener(event: ProcessErrorEvent, listener: ErrorListener): void
}

function snapshotErrorListeners(): ReadonlyMap<ProcessErrorEvent, ReadonlySet<unknown>> {
  return new Map(PROCESS_ERROR_EVENTS.map(event => [event, new Set(proc.listeners(event))]))
}

/** Re-wrap the error listeners `createCliRenderer` added (delta vs the snapshot)
 *  so an exception INSIDE them can never exit-7-mask the original error. */
function guardRendererErrorHandlers(
  renderer: CliRenderer,
  preexisting: ReadonlyMap<ProcessErrorEvent, ReadonlySet<unknown>>
): void {
  for (const event of PROCESS_ERROR_EVENTS) {
    const before = preexisting.get(event)
    for (const listener of proc.listeners(event)) {
      if (before?.has(listener)) continue
      proc.removeListener(event, listener)
      const guarded: ErrorListener = (...args) => {
        // After teardown the renderer can no longer report anything — rethrow so
        // the ORIGINAL error reaches Node's default fatal path unmasked.
        if (renderer.isDestroyed) throw args[0]
        try {
          listener(...args)
        } catch (handlerFailure) {
          try {
            const original = args[0]
            getLog().error('renderer', 'core error handler crashed while reporting an uncaught error', {
              original: original instanceof Error ? (original.stack ?? original.message) : String(original),
              handlerFailure: String(handlerFailure)
            })
          } catch {
            // logging is best-effort — never throw out of an exception handler.
          }
        }
      }
      proc.on(event, guarded)
    }
  }
}
