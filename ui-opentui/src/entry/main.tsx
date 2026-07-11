/**
 * Entry — the single boundary edge (spec v4 §3.1). This is the ONE place that:
 *   - acquires the renderer (acquireRelease + Deferred-on-destroy),
 *   - creates the Solid store,
 *   - wires GatewayService.subscribe -> store.apply  (Effect->Solid contact #2),
 *   - does the one-line `render(() => <App/>, renderer)` bridge (contact #1),
 *   - (live) bootstraps a session and optionally submits an initial prompt,
 *   - blocks until the renderer is destroyed (user quit),
 * and at the bottom PROVIDES the layers and runs (`Effect.provide(AppLayer)`).
 *
 * Backend selection (import.meta.main):
 *   - default            → the LIVE `liveGatewayLayer` (spawns the real Python
 *     `tui_gateway`); after `gateway.ready` it `session.create`s and, if an
 *     initial prompt is given (HERMES_TUI_PROMPT or argv), `prompt.submit`s it.
 *     The composer lands in Phase 2 — until then the initial prompt is how a
 *     streamed reply is driven into the transcript (spec Phase-1 smoke).
 *   - HERMES_TUI_FAKE=1  → the scripted FakeGateway "hello" (offline dev/CI).
 *
 * The body of `run` does not change when the backend swaps — that's the point of
 * the layer; only `makeAppLayer(...)` differs at the edge.
 */
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { KeymapProvider } from '@opentui/keymap/solid'
import { render } from '@opentui/solid'
import { Cause, Deferred, Duration, Effect } from 'effect'
import { writeFileSync } from 'node:fs'
import type { KeyEvent } from '@opentui/core'

import { readClipboardImage, writeClipboard } from '../boundary/clipboard.ts'
import { GatewayService, type GatewayServiceShape } from '../boundary/gateway/GatewayService.ts'
import { liveGatewayLayer } from '../boundary/gateway/liveGateway.ts'
import { getLog } from '../boundary/log.ts'
import { startMemlog } from '../boundary/memlog.ts'
import { startMemoryMonitor } from '../boundary/memoryMonitor.ts'
import { startProactiveGc } from '../boundary/proactiveGc.ts'
import { registerRemoteParsers } from '../boundary/parsers.ts'
import { acquireRenderer, redrawRenderer } from '../boundary/renderer.ts'
import { decodeCommandsCatalogResponse } from '../boundary/schema/SessionCommandResponses.ts'
import { makeAppLayer } from '../boundary/runtime.ts'
import { createSession, replaceSession, resumeSession } from '../boundary/sessionLifecycle.ts'
import { nthAssistantResponse } from '../logic/copy.ts'
import { presentBillingVerification } from '../logic/billingVerification.ts'
import { performHeapdump } from '../logic/diagnostics.ts'
import {
  dashboardTuiMode,
  envFlag,
  heapdumpOnStart,
  launchCwd,
  noConfirmDestructive,
  resolveMouseEnabled,
  startupImage,
  startupPrompt,
  STARTUP_IMAGE_DEFAULT_PROMPT
} from '../logic/env.ts'
import { createPromptHistory, dirHistoryPersister, loadDirHistory } from '../logic/history.ts'
import { actionExitBlocked, DASHBOARD_NEW_SESSION_MESSAGE, isExitHotkey, isRedrawHotkey } from '../logic/hotkeys.ts'
import { parseProcessList } from '../logic/backgroundActivity.ts'
import { eventMayEnterStore } from '../logic/eventScope.ts'
import { createPasteStore } from '../logic/pastes.ts'
import {
  planTransitionDrain,
  SESSION_TRANSITION_QUEUE_LIMIT,
  type TransitionSubmission
} from '../logic/transitionQueue.ts'
import {
  classifySubmit,
  catalogCommandItems,
  clientCommandNames,
  createCompletionGate,
  dispatchSlash,
  mapCompletions,
  mapModelOptions,
  planCompletion,
  readReplaceFrom,
  registerModelPrefetch,
  type SlashContext
} from '../logic/slash.ts'
import { createSessionStore, type SessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { refreshLearnedNames, seedLearnedNames } from '../view/composer.tsx'
import { TerminalChrome } from '../view/terminalChrome.tsx'

// Syntax-highlighting language expansion: register the remote tree-sitter
// grammars (python/rust/go/bash/json/c/html/css/yaml/toml) before the first
// <code>/<markdown> mount initializes the global tree-sitter client. Grammars
// are fetched from GitHub on first use and cached under HERMES_TUI_PARSER_CACHE.
registerRemoteParsers()
import type { SessionPickerOps } from '../view/overlays/sessionPicker.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { makeFakeGatewayLayer, type FakeGatewayController } from './fakeGateway.ts'

export interface TuiInput {
  /** Mouse tracking on/off. */
  readonly mouse: boolean
  /** Skip the live session bootstrap (the fake backend drives the stream itself). */
  readonly fake: boolean
  /** Terminal width passed to `session.create` (Ink uses the live cols; 80 is a fine default). */
  readonly cols: number
  /** Optional initial prompt submitted once the session is ready — the Phase-1 stand-in for the composer. */
  readonly initialPrompt?: string
  /** Optional image PATH attached (image.attach) before the initial prompt — `hermes --tui --image <path>`. */
  readonly initialImage?: string
  /** Resume a session instead of creating one: a session id, 'recent'/'last'
   *  (→ session.most_recent), or 'picker' (bare `--resume` — open the resume
   *  picker BEFORE any session.create; create stays lazy). */
  readonly resumeId?: string
}

const READY_POLL = Duration.millis(100)
const READY_TIMEOUT_MS = 20_000
/** Window after a Ctrl+C in which a second Ctrl+C quits the TUI (item 11). */
const QUIT_WINDOW_MS = 3_000

/** Recursive renderable count under a node (the /mem store-cap diagnostic —
 *  same walk as scripts/mem-bench.tsx; cheap: one tree pass on demand). */
function descendantCount(node: { getChildren(): unknown[] }): number {
  let n = 0
  for (const child of node.getChildren()) {
    n += 1
    if (child && typeof child === 'object' && 'getChildren' in child) {
      n += descendantCount(child as { getChildren(): unknown[] })
    }
  }
  return n
}

/**
 * Resume a session INTO the store: buffer live events across the `session.resume`
 * RPC, then replace history + replay (gotcha §8 #5 tool rows handled by
 * the boundary's ordered history mapper). Shared by launch and switching.
 * Timed (rpc_ms / hydrate_ms) for the resume profile.
 */
/**
 * Record the CURRENT session id in `HERMES_TUI_ACTIVE_SESSION_FILE` (item #5).
 * The launcher reads this on exit to print the right "Resume this session with…"
 * epilogue (hermes_cli/main.py `_print_tui_exit_summary`). The Ink TUI writes it on
 * every session change (useSessionLifecycle.writeActiveSessionFile); the native
 * engine must too, or the launcher falls back to the INITIAL launch session and
 * shows resume info for the wrong session after a `/session` switch.
 */
const writeActiveSession = (sid: string | undefined) => {
  const file = process.env.HERMES_TUI_ACTIVE_SESSION_FILE
  if (!file) return
  try {
    writeFileSync(file, JSON.stringify(sid ? { session_id: sid } : { detached: true, session_id: null }), {
      mode: 0o600
    })
  } catch (cause) {
    getLog().warn('bootstrap', 'active-session-file write failed', { cause: String(cause) })
  }
}

const resumeInto = (gateway: GatewayServiceShape, store: SessionStore, sid: string, cols: number) =>
  Effect.gen(function* () {
    const resumed = yield* resumeSession(gateway, store, {
      cols,
      targetSessionId: sid
    })
    // The launcher resumes by the persisted DB id (`resumed`), while all live
    // RPC/event routing uses the ephemeral `session_id` returned above.
    writeActiveSession(resumed.resumedId)
    getLog().info('bootstrap', 'session resumed', {
      count: resumed.messageCount,
      hydrate_ms: resumed.hydrateMs,
      rpc_ms: resumed.rpcMs,
      resumed: resumed.resumedId,
      sid: resumed.sessionId
    })
    if (resumed.previousSessionId) {
      Effect.runFork(
        gateway
          .request('session.close', { session_id: resumed.previousSessionId })
          .pipe(
            Effect.catchCause(cause =>
              Effect.sync(() => getLog().warn('resume', 'previous session close failed', { cause: String(cause) }))
            )
          )
      )
    }
    return resumed.sessionId
  })

/**
 * Post-session setup, shared by every way a session comes to exist (create,
 * boot resume, boot-picker pick): the tools/skills/MCP catalog for the home
 * panel (item 9 — best-effort), the optional initial prompt, and the `/model`
 * catalog prefetch (Epic 7 instant open: `model.options` is the slow RPC —
 * network pricing fetch + Nous tier check — so pay it ONCE in an already-
 * forked fiber; the promise is STASHED in the slash seam so an early `/model`
 * awaits THIS request instead of doubling it).
 */
const postSessionSetup = (
  gateway: GatewayServiceShape,
  store: SessionStore,
  sid: string,
  initialPrompt?: string,
  initialImage?: string
) =>
  Effect.gen(function* () {
    const isActive = () => gateway.sessionId() === sid && store.state.sessionId === sid
    const catalog = yield* gateway
      .request<unknown>('startup.catalog', { session_id: sid })
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (catalog && isActive()) store.setCatalog(catalog)

    // Seed the composer's slash-highlight catalog ONCE at boot (glitch
    // 2026-06-14): `commands.catalog` returns the full uncapped command + skill
    // name list ({pairs:[["/name","desc"],…]}); feeding the names through
    // seedLearnedNames means a cold `/command` highlights on the first keystroke
    // instead of only after its completion batch was browsed earlier. Best-effort
    // — a failure just leaves the old lazy-learn behavior.
    const cmdCatalog = yield* gateway
      .request<unknown>('commands.catalog', {})
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    const decodedCommandCatalog = decodeCommandsCatalogResponse(cmdCatalog)
    if (isActive() && decodedCommandCatalog) {
      store.setCommandCatalog(decodedCommandCatalog)
      seedLearnedNames([
        ...catalogCommandItems(decodedCommandCatalog),
        ...clientCommandNames().map(name => ({ text: `/${name}` }))
      ])
      const warning = decodedCommandCatalog.warning?.trim()
      if (warning) store.pushSystem(`command catalog warning: ${warning}`)
    }

    // A session switch may have completed while either best-effort catalog RPC
    // was in flight. Never attach an image, submit a prompt, or publish a cache
    // into the successor session from this stale setup fiber.
    if (!isActive()) return

    // Seeded image (`hermes --tui --image <path>`): attach BEFORE submitting, so
    // the next prompt.submit picks it up — exact Ink parity (createGatewayEventHandler
    // scheduleStartupPrompt: image.attach then submit; default prompt when image-only).
    const image = initialImage?.trim()
    if (image) {
      yield* gateway.request('image.attach', { path: image, session_id: sid }).pipe(
        Effect.catchCause(cause =>
          Effect.sync(() => {
            getLog().warn('bootstrap', 'startup image attach failed', { cause: String(cause) })
            store.pushSystem(`startup image attach failed: ${String(cause)}`)
          })
        )
      )
    }

    const prompt = initialPrompt?.trim() || (image ? STARTUP_IMAGE_DEFAULT_PROMPT : undefined)
    if (prompt) {
      store.pushUser(prompt)
      yield* gateway.request('prompt.submit', { session_id: sid, text: prompt })
    }

    const prefetch = Effect.runPromise(
      gateway
        .request<unknown>('model.options', { session_id: sid })
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    ).then(modelOpts => {
      const modelItems = mapModelOptions(modelOpts)
      if (modelItems.length && isActive()) store.setModelItems(modelItems)
    })
    registerModelPrefetch(prefetch)
    yield* Effect.promise(() => prefetch)
  })

/** Create a FRESH session + run the post-session setup (the default boot path;
 *  also the boot-picker's Esc fallback — closing the picker without a pick
 *  must still leave a usable session behind). */
const createFreshSession = (gateway: GatewayServiceShape, store: SessionStore, input: TuiInput) =>
  Effect.gen(function* () {
    const created = yield* createSession(gateway, {
      cols: input.cols,
      // The launch directory IS the workspace choice in a terminal (you cd'd
      // here) — passing it makes the gateway treat it as explicit, so the
      // session row gets a persisted cwd on first message, the chrome bar shows
      // the right dir, and /sessions groups this directory's sessions first.
      // NOT process.cwd(): the hermes launcher runs this engine with cwd set to
      // its own package dir (ui-opentui), so process.cwd() would be the engine
      // dir. The launcher exports the REAL launch dir as HERMES_CWD / the
      // gateway's TERMINAL_CWD; prefer those, falling back to process.cwd()
      // only when launched standalone (smokes/dev). (Desktop omits cwd — its
      // launch dir is meaningless; see _ensure_session_db_row.)
      cwd: launchCwd()
    })
    if (created.info) store.applyInfo(created.info)
    writeActiveSession(created.resumeId) // persisted id for launcher/recovery (#5)
    store.setSessionId(created.sessionId)
    store.setResumeId(created.resumeId)
    getLog().info('bootstrap', 'session created', { resumeId: created.resumeId, sid: created.sessionId })
    yield* postSessionSetup(gateway, store, created.sessionId, input.initialPrompt, input.initialImage)
  })

/**
 * Live session bootstrap: wait for the unsolicited `gateway.ready` handshake,
 * then either RESUME a session (hydrate its transcript — incl. tool rows — via
 * the snapshot, buffering live events across the RPC), open the resume PICKER
 * (`resumeId === 'picker'` — bare `--resume`: no session is created until the
 * user picks or closes; create is lazy), or CREATE a fresh one, and (if given)
 * submit the initial prompt. Forked into the entry scope so it runs
 * concurrently with the render + the quit-await. Any failure is logged and
 * swallowed — a bootstrap hiccup must never tear down the rendered UI.
 */
const bootstrapSession = (gateway: GatewayServiceShape, store: SessionStore, input: TuiInput) =>
  Effect.gen(function* () {
    const log = getLog()
    let waited = 0
    while (!store.state.ready && waited < READY_TIMEOUT_MS) {
      yield* Effect.sleep(READY_POLL)
      waited += 100
    }
    if (!store.state.ready) {
      log.warn('bootstrap', 'no gateway.ready within timeout', { waited })
      return
    }

    if (input.resumeId === 'picker') {
      // Boot picker (design doc §A): opens BEFORE any session.create. The pick
      // resumes via onResume (which then runs postSessionSetup); a close
      // without a pick falls back to createFreshSession (onSessionPickerClosed).
      store.openSessionPicker('recent')
      return
    }

    if (input.resumeId) {
      let sid: string | undefined = input.resumeId
      if (sid === 'recent' || sid === 'last') {
        const recent = yield* gateway.request<{ session_id?: string }>('session.most_recent', {})
        sid = recent.session_id
      }
      if (!sid) {
        log.warn('bootstrap', 'no session to resume', { resumeId: input.resumeId })
        return
      }
      const liveSessionId = yield* resumeInto(gateway, store, sid, input.cols)
      yield* postSessionSetup(gateway, store, liveSessionId, input.initialPrompt, input.initialImage)
      return
    }

    yield* createFreshSession(gateway, store, input)
  }).pipe(Effect.catchCause(cause => Effect.sync(() => getLog().warn('bootstrap', 'failed', { cause: String(cause) }))))

/** The entry Effect. Mirrors opencode `app.tsx:177` `run = Effect.fn("Tui.run")`. */
export const run = Effect.fn('Tui.run')(function* (input: TuiInput) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      // Solid side: the store + reducer. Created here, lives in Solid-land.
      const store = createSessionStore()

      // Prompt history (item 6): scoped to the launch directory so prior prompts
      // from the same project dir are recallable (Up/Down), without bleeding
      // across different dirs. process.cwd() is the user's launch dir under the
      // real launcher.
      const historyCwd = process.cwd()
      const history = createPromptHistory({
        initial: loadDirHistory(historyCwd),
        persist: dirHistoryPersister(historyCwd)
      })

      // Pasted-text store — created ONCE here so it survives the composer
      // remounting (overlay open/close); a per-composer store would lose a
      // pending `[Pasted text #N]` mid-compose and submit would send it literally.
      const pasteStore = createPasteStore()

      // Contact point #2: boundary pushes decoded events into the Solid store.
      // The callback ALSO drives auto-heal re-resume: a post-crash gateway.ready
      // (i.e. one that follows a gateway.exited, so `recoverSid` is set) re-resumes
      // the session so the transcript continues. The INITIAL gateway.ready has
      // `recoverSid === undefined`, so the normal bootstrap path is untouched.
      const gateway = yield* GatewayService

      // Side effects run only when the store actually commits an event. In
      // particular, a billing verification received during resume buffering is
      // delayed until SID filtering accepts it; stale-session events never open
      // a browser or leak their code into the successor transcript.
      store.registerCommittedEventHandler(event => {
        if (event.type === 'billing.step_up.verification') {
          presentBillingVerification(event.payload, { pushSystem: text => store.pushSystem(text) })
        }
      })

      let sessionTransitionInFlight = false
      const isSessionTransitioning = () => sessionTransitionInFlight
      let imageAttachInFlight = false
      const transitionSubmissions: TransitionSubmission[] = []
      let drainTransitionSubmissions: () => void = () => {}

      const reportFailedTransitionSubmissions = (): void => {
        if (transitionSubmissions.length === 0) return
        const liveSessionId = gateway.sessionId()
        if (liveSessionId && store.state.sessionId === liveSessionId) {
          const dropped = transitionSubmissions.splice(0).length
          store.pushSystem(`${dropped} queued submission(s) not sent — the previous session remains active`)
          return
        }
        store.pushSystem(
          `${transitionSubmissions.length} queued submission(s) held for the next successful session switch`
        )
      }

      const guardBusySessionSwitch = (what = 'switch sessions'): boolean => {
        if (store.state.info.running || store.isTurnInFlight()) {
          store.pushSystem(`interrupt the current turn before trying to ${what}`)
          return true
        }
        if (imageAttachInFlight) {
          store.pushSystem('wait for the image attachment before trying to switch sessions')
          return true
        }
        if (sessionTransitionInFlight) {
          store.pushSystem('a session switch is already in progress')
          return true
        }
        return false
      }

      let recoverSid: string | undefined
      let recoveryRetryTimer: ReturnType<typeof setTimeout> | undefined

      const schedulePendingRecovery = (): void => {
        if (recoveryRetryTimer) return
        recoveryRetryTimer = setTimeout(() => {
          recoveryRetryTimer = undefined
          const sid = recoverSid
          if (!sid) return
          if (sessionTransitionInFlight) {
            schedulePendingRecovery()
            return
          }
          recoverSid = undefined
          startRecovery(sid)
        }, 100)
      }

      const startRecovery = (resumeId: string): void => {
        if (sessionTransitionInFlight) {
          recoverSid = resumeId
          schedulePendingRecovery()
          return
        }
        sessionTransitionInFlight = true
        store.setHint('recovering session…')
        let transitionSucceeded = false
        Effect.runFork(
          Effect.gen(function* () {
            const liveSessionId = yield* resumeInto(gateway, store, resumeId, input.cols)
            transitionSucceeded = true
            Effect.runFork(
              postSessionSetup(gateway, store, liveSessionId).pipe(
                Effect.catchCause(cause =>
                  Effect.sync(() => getLog().warn('recover', 'post-resume setup failed', { cause: String(cause) }))
                )
              )
            )
          }).pipe(
            Effect.catchCause(cause =>
              Effect.sync(() => {
                const error = Cause.squash(cause)
                const detail = error instanceof Error ? error.message : String(error)
                getLog().warn('recover', 'resume failed', { cause: detail })
                store.pushSystem(`recovery failed: ${detail} — use /resume to retry`)
              })
            ),
            Effect.ensuring(
              Effect.sync(() => {
                sessionTransitionInFlight = false
                if (store.state.hint === 'recovering session…') store.setHint(undefined)
                if (transitionSucceeded) {
                  drainTransitionSubmissions()
                } else reportFailedTransitionSubmissions()
                if (recoverSid) schedulePendingRecovery()
              })
            )
          )
        )
      }

      yield* gateway.subscribe(event => {
        if (!eventMayEnterStore(event, gateway.sessionId(), store.isBuffering())) return
        store.apply(event)
        if (event.type === 'gateway.exited') {
          recoverSid = store.state.resumeId
        } else if (event.type === 'gateway.ready' && recoverSid !== undefined) {
          const sid = recoverSid
          recoverSid = undefined
          startRecovery(sid)
        }
      })

      // ── Ctrl+C state machine (item 11) ──────────────────────────────────
      // While a turn runs, the first Ctrl+C STOPS the agent (session.interrupt);
      // a second Ctrl+C within QUIT_WINDOW_MS (or when idle) KILLS the TUI. The
      // debounce stops a stray Ctrl+C from nuking the session (opencode's
      // double-press model; the user's preferred behaviour).
      let quitArmed = false
      let quitTimer: ReturnType<typeof setTimeout> | undefined
      let doQuit = (_code = 0) => {} // assigned once the renderer exists
      const hostedDashboard = dashboardTuiMode()
      const disarmQuit = () => {
        quitArmed = false
        if (quitTimer) clearTimeout(quitTimer)
        quitTimer = undefined
        store.setHint(undefined)
      }
      const armQuit = (message: string) => {
        quitArmed = true
        store.setHint(message)
        if (quitTimer) clearTimeout(quitTimer)
        quitTimer = setTimeout(disarmQuit, QUIT_WINDOW_MS)
      }
      const interruptTurn = () => {
        const sid = gateway.sessionId()
        if (!sid) return
        Effect.runFork(
          gateway
            .request('session.interrupt', { session_id: sid })
            .pipe(
              Effect.catchCause(cause =>
                Effect.sync(() => getLog().warn('interrupt', 'failed', { cause: String(cause) }))
              )
            )
        )
      }
      const requestDashboardNewSession = () => {
        const sid = gateway.sessionId()
        store.pushSystem(DASHBOARD_NEW_SESSION_MESSAGE)
        Effect.runFork(
          gateway
            .request('dashboard.new_session_requested', {
              reason: 'idle_exit_hotkey',
              session_id: sid ?? ''
            })
            .pipe(
              Effect.catchCause(cause =>
                Effect.sync(() => {
                  getLog().warn('dashboard', 'new-session request failed', { cause: String(cause) })
                  store.pushSystem('dashboard new-session request failed — use /new to retry')
                })
              )
            )
        )
      }
      const onCtrlC = () => {
        // Busy Ctrl+C ONLY interrupts (Ink parity). It must not leave a sticky
        // hosted hint that masks subsequent status lines.
        if (store.state.info.running) {
          interruptTurn()
          if (!hostedDashboard) armQuit('⏹ stopped — Ctrl+C again to quit')
          return
        }
        // An idle non-empty composer clears before any exit gesture, matching
        // Ink's input-first Ctrl+C precedence.
        if (store.state.composerDraft) {
          store.clearComposerDraft()
          disarmQuit()
          return
        }
        // Dashboard PTYs cannot be destroyed and restarted in-page. Publish the
        // same sidecar-mirrored event as Ink so the browser forges a fresh PTY.
        if (hostedDashboard) {
          requestDashboardNewSession()
          return
        }
        if (quitArmed) {
          disarmQuit()
          doQuit(0)
          return
        }
        armQuit('Ctrl+C again to quit')
      }

      // Transient hint that auto-clears (used by copy/image-paste feedback).
      const flashHint = (message: string, ms = 1500) => {
        store.setHint(message)
        setTimeout(() => {
          if (store.state.hint === message) store.setHint(undefined)
        }, ms)
      }

      // Copy a mouse selection to the clipboard (item 1) — OSC 52 + native command.
      // Copies exactly the rendered text the user highlighted (markers are concealed
      // in the pretty render; the `/copy` command copies a full response's source).
      const onCopySelection = (text: string) => {
        void writeClipboard(text)
        flashHint('Copied selection')
      }

      // Paste an IMAGE (item 1): read the clipboard image and attach it to the
      // session (image.attach_bytes); the next prompt.submit picks it up.
      const onImagePaste = () => {
        void (async () => {
          if (isSessionTransitioning()) {
            flashHint('Session switch in progress', 2000)
            return
          }
          const img = await readClipboardImage()
          if (!img) {
            flashHint('No image in clipboard', 2000)
            return
          }
          const sid = gateway.sessionId()
          if (isSessionTransitioning()) {
            flashHint('Session switch in progress', 2000)
            return
          }
          if (!sid) {
            flashHint('No session for image', 2000)
            return
          }
          imageAttachInFlight = true
          try {
            await Effect.runPromise(
              gateway.request('image.attach_bytes', {
                content_base64: img.data,
                filename: 'pasted.png',
                session_id: sid
              })
            )
            flashHint('🖼 image attached — type a message and send', 3000)
          } catch {
            flashHint('Image attach failed', 2000)
          } finally {
            imageAttachInFlight = false
          }
        })()
      }

      // A blocking prompt owns Ctrl+C (→ cancel); otherwise the state machine above runs.
      const { renderer, shutdown } = yield* acquireRenderer({
        mouse: input.mouse,
        ignoreSigint: hostedDashboard,
        isBlocked: () => actionExitBlocked(store.state),
        onCtrlC,
        onCopySelection
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (recoveryRetryTimer) clearTimeout(recoveryRetryTimer)
          recoveryRetryTimer = undefined
        })
      )
      // Fleet memory self-sampling (HERMES_TUI_MEMLOG / diagnostics master
      // switch — boundary/memlog.ts). Scoped acquire→release like the renderer.
      const stopMemlog = startMemlog()
      yield* Effect.addFinalizer(() => Effect.sync(stopMemlog))
      // Proactive idle GC (W2) — opt-in via a low HERMES_TUI_HEAP_MB (no-op on
      // the default path). Idle-gated on the store's streaming flag so it never
      // collects mid-reply. Scoped release like memlog.
      const proactiveGc = startProactiveGc(() => store.state.info.running === true)
      yield* Effect.addFinalizer(() => Effect.sync(proactiveGc.stop))
      // Memory early-warning (#34095 parity) — surfaces a transcript system line
      // when heap climbs abnormally fast below the OOM ceiling (the silent-death
      // regime). ON by default: a KB user-facing safety heads-up, not a
      // diagnostic dump. No auto heap-snapshot (memlog is the diagnosis path).
      const stopMemoryMonitor = startMemoryMonitor(line => store.pushSystem(line))
      yield* Effect.addFinalizer(() => Effect.sync(stopMemoryMonitor))
      // HERMES_HEAPDUMP_ON_START (Ink parity): a deliberate baseline snapshot at
      // boot. Bypasses the diagnostics master switch (you set it on purpose).
      // Best-effort + synchronous (writeHeapSnapshot blocks V8) — a failure must
      // never block launch.
      if (heapdumpOnStart()) {
        try {
          const dump = performHeapdump()
          store.pushSystem(`heap snapshot written: ${dump.path}`)
        } catch (cause) {
          getLog().warn('bootstrap', 'heapdump-on-start failed', { cause: String(cause) })
        }
      }
      doQuit = (code = 0) => {
        process.exitCode = code
        if (!renderer.isDestroyed) renderer.destroy()
      }

      // Global action hotkeys consume their bytes before the textarea can
      // interpret them. Redraw invalidates buffers without resetting the input
      // parser; action+D shares Ink's local-exit / hosted-new-chat contract.
      const onGlobalAction = (key: KeyEvent) => {
        if (isRedrawHotkey(key)) {
          key.preventDefault()
          redrawRenderer(renderer, { clearSelection: true })
          return
        }
        if (!isExitHotkey(key) || actionExitBlocked(store.state)) return
        key.preventDefault()
        if (hostedDashboard) requestDashboardNewSession()
        else doQuit(0)
      }
      renderer.keyInput.on('keypress', onGlobalAction)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          renderer.keyInput.off('keypress', onGlobalAction)
        })
      )

      // Native keymap host (Phase 3): one keymap bound to this renderer, provided
      // to the whole Solid tree via <KeymapProvider>. Overlays/prompts register
      // close (and confirm) layers against it through useCloseLayer/useBindings.
      const keymap = createDefaultOpenTuiKeymap(renderer)

      // Submit a user turn: the service value is in hand, so `gateway.request(...)`
      // is Effect<…, never> — fire it detached with runFork; failures are logged.
      const submitPrompt = (text: string) => {
        if (sessionTransitionInFlight) {
          if (transitionSubmissions.length >= SESSION_TRANSITION_QUEUE_LIMIT) {
            store.pushSystem(
              `session-switch queue full (${SESSION_TRANSITION_QUEUE_LIMIT}) — wait for the switch to finish`
            )
            return
          }
          transitionSubmissions.push({ kind: 'prompt', text })
          store.pushSystem(`⏳ queued for the new session (${transitionSubmissions.length} queued)`)
          return
        }
        // Busy guard (layer A of the busy-queue fix): a prompt sent while a turn
        // runs CANNOT go straight to the gateway (the server rejects it with 4009
        // "session busy" and the client used to swallow it → silent drop). Park it
        // in the store's client queue; the registered turn-complete drain re-submits
        // it once the current turn finishes (info.running is false by then).
        if (store.state.info.running) {
          store.enqueuePrompt(text)
          store.pushSystem(`⏳ queued — will send after the current turn (${store.queuedCount()} queued)`)
          return
        }
        const sid = gateway.sessionId()
        if (!sid) {
          getLog().warn('submit', 'no active session', { text })
          store.pushSystem('no active session — run /new to retry')
          return
        }
        store.pushUser(text)
        Effect.runFork(
          gateway.request('prompt.submit', { session_id: sid, text }).pipe(
            Effect.catchCause(cause =>
              Effect.sync(() => {
                // Ink-parity (useSubmission.ts): the busy-guard above + the
                // settle-edge drain (store.applyInfo on the server-confirmed
                // running:false edge) mean we NEVER optimistically submit while a
                // turn is in flight — so a prompt is enqueued, then drained and
                // submitted exactly ONCE, after the gateway is idle. We therefore
                // do NOT re-queue on a 4009 here: an earlier cut did, but a 4009
                // that races a still-finishing nested turn (e.g. /goal's kickoff)
                // can fire even though the submit ACTUALLY went through, and the
                // re-queue then ran the prompt a SECOND time (the /goal
                // double-run). Ink never optimistically submits, so it never has a
                // 4009 to recover from; mirror that — just log. (If a 4009 ever
                // reaches here it means the drain fired too early, which is a bug
                // to fix at the edge, not to paper over with a duplicate-prone
                // retry.) Defensive — never throws out.
                getLog().warn('submit', 'failed', { cause: String(cause) })
              })
            )
          )
        )
      }

      // Submit a SKILL invocation (e.g. /dogfood): the full skill body still
      // goes to the model (so the model consumes the skill, prompt-cache intact),
      // but the transcript renders a COLLAPSED `▶ /name · N lines` row via
      // pushSkill instead of dumping the whole body as a giant user bubble
      // (glitch 2026-06-23). Mirrors submitPrompt's busy-guard + send path.
      const submitSkill = (command: string, body: string) => {
        if (sessionTransitionInFlight) {
          if (transitionSubmissions.length >= SESSION_TRANSITION_QUEUE_LIMIT) {
            store.pushSystem(
              `session-switch queue full (${SESSION_TRANSITION_QUEUE_LIMIT}) — wait for the switch to finish`
            )
            return
          }
          transitionSubmissions.push({ body, command, kind: 'skill' })
          store.pushSystem(`⏳ queued for the new session (${transitionSubmissions.length} queued)`)
          return
        }
        // Busy guard: same as submitPrompt. A skill fired mid-turn can't go
        // straight to the gateway (4009). Queue the raw body — it drains as a
        // normal prompt (the collapsed render is a nicety lost only in the rare
        // mid-turn case; the body still reaches the model correctly).
        if (store.state.info.running) {
          store.enqueuePrompt(body)
          store.pushSystem(`⏳ queued — will send after the current turn (${store.queuedCount()} queued)`)
          return
        }
        const sid = gateway.sessionId()
        if (!sid) {
          getLog().warn('submitSkill', 'no active session', { command })
          store.pushSystem('no active session — run /new to retry')
          return
        }
        store.pushSkill(command, body)
        Effect.runFork(
          gateway
            .request('prompt.submit', { session_id: sid, text: body })
            .pipe(
              Effect.catchCause(cause =>
                Effect.sync(() => getLog().warn('submitSkill', 'failed', { cause: String(cause) }))
              )
            )
        )
      }

      drainTransitionSubmissions = (): void => {
        const pending = transitionSubmissions.splice(0)
        if (pending.length === 0) return
        const { first, queued } = planTransitionDrain(pending)
        // Exactly one request may start immediately. The remaining inputs join
        // the existing one-per-server-confirmed-turn queue; firing them all in
        // one tick races message.start and causes 4009 drops.
        if (first?.kind === 'prompt') submitPrompt(first.text)
        else if (first) submitSkill(first.command, first.body)
        for (const text of queued) store.enqueuePrompt(text)
        if (queued.length > 0) store.pushSystem(`⏳ ${queued.length} more queued for this session`)
      }

      // `!cmd` — run a shell command directly (Ink/free-code parity: F9). The
      // gateway's `shell.exec` runs it (30s timeout, dangerous/hardline guards)
      // and returns {stdout, stderr, code}; we echo the invocation as a user line
      // and the combined output (or the error / non-zero exit) as a system line.
      // No model turn — this never hits prompt.submit. Detached like submitPrompt.
      const runShell = (cmd: string) => {
        if (!cmd) return
        store.pushUser(`!${cmd}`)
        Effect.runFork(
          gateway.request<{ stdout?: string; stderr?: string; code?: number }>('shell.exec', { command: cmd }).pipe(
            Effect.tap(r =>
              Effect.sync(() => {
                const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trimEnd()
                if (out) store.pushSystem(out)
                if ((r.code ?? 0) !== 0 || !out) store.pushSystem(`exit ${r.code ?? 0}`)
              })
            ),
            Effect.catchCause(cause =>
              Effect.sync(() => {
                getLog().warn('shell', 'failed', { cause: String(cause) })
                store.pushSystem(`error: ${String(cause)}`)
              })
            )
          )
        )
      }

      // Resume a chosen session (resume picker pick or `/resume <id>` direct
      // path) — the same hydrate path as launch. When the picker was the BOOT
      // surface (bare `--resume`), no create ever ran, so the post-session
      // setup (catalog, /model prefetch) runs here exactly once.
      const onResume = (resumeSid: string) => {
        if (guardBusySessionSwitch()) return
        sessionTransitionInFlight = true
        store.setHint('resuming…')
        let transitionSucceeded = false
        Effect.runFork(
          Effect.gen(function* () {
            const liveSessionId = yield* resumeInto(gateway, store, resumeSid, input.cols)
            transitionSucceeded = true
            if (!store.state.catalog) {
              Effect.runFork(
                postSessionSetup(gateway, store, liveSessionId).pipe(
                  Effect.catchCause(cause =>
                    Effect.sync(() => getLog().warn('resume', 'post-resume setup failed', { cause: String(cause) }))
                  )
                )
              )
            }
          }).pipe(
            Effect.catchCause(cause =>
              Effect.sync(() => {
                const error = Cause.squash(cause)
                const detail = error instanceof Error ? error.message : String(error)
                getLog().warn('resume', 'failed', { cause: detail })
                store.pushSystem(`resume failed: ${detail}`)
              })
            ),
            Effect.ensuring(
              Effect.sync(() => {
                sessionTransitionInFlight = false
                if (store.state.hint === 'resuming…') store.setHint(undefined)
                if (transitionSucceeded) {
                  drainTransitionSubmissions()
                } else reportFailedTransitionSubmissions()
              })
            )
          )
        )
      }

      // The resume picker's gateway calls (view/overlays/sessionPicker.tsx).
      // `rename` goes through `session.title` — the existing title RPC (it
      // reaches only LIVE gateway sessions; the picker surfaces rejections).
      const sessionOps: SessionPickerOps = {
        list: params => Effect.runPromise(gateway.request('session.list', params)),
        peek: sessionId => Effect.runPromise(gateway.request('session.peek', { session_id: sessionId })),
        rename: (sessionId, title) =>
          Effect.runPromise(gateway.request('session.title', { session_id: sessionId, title })).then(() => undefined)
      }

      // The background-process panel's gateway calls (view/overlays/backgroundPanel.tsx):
      // `agents.list` lists the OS process registry; `process.stop` kills ALL of them
      // (the gateway exposes kill-all only — no per-process RPC, hence no per-row kill).
      const backgroundOps = {
        list: () => Effect.runPromise(gateway.request('agents.list', {})).then(parseProcessList),
        stopAll: () => Effect.runPromise(gateway.request('process.stop', {})).then(() => undefined)
      }

      // Boot-picker Esc fallback: the picker closed without a pick and no
      // session exists yet (bare `--resume` launch) — create a fresh one so
      // the composer has somewhere to send prompts.
      const onSessionPickerClosed = () => {
        if (gateway.sessionId()) return
        if (guardBusySessionSwitch('start a session')) return
        sessionTransitionInFlight = true
        store.setHint('starting session…')
        let transitionSucceeded = false
        Effect.runFork(
          createFreshSession(gateway, store, input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                transitionSucceeded = gateway.sessionId() !== undefined
              })
            ),
            Effect.catchCause(cause =>
              Effect.sync(() => {
                getLog().warn('bootstrap', 'post-picker create failed', { cause: String(cause) })
                store.pushSystem(`session create failed: ${String(cause)}`)
              })
            ),
            Effect.ensuring(
              Effect.sync(() => {
                sessionTransitionInFlight = false
                if (store.state.hint === 'starting session…') store.setHint(undefined)
                if (transitionSucceeded) {
                  drainTransitionSubmissions()
                } else reportFailedTransitionSubmissions()
              })
            )
          )
        )
      }

      const startNewSession = (message?: string, title?: string): void => {
        if (guardBusySessionSwitch()) return
        sessionTransitionInFlight = true
        store.setHint('forging session…')
        const previousLiveSessionId = gateway.sessionId()
        let transitionSucceeded = false

        Effect.runFork(
          Effect.gen(function* () {
            const result = yield* replaceSession(gateway, {
              activeSessionId: previousLiveSessionId,
              cols: input.cols,
              cwd: launchCwd(),
              onClosed: () => {
                // The transport has already cleared its routing SID. Detach the
                // Solid state and sidecar at the same boundary so a failed
                // create cannot masquerade as the now-closed conversation.
                store.detachSession()
                pasteStore.clear()
                writeActiveSession(undefined)
              }
            })

            if (result.kind === 'setup-required') {
              store.setHint('setup required')
              store.openPager(
                'Setup Required',
                [
                  'A new session cannot start until a model provider is configured.',
                  '',
                  '• /model — choose from available configured providers',
                  '• /setup — run the guided provider setup',
                  '• Ctrl+C — exit, then run `hermes setup`'
                ].join('\n')
              )
              return
            }

            store.adoptFreshSession(result.sessionId, result.info, result.resumeId)
            pasteStore.clear()
            writeActiveSession(result.resumeId)
            store.setStatus('starting agent…')
            getLog().info('session', 'fresh session created', { resumeId: result.resumeId, sid: result.sessionId })
            transitionSucceeded = true

            for (const key of ['credential_warning', 'config_warning'] as const) {
              const warning = result.info?.[key]
              if (typeof warning === 'string' && warning.trim()) store.pushSystem(`warning: ${warning.trim()}`)
            }
            if (message) store.pushSystem(message)

            const requestedTitle = title?.trim()
            if (requestedTitle) {
              Effect.runFork(
                gateway
                  .request<{ pending?: boolean; title?: string }>('session.title', {
                    session_id: result.sessionId,
                    title: requestedTitle
                  })
                  .pipe(
                    Effect.tap(titleResult =>
                      Effect.sync(() => {
                        if (gateway.sessionId() !== result.sessionId) return
                        const nextTitle = titleResult.title?.trim() || requestedTitle
                        const suffix = titleResult.pending ? ' (queued while session initializes)' : ''
                        store.pushSystem(`session title set: ${nextTitle}${suffix}`)
                      })
                    ),
                    Effect.catchCause(cause =>
                      Effect.sync(() => {
                        if (gateway.sessionId() !== result.sessionId) return
                        const error = Cause.squash(cause)
                        const detail = error instanceof Error ? error.message : String(error)
                        store.pushSystem(`warning: failed to set session title: ${detail}`)
                      })
                    )
                  )
              )
            }

            // Catalog/model hydration is best-effort and SID-gated internally;
            // it must not hold the transition lock or block the new composer.
            Effect.runFork(
              postSessionSetup(gateway, store, result.sessionId).pipe(
                Effect.catchCause(cause =>
                  Effect.sync(() => getLog().warn('session', 'post-create setup failed', { cause: String(cause) }))
                )
              )
            )
          }).pipe(
            Effect.catchCause(cause =>
              Effect.sync(() => {
                const error = Cause.squash(cause)
                const detail = error instanceof Error ? error.message : String(error)
                getLog().warn('session', 'fresh session replacement failed', { cause: detail })
                store.pushSystem(`new session failed: ${detail} — run /new to retry`)
              })
            ),
            Effect.ensuring(
              Effect.sync(() => {
                sessionTransitionInFlight = false
                if (store.state.hint === 'forging session…') store.setHint(undefined)
                if (transitionSucceeded) {
                  drainTransitionSubmissions()
                } else reportFailedTransitionSubmissions()
              })
            )
          )
        )
      }

      // Slash dispatch context (Solid logic; the boundary just hands it a
      // Promise-returning `request` + the host capabilities it needs).
      const slashCtx: SlashContext = {
        guardBusySessionSwitch,
        newSession: startNewSession,
        beginToolsConfigure: () => {
          sessionTransitionInFlight = true
          store.setHint('changing tools…')
        },
        endToolsConfigure: () => {
          sessionTransitionInFlight = false
          if (store.state.hint === 'changing tools…') store.setHint(undefined)
          if (gateway.sessionId() && store.state.sessionId) drainTransitionSubmissions()
          else reportFailedTransitionSubmissions()
        },
        resetAfterToolsConfigure: info => {
          const sid = gateway.sessionId()
          if (!sid || store.state.sessionId !== sid) return
          store.adoptFreshSession(sid, info, store.state.resumeId ?? sid)
          Effect.runFork(
            postSessionSetup(gateway, store, sid).pipe(
              Effect.catchCause(cause =>
                Effect.sync(() => getLog().warn('tools', 'post-configure setup failed', { cause: String(cause) }))
              )
            )
          )
        },
        hasConversation: () =>
          store.state.messages.some(message => message.role === 'user' || message.role === 'assistant'),
        setSessionTitle: title => store.applyInfo({ title }),
        refreshCommandCatalog: (catalog, removedSkills) => {
          const decoded = catalog === undefined ? undefined : decodeCommandsCatalogResponse(catalog)
          store.setCommandCatalog(decoded)
          refreshLearnedNames(
            [...catalogCommandItems(decoded), ...clientCommandNames().map(name => ({ text: `/${name}` }))],
            removedSkills
          )
        },
        commandCatalog: () => store.state.commandCatalog,
        historyItems: () => store.state.messages,
        helpHeader: () => store.state.theme.brand.helpHeader,
        dashboardMode: () => hostedDashboard,
        compact: () => store.state.compact,
        setCompact: on => store.setCompact(on),
        details: () => store.state.details,
        setDetails: mode => store.setDetails(mode),
        timestamps: () => store.state.timestamps,
        setTimestamps: on => store.setTimestamps(on),
        reasoningFull: () => store.state.reasoningFull,
        setReasoningFull: on => store.setReasoningFull(on),
        renderableCount: () => {
          try {
            return descendantCount(renderer.root)
          } catch {
            return undefined
          }
        },
        // HERMES_TUI_NO_CONFIRM (Ink parity): skip the destructive-action confirm
        // step and run the action immediately. Read per call so a wrapper that
        // mutates env before launch sees the live value.
        confirm: (message, onConfirm) => (noConfirmDestructive() ? onConfirm() : store.setConfirm(message, onConfirm)),
        copyResponse: n => {
          const text = nthAssistantResponse(store.state.messages, n)
          if (!text) return false
          void writeClipboard(text)
          flashHint(n > 1 ? `Copied response #${n} to clipboard` : 'Copied response to clipboard')
          return true
        },
        modelItems: () => store.state.modelItems,
        setModelItems: items => store.setModelItems(items),
        logTail: limit => gateway.logTail(limit),
        openDashboard: () => store.openDashboard(),
        openBackgroundPanel: () => store.openBackgroundPanel(),
        openBilling: overlay => store.openBilling(overlay),
        addBgTask: id => store.addBgTask(id),
        openPager: (title, text) => store.openPager(title, text),
        openPicker: picker => store.openPicker(picker),
        openSessionPicker: tab => store.openSessionPicker(tab),
        resumeSession: onResume,
        pushSystem: text => store.pushSystem(text),
        quit: code => doQuit(code),
        // Ink keeps a mouse selection for `/redraw`; only action+L explicitly
        // clears it (the global hotkey path above passes clearSelection:true).
        redraw: () => redrawRenderer(renderer),
        request: (method, params) => Effect.runPromise(gateway.request(method, params)),
        sessionId: () => gateway.sessionId(),
        submit: submitPrompt,
        submitSkill
      }

      // The composer's submit: `!cmd` runs a shell command (F9), `/command`
      // routes through the slash ladder, else a prompt turn.
      const submit = (text: string) => {
        const route = classifySubmit(text)
        if (route.kind === 'shell') runShell(route.payload)
        else if (route.kind === 'slash') void dispatchSlash(route.payload, slashCtx)
        else submitPrompt(route.payload)
      }

      // Drain the client busy queue ONCE per turn-completion: the store fires this
      // on every `message.complete`. Pop ONE queued prompt and re-submit it — and
      // because submitPrompt now guards on info.running (false at completion time),
      // it submits cleanly. Draining ONE per completion preserves ordering + lets
      // each queued prompt stream as its own turn (the next completion drains the next).
      store.registerTurnCompleteHandler(() => {
        const next = store.dequeuePrompt()
        if (next !== undefined) submitPrompt(next)
      })

      // Live completions (items 5 + 13): a `/command [args]` line queries
      // `complete.slash` (the gateway completes names AND args); a trailing
      // path-like word queries `complete.path` (file/@-mention tagging). The
      // accepted item replaces from the gateway's `replace_from` (or the token
      // start), so only the relevant token is spliced — not the whole line.
      // Fired per keystroke (a debounce is a polish item).
      //
      // Out-of-order guard (glitch 2026-06-14): the gateway transport does NOT
      // guarantee in-order response delivery, and these RPCs fire per keystroke
      // with no debounce — a slow earlier `complete.slash` could resolve AFTER a
      // later `@`-mention `complete.path` and clobber the store, blanking the
      // `@` dropdown ("a leading /path message breaks @-mentions afterward").
      // The completion gate (claimed on EVERY call, before the clear branch, so
      // an intermediate keystroke that fires no RPC still invalidates the older
      // in-flight one) drops any response a newer keystroke has superseded.
      const completionGate = createCompletionGate()
      const onType = (text: string, cursor: number = text.length) => {
        const token = completionGate.claim()
        const plan = planCompletion(text, cursor)
        if (!plan) {
          store.clearCompletions()
          return
        }
        Effect.runPromise(gateway.request(plan.method, plan.params))
          .then(result => {
            if (!completionGate.isCurrent(token)) return // a newer keystroke superseded this query
            store.setCompletions(mapCompletions(result), readReplaceFrom(result, plan.from))
          })
          .catch(() => {
            if (!completionGate.isCurrent(token)) return
            store.clearCompletions()
          })
      }

      // Blocking-prompt replies (clarify/approval/sudo/secret `*.respond`). Same
      // detached-runFork pattern; failures logged, never thrown into the view.
      const respond = (method: string, params: Record<string, unknown>) => {
        Effect.runFork(
          gateway
            .request(method, params)
            .pipe(
              Effect.catchCause(cause =>
                Effect.sync(() => getLog().warn('respond', 'failed', { cause: String(cause), method }))
              )
            )
        )
      }

      // Live backend: drive a session (create + optional initial prompt)
      // concurrently, but acquire the same transition lock BEFORE rendering so
      // an early /new or /resume cannot race boot hydration.
      if (!input.fake) {
        sessionTransitionInFlight = true
        store.setHint('starting session…')
        yield* Effect.forkScoped(
          bootstrapSession(gateway, store, input).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                sessionTransitionInFlight = false
                if (store.state.hint === 'starting session…') store.setHint(undefined)
                if (gateway.sessionId() && store.state.sessionId) {
                  drainTransitionSubmissions()
                } else if (!store.state.sessionPicker) reportFailedTransitionSubmissions()
              })
            )
          )
        )
      }

      // (No ambient OS-process poll: the `bg:` badge now counts in-flight
      // background-PROMPT tasks from the event stream, and the /processes panel
      // fetches `agents.list` on open. Nothing to poll for.)

      // Contact point #1: the single render bridge. After this, the screen is Solid's.
      // The theme is sourced reactively from the store (skin events update it).
      yield* Effect.promise(() =>
        render(
          () => (
            <KeymapProvider keymap={keymap}>
              <ThemeProvider theme={() => store.state.theme}>
                <TerminalChrome store={store} />
                <App
                  store={store}
                  onSubmit={submit}
                  onType={onType}
                  onRespond={respond}
                  onResume={onResume}
                  sessionOps={sessionOps}
                  onSessionPickerClosed={onSessionPickerClosed}
                  sessionId={() => gateway.sessionId()}
                  history={history}
                  onImagePaste={onImagePaste}
                  pasteStore={pasteStore}
                  backgroundOps={backgroundOps}
                />
              </ThemeProvider>
            </KeymapProvider>
          ),
          renderer
        )
      )

      // Block until the renderer is destroyed (Ctrl+C / quit); finalizers then run.
      yield* Deferred.await(shutdown)
    })
  )
})

/** Scripted "hello" stream so the fake backend paints a non-empty frame offline. */
function streamHello(controller: FakeGatewayController): void {
  controller.emit({ type: 'gateway.ready' })
  controller.emit({ type: 'message.start' })
  for (const chunk of ['Hi ', 'there, ', 'glitch!']) {
    controller.emit({ type: 'message.delta', payload: { text: chunk } })
  }
  controller.emit({ type: 'message.complete' })
}

if (import.meta.main) {
  const fake = envFlag(process.env.HERMES_TUI_FAKE, false)
  const cols = process.stdout.columns || 80
  // `hermes --tui "prompt"` / `--image` seed: the launcher sets HERMES_TUI_QUERY
  // (+ HERMES_TUI_IMAGE); we also honor HERMES_TUI_PROMPT (OpenTUI alias) and a
  // bare argv tail (standalone dev). See logic/env.ts startupPrompt/startupImage.
  const initialPrompt = startupPrompt()
  const initialImage = startupImage()
  const resumeId = process.env.HERMES_TUI_RESUME?.trim()
  // Mouse on by default. Defers to Ink's env surface (HERMES_TUI_MOUSE_TRACKING >
  // HERMES_TUI_DISABLE_MOUSE > HERMES_TUI_MOUSE alias > default on). See env.ts.
  const mouse = resolveMouseEnabled()
  const base = { mouse, fake, cols }
  const withPrompt = initialPrompt ? { ...base, initialPrompt } : base
  const withImage = initialImage ? { ...withPrompt, initialImage } : withPrompt
  const input: TuiInput = resumeId ? { ...withImage, resumeId } : withImage

  const onFatal = (error: unknown) => {
    getLog().error('entry', 'fatal', { error: String(error) })
    process.exitCode = 1
  }

  if (fake) {
    const { layer, controller } = makeFakeGatewayLayer()
    // Drive the fake stream shortly after mount so the subscription is live.
    setTimeout(() => streamHello(controller), 50)
    Effect.runPromise(run(input).pipe(Effect.provide(makeAppLayer(layer)))).catch(onFatal)
  } else {
    Effect.runPromise(run(input).pipe(Effect.provide(makeAppLayer(liveGatewayLayer)))).catch(onFatal)
  }
}
