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
import { Cause, Deferred, Duration, Effect, Option } from 'effect'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { KeyEvent } from '@opentui/core'

import { readClipboardImage, writeClipboard } from '../boundary/clipboard.ts'
import { launchHermesCommand } from '../boundary/externalCli.ts'
import { openInEditor } from '../boundary/externalInput.ts'
import { configureDetectedTerminalKeybindings, configureTerminalKeybindings } from '../boundary/terminalSetup.ts'
import { GatewayService, type GatewayServiceShape } from '../boundary/gateway/GatewayService.ts'
import { liveGatewayLayer } from '../boundary/gateway/liveGateway.ts'
import { getLog } from '../boundary/log.ts'
import { promptResponseAcknowledged, type PromptResponseMethod } from '../boundary/promptResponses.ts'
import { startMemlog } from '../boundary/memlog.ts'
import { startMemoryMonitor } from '../boundary/memoryMonitor.ts'
import { startProactiveGc } from '../boundary/proactiveGc.ts'
import { registerRemoteParsers } from '../boundary/parsers.ts'
import { acquireRenderer, redrawRenderer } from '../boundary/renderer.ts'
import { decodeSubagentInterruptResponse } from '../boundary/schema/Delegation.ts'
import {
  attachedImageNotice,
  decodeImageAttachResponse,
  decodeSetupStatusResponse
} from '../boundary/schema/ExternalInputResponses.ts'
import { decodeVoiceRecordResponse } from '../boundary/schema/VoiceResponses.ts'
import {
  classifySessionSteerResponse,
  decodeCommandsCatalogResponse,
  decodeConfigFullResponse,
  decodeConfigMtimeResponse,
  decodeConfigValueResponse,
  type SessionSteerDisposition
} from '../boundary/schema/SessionCommandResponses.ts'
import { makeAppLayer } from '../boundary/runtime.ts'
import {
  activateSession,
  branchSession,
  createSession,
  replaceSession,
  resumeSession
} from '../boundary/sessionLifecycle.ts'
import { configSyncBlocked, createConfigSyncTracker, mcpReloadSucceeded } from '../logic/configSync.ts'
import {
  createDelegationStatusRefresher,
  createSpawnTreeSaveDrainer,
  tuiAgentsNudgeConfigValue
} from '../logic/agentsRuntime.ts'
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
import { isVoiceRecordKey, voiceRecordKeyFromConfig } from '../logic/voiceKey.ts'
import { parseProcessList } from '../logic/backgroundActivity.ts'
import { eventMayEnterStore } from '../logic/eventScope.ts'
import { createPasteStore } from '../logic/pastes.ts'
import {
  heldTransitionBlocks,
  planTransitionDrain,
  recoveryLineageOwner,
  recoveryTargetIsMissing,
  recoveryTransitionOwner,
  SESSION_TRANSITION_QUEUE_MAX_CHARS,
  SESSION_TRANSITION_QUEUE_LIMIT,
  transitionQueueAccepts,
  transitionQueueReservation,
  transitionOwnerAccepts,
  transitionSubmissionText,
  type TransitionSubmission
} from '../logic/transitionQueue.ts'
import {
  awaitModelPrefetch,
  clearModelPrefetch,
  classifySubmit,
  BUSY_QUEUE_FULL_MESSAGE,
  catalogCommandItems,
  clientCommandNames,
  createCompletionGate,
  dispatchSlash,
  mapCompletions,
  mapModelOptions,
  planCompletion,
  readReplaceFrom,
  startModelPrefetch,
  type SlashContext
} from '../logic/slash.ts'
import {
  busyInputModeFromConfig,
  BUSY_QUEUE_MAX_CHARS,
  BUSY_QUEUE_MAX_EDIT_CHARS,
  queueAccepts
} from '../logic/busyQueue.ts'
import { coordinatePromptLiveSession } from '../logic/promptLiveSession.ts'
import {
  advancePreStartCancellationFence,
  createAutomaticQueueDrainGate,
  createQueueEditDrainGate,
  deliveryFailureIsUncertain,
  pendingPromptAfterBoundary,
  pendingPromptBoundaryMatches,
  pendingPromptDecision,
  runningAfterPreStartFence,
  steerRetentionOrder,
  steerSlotAvailable,
  submitWhileBusy,
  takeSettledSteerPrefix,
  type SteerDelivery
} from '../logic/busySubmit.ts'
import {
  createSessionStore,
  startupCatalogRetryDelay,
  type Catalog,
  type PickerItem,
  type SessionStore
} from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { refreshLearnedNames, seedLearnedNames } from '../view/composer.tsx'
import { TerminalChrome } from '../view/terminalChrome.tsx'

// Syntax-highlighting language expansion: register the remote tree-sitter
// grammars (python/rust/go/bash/json/c/html/css/yaml/toml) before the first
// <code>/<markdown> mount initializes the global tree-sitter client. Grammars
// are fetched from GitHub on first use and cached under HERMES_TUI_PARSER_CACHE.
registerRemoteParsers()
import type { SessionOrchestratorOps } from '../view/overlays/sessionOrchestrator.tsx'
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
const CONFIG_MTIME_POLL = Duration.seconds(5)
/** Window after a Ctrl+C in which a second Ctrl+C quits the TUI (item 11). */
const QUIT_WINDOW_MS = 3_000
const PENDING_STEER_LIMIT = 8
const PENDING_STEER_MAX_CHARS = 4 * 1024 * 1024

interface PendingPrompt {
  readonly clientMessageId: string
  readonly submissionId: string
  readonly sessionId: string
  readonly text: string
}

interface PendingSteerRequest {
  readonly front: boolean
  outcome?: SessionSteerDisposition
  readonly resolve: (delivery: SteerDelivery) => void
  readonly text: string
}

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

const resumeInto = (
  gateway: GatewayServiceShape,
  store: SessionStore,
  sid: string,
  cols: number,
  preserveLocalInput?: 'draft' | 'same-session'
) =>
  Effect.gen(function* () {
    const resumed = yield* resumeSession(gateway, store, {
      cols,
      ...(preserveLocalInput ? { preserveLocalInput } : {}),
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

/** Keep retrying the existing startup.catalog RPC only while the server says
 * the authoritative agent build is pending. The loop is session-fenced and
 * detached so a slow build never holds the input transition lock. */
const scheduleStartupCatalogRetry = (
  gateway: GatewayServiceShape,
  store: SessionStore,
  sid: string,
  initial: Catalog,
  isActive: () => boolean
): void => {
  const delay = startupCatalogRetryDelay(initial)
  if (delay === undefined || !isActive()) return
  const timer = setTimeout(() => {
    if (!isActive()) return
    Effect.runPromise(gateway.request<unknown>('startup.catalog', { session_id: sid }))
      .then(raw => {
        if (!isActive()) return
        const refreshed = store.setCatalog(raw)
        if (refreshed) scheduleStartupCatalogRetry(gateway, store, sid, refreshed, isActive)
      })
      .catch(cause => getLog().warn('startup', 'catalog retry failed', { cause: String(cause), sid }))
  }, delay)
  // A permanently stalled agent build must not keep Node alive after the TUI
  // renderer and gateway have otherwise shut down.
  timer.unref()
}

/**
 * Post-session setup, shared by every way a session comes to exist (create,
 * boot resume, boot-picker pick): the tools/skills/MCP catalog for the home
 * panel (item 9 — best-effort), the optional initial prompt, and the `/model`
 * catalog prefetch (Epic 7 instant open: `model.options` is the slow RPC —
 * network pricing fetch + Nous tier check — so pay it ONCE in an already-
 * forked fiber; the promise is STASHED in the slash seam so an early `/model`
 * awaits THIS request instead of doubling it). The prefetch must remain
 * background work: awaiting it here holds the session-transition input lock.
 */
const postSessionSetup = (
  gateway: GatewayServiceShape,
  store: SessionStore,
  sid: string,
  initialPrompt?: string,
  initialImage?: string,
  submitInitial?: (text: string) => boolean
) =>
  Effect.gen(function* () {
    const isActive = () => gateway.sessionId() === sid && store.state.sessionId === sid
    const busyModeRevision = store.getBusyInputModeRevision()

    // Claim model hydration for this SID before the first async yield. Session
    // transitions clear the previous claim, so an immediate `/model` can only
    // await this session's request and never the predecessor's slow prefetch.
    startModelPrefetch(
      sid,
      Effect.runPromise(
        gateway
          .request<unknown>('model.options', { session_id: sid })
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      ),
      modelOpts => {
        const modelItems = mapModelOptions(modelOpts)
        if (modelItems.length && isActive()) store.setModelItems(modelItems)
      }
    )

    const catalog = yield* gateway
      .request<unknown>('startup.catalog', { session_id: sid })
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (catalog !== undefined && isActive()) {
      const decoded = store.setCatalog(catalog)
      if (decoded && startupCatalogRetryDelay(decoded) !== undefined) {
        scheduleStartupCatalogRetry(gateway, store, sid, decoded, isActive)
      }
    }

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

    // Mirror the persisted full-screen busy-input policy. The RPC is
    // local/config-only and best-effort; the store's safe TUI default remains
    // `queue` on failure/malformed data, and the revision captured above keeps
    // a late hydration reply from overwriting an early `/busy` command.
    const busyConfig = yield* gateway
      .request<unknown>('config.get', { key: 'full' })
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    const decodedBusyConfig = decodeConfigFullResponse(busyConfig)
    if (isActive() && decodedBusyConfig) {
      store.hydrateBusyInputMode(busyInputModeFromConfig(decodedBusyConfig.config), busyModeRevision)
      store.configureAgentsNudge(tuiAgentsNudgeConfigValue(decodedBusyConfig.config))
      store.setVoiceMode({ recordKey: voiceRecordKeyFromConfig(decodedBusyConfig.config) })
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
      // Seeded input uses the same best-effort sender as the composer. If the
      // host cannot synchronously accept it, leave the exact text in the draft.
      if (submitInitial?.(prompt) !== true) {
        store.replaceComposerDraft(prompt)
        store.pushSystem('startup prompt retained in composer — press Enter to send')
      }
    }
  })

/** Create a FRESH session + run the post-session setup (the default boot path;
 *  also the boot-picker's Esc fallback — closing the picker without a pick
 *  must still leave a usable session behind). */
const createFreshSession = (
  gateway: GatewayServiceShape,
  store: SessionStore,
  input: TuiInput,
  submitInitial?: (text: string) => boolean
) =>
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
    yield* postSessionSetup(gateway, store, created.sessionId, input.initialPrompt, input.initialImage, submitInitial)
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
const bootstrapSession = (
  gateway: GatewayServiceShape,
  store: SessionStore,
  input: TuiInput,
  submitInitial?: (text: string) => boolean
) =>
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
      const liveSessionId = yield* resumeInto(gateway, store, sid, input.cols, 'draft')
      yield* postSessionSetup(gateway, store, liveSessionId, input.initialPrompt, input.initialImage, submitInitial)
      return
    }

    yield* createFreshSession(gateway, store, input, submitInitial)
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

      let sessionTransitionInFlight = false
      let gatewayUnavailable = false
      let historyMutationInFlight = false
      const isSessionTransitioning = () => sessionTransitionInFlight || gatewayUnavailable
      /** Authoritative local busy predicate. `message.complete` stops the visual
       * spinner before the server's final `session.info(false)` arrives, so the
       * separate turn-in-flight latch must keep submissions on the local policy
       * path throughout that settle window. */
      const isTurnBusy = () => store.state.info.running === true || store.isTurnInFlight()
      const configSync = createConfigSyncTracker()
      let drainQueuedIfIdle = () => {}
      let sendPromptNow: (text: string, skillCommand?: string) => boolean = () => false
      let promoteHeldTransitionSubmissions = () => {}
      let promoteHeldAfterRecovery = false
      let pendingPrompt: PendingPrompt | undefined
      // A deferred-build interrupt can receive its ACK before the Python build
      // thread publishes one stale session.info(running:true), then clear server
      // running without a matching false event. Fence only that cancelled SID's
      // pre-start info until a real message.start/terminal boundary arrives.
      let preStartCancellationSessionId: string | undefined
      let pendingSteerCount = 0
      let pendingSteerCharacters = 0
      let pendingSteerSequence = 0
      const pendingSteers = new Map<number, PendingSteerRequest>()
      const automaticQueueDrain = createAutomaticQueueDrainGate()
      const queueEditDrain = createQueueEditDrainGate()
      const releaseQueueEditDrain = (): void => {
        automaticQueueDrain.resetIfEmpty(store.queuedCount())
        if (queueEditDrain.release()) queueMicrotask(drainQueuedIfIdle)
      }
      let imageAttachInFlight = false
      const transitionSubmissions: TransitionSubmission[] = []
      let activeTransitionOwner: string | undefined
      let heldTransitionOwner: string | undefined
      // Stable conversation-lineage owner for destructive in-place transitions
      // such as /tools. Same-session recovery may resolve a compressed parent to
      // its continuation tip; that must not strand input authored before the
      // crash. Explicit user-selected resume/new replaces this only on success.
      let stableSessionOwnerId: string | undefined
      const currentSessionOwnerId = (): string | undefined => {
        stableSessionOwnerId ??= store.state.resumeId
        return stableSessionOwnerId
      }
      let drainTransitionSubmissions: () => void = () => {}
      const releaseTransitionOwnerUnlessPromoting = (): void => {
        if (
          promoteHeldAfterRecovery &&
          transitionSubmissions.length > 0 &&
          heldTransitionOwner === activeTransitionOwner
        ) {
          return
        }
        activeTransitionOwner = undefined
      }

      /** Retain one ambiguous prompt for an explicit user retry. This is a
       * process-local best-effort body, not a durable delivery proof: recovery
       * resumes persisted history and never submits it automatically. */
      const retainPendingPromptForRetry = (current: PendingPrompt, notice: string): boolean => {
        if (pendingPrompt !== current) return false
        pendingPrompt = undefined
        if (!store.enqueuePrompt(current.text, true)) {
          // sendPromptNow reserves this exact row/character capacity before it
          // clears the composer, so reaching this branch is an invariant defect.
          pendingPrompt = current
          getLog().error('submit', 'reserved retry queue insertion failed')
          store.pushSystem('prompt delivery uncertain — input is retained internally; clear queue capacity to retry')
          return false
        }
        store.removeClientMessage(current.clientMessageId)
        if (!store.isTurnInFlight()) store.applyInfo({ running: false })
        automaticQueueDrain.halt()
        store.pushSystem(notice)
        return true
      }

      const spawnTreeSaveDrainer = createSpawnTreeSaveDrainer({
        next: () => store.nextSpawnTreeSaveIntent(),
        settle: id => store.settleSpawnTreeSaveIntent(id),
        save: request => Effect.runPromise(gateway.request('spawn_tree.save', request)),
        onSaveFailure: (id, cause) =>
          getLog().warn('agents', 'spawn-tree persistence failed', {
            cause: String(cause),
            snapshot_id: id
          }),
        onInvariantFailure: (id, cause) =>
          getLog().error('agents', 'spawn-tree save intent settlement invariant failed', {
            ...(cause === undefined
              ? {}
              : { cause: cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown' }),
            snapshot_id: id
          })
      })

      const delegationStatusRefresher = createDelegationStatusRefresher({
        apply: raw => store.applyDelegationStatusResponse(raw),
        fetch: () => Effect.runPromise(gateway.request('delegation.status', {})),
        onFailure: cause => getLog().warn('agents', 'delegation.status failed', { cause: String(cause) }),
        onInvalid: () => getLog().warn('agents', 'invalid delegation.status response')
      })

      const activeSessionsRefresher = createDelegationStatusRefresher({
        intervalMs: 1_000,
        apply: raw => store.applyActiveSessionsResponse(raw, gateway.sessionId()),
        fetch: () =>
          Effect.runPromise(
            gateway.request('session.active_list', {
              current_session_id: gateway.sessionId() ?? ''
            })
          ),
        onFailure: cause => getLog().debug('sessions', 'session.active_list failed', { cause: String(cause) }),
        onInvalid: () => getLog().warn('sessions', 'invalid session.active_list response')
      })
      const activeSessionsTimer = setInterval(() => {
        if (gateway.sessionId()) void activeSessionsRefresher.refresh()
      }, 1_500)
      activeSessionsTimer.unref()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          clearInterval(activeSessionsTimer)
          activeSessionsRefresher.invalidate()
        })
      )

      // Side effects run only when the store actually commits an event. In
      // particular, a billing verification received during resume buffering is
      // delayed until SID filtering accepts it; stale-session events never open
      // a browser or leak their code into the successor transcript.
      let submitVoiceTranscript: (text: string) => void = () => {}
      store.registerCommittedEventHandler(event => {
        if (event.type === 'billing.step_up.verification') {
          presentBillingVerification(event.payload, { pushSystem: text => store.pushSystem(text) })
        } else if (event.type === 'voice.transcript' && !event.payload?.no_speech_limit) {
          const text = event.payload?.text?.trim()
          if (text) {
            store.clearComposerDraft()
            queueMicrotask(() => submitVoiceTranscript(text))
          }
        } else if (
          pendingPrompt &&
          (event.type === 'message.start' || event.type === 'message.complete') &&
          pendingPromptBoundaryMatches(pendingPrompt.submissionId, event.type, event.payload)
        ) {
          pendingPrompt = pendingPromptAfterBoundary(pendingPrompt, event.type)
        } else if (
          event.type === 'error' &&
          pendingPrompt &&
          pendingPromptBoundaryMatches(pendingPrompt.submissionId, event.type, event.payload)
        ) {
          if (pendingPromptDecision(event.type) === 'retain') {
            retainPendingPromptForRetry(
              pendingPrompt,
              'prompt failed before it started — message retained; send it explicitly to retry'
            )
          }
        } else if (event.type === 'gateway.exited' && pendingPrompt) {
          if (pendingPromptDecision(event.type) === 'retain') {
            retainPendingPromptForRetry(
              pendingPrompt,
              'prompt delivery uncertain after gateway exit — message retained; send it explicitly to retry'
            )
          }
        }

        if (event.type === 'subagent.spawn_requested' || event.type === 'subagent.start') {
          if (store.consumeAgentsNudge()) store.setStatus('subagents working · /agents to watch live')
          void delegationStatusRefresher.refresh(store.state.delegation.maxSpawnDepth === null)
        } else if (event.type === 'gateway.exited') {
          delegationStatusRefresher.invalidate()
          activeSessionsRefresher.invalidate()
        } else if (event.type === 'gateway.ready') {
          void delegationStatusRefresher.refresh(true)
          if (gateway.sessionId()) void activeSessionsRefresher.refresh(true)
        }
        void spawnTreeSaveDrainer.drain()
      })

      const enqueueTransitionSubmission = (item: TransitionSubmission): boolean => {
        const owner = activeTransitionOwner
        if (!owner || !transitionOwnerAccepts(heldTransitionOwner, owner)) {
          store.pushSystem(
            'session-switch input ownership changed — command retained; use /queue --clear before switching'
          )
          return false
        }
        if (!transitionQueueAccepts(transitionSubmissions, item)) {
          store.pushSystem(
            `session-switch queue full (${SESSION_TRANSITION_QUEUE_LIMIT} messages / ${Math.floor(
              SESSION_TRANSITION_QUEUE_MAX_CHARS / (1024 * 1024)
            )}M characters) — wait for the switch to finish`
          )
          return false
        }
        heldTransitionOwner ??= owner
        transitionSubmissions.push(item)
        store.pushSystem(`⏳ queued for the new session (${transitionSubmissions.length} queued)`)
        return true
      }

      const reportFailedTransitionSubmissions = (): void => {
        if (transitionSubmissions.length === 0) return
        const liveSessionId = gateway.sessionId()
        if (liveSessionId && store.state.sessionId === liveSessionId) {
          store.pushSystem(
            `${transitionSubmissions.length} queued submission(s) held for ${heldTransitionOwner ?? 'the failed switch'} — retry that target or use /queue --clear`
          )
          return
        }
        store.pushSystem(
          `${transitionSubmissions.length} queued submission(s) held for ${heldTransitionOwner ?? 'the failed switch'} — they will not cross into another session`
        )
      }

      const guardBusySessionSwitch = (what = 'switch sessions', requestedOwner?: string): boolean => {
        if (isTurnBusy()) {
          store.pushSystem(`interrupt the current turn before trying to ${what}`)
          return true
        }
        if (imageAttachInFlight) {
          store.pushSystem('wait for the image attachment before trying to switch sessions')
          return true
        }
        if (historyMutationInFlight) {
          store.pushSystem(`wait for the history update before trying to ${what}`)
          return true
        }
        if (pendingPrompt) {
          store.pushSystem(`wait for the pending prompt request before trying to ${what}`)
          return true
        }
        if (pendingSteerCount > 0) {
          store.pushSystem(`wait for ${pendingSteerCount} pending steer request(s) before trying to ${what}`)
          return true
        }
        if (store.queuedCount() > 0) {
          store.pushSystem(`send or delete ${store.queuedCount()} queued message(s) before trying to ${what}`)
          return true
        }
        if (heldTransitionBlocks(transitionSubmissions.length, heldTransitionOwner, requestedOwner)) {
          store.pushSystem(
            `${transitionSubmissions.length} held submission(s) belong to ${heldTransitionOwner ?? 'another switch'} — retry it or /queue --clear before trying to ${what}`
          )
          return true
        }
        if (isSessionTransitioning()) {
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
        if (isSessionTransitioning()) {
          recoverSid = resumeId
          schedulePendingRecovery()
          return
        }
        stableSessionOwnerId = recoveryLineageOwner(stableSessionOwnerId, resumeId)
        activeTransitionOwner = `resume:${resumeId}`
        sessionTransitionInFlight = true
        store.setHint('recovering session…')
        let transitionSucceeded = false
        Effect.runFork(
          Effect.gen(function* () {
            const liveSessionId = yield* resumeInto(gateway, store, resumeId, input.cols, 'same-session')
            pasteStore.retainOnly(store.state.composerDraft)
            transitionSucceeded = true
            Effect.runFork(
              postSessionSetup(gateway, store, liveSessionId).pipe(
                Effect.catchCause(cause =>
                  Effect.sync(() => getLog().warn('recover', 'post-resume setup failed', { cause: String(cause) }))
                )
              )
            )
          }).pipe(
            Effect.catchCause(cause => {
              if (recoveryTargetIsMissing(Cause.squash(cause))) {
                return Effect.gen(function* () {
                  // A never-persisted lazy session has no history to leak into
                  // another conversation. Create one replacement once, without
                  // replaying launch prompt/image seeds or inventing a durable
                  // idempotency contract the Ink client does not have.
                  activeTransitionOwner = 'new'
                  if (transitionSubmissions.length > 0) heldTransitionOwner = 'new'
                  stableSessionOwnerId = undefined
                  const recoveryInput: TuiInput = {
                    cols: input.cols,
                    fake: input.fake,
                    mouse: input.mouse
                  }
                  yield* createFreshSession(gateway, store, recoveryInput, sendPromptNow)
                  pasteStore.retainOnly(store.state.composerDraft)
                  stableSessionOwnerId = store.state.resumeId
                  transitionSucceeded = true
                }).pipe(
                  Effect.catchCause(createCause =>
                    Effect.sync(() => {
                      const error = Cause.squash(createCause)
                      const detail = error instanceof Error ? error.message : String(error)
                      getLog().warn('recover', 'fresh lazy-session replacement failed', { cause: detail })
                      store.pushSystem(`fresh-session recovery failed: ${detail} — use /new to retry`)
                    })
                  )
                )
              }
              return Effect.sync(() => {
                const error = Cause.squash(cause)
                const detail = error instanceof Error ? error.message : String(error)
                getLog().warn('recover', 'resume failed', { cause: detail })
                store.pushSystem(`recovery failed: ${detail} — use /resume to retry`)
              })
            }),
            Effect.ensuring(
              Effect.sync(() => {
                sessionTransitionInFlight = false
                if (store.state.hint === 'recovering session…') store.setHint(undefined)
                if (transitionSucceeded) {
                  if (store.queuedCount() > 0) {
                    if (transitionSubmissions.length > 0) {
                      promoteHeldAfterRecovery = true
                      promoteHeldTransitionSubmissions()
                    }
                    if (automaticQueueDrain.canDrain()) drainQueuedIfIdle()
                  } else {
                    drainTransitionSubmissions()
                  }
                } else reportFailedTransitionSubmissions()
                releaseTransitionOwnerUnlessPromoting()
                if (recoverSid) schedulePendingRecovery()
              })
            )
          )
        )
      }

      yield* gateway.subscribe(event => {
        if (!eventMayEnterStore(event, gateway.sessionId(), store.isBuffering())) return
        const liveSessionId = gateway.sessionId()
        const eventSessionId = event.session_id ?? liveSessionId
        const fence = advancePreStartCancellationFence(
          preStartCancellationSessionId,
          liveSessionId,
          eventSessionId,
          event.type,
          event.type === 'session.info' ? event.payload.running : undefined
        )
        preStartCancellationSessionId = fence.sessionId
        store.apply(
          fence.suppressRunning && event.type === 'session.info'
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  running: runningAfterPreStartFence(
                    fence.suppressRunning,
                    store.state.info.running,
                    event.payload.running
                  )
                }
              }
            : event
        )
        if (fence.confirmedIdle) queueMicrotask(drainQueuedIfIdle)
        if (event.type === 'gateway.exited') {
          preStartCancellationSessionId = undefined
          gatewayUnavailable = true
          activeTransitionOwner ??= recoveryTransitionOwner(store.state.resumeId)
          recoverSid = store.state.resumeId
        } else if (event.type === 'gateway.ready' && recoverSid !== undefined) {
          gatewayUnavailable = false
          const sid = recoverSid
          recoverSid = undefined
          startRecovery(sid)
        } else if (event.type === 'gateway.ready') {
          gatewayUnavailable = false
          if (!sessionTransitionInFlight) activeTransitionOwner = undefined
        }
      })

      // Match Ink's live config sync: poll the config file mtime every five
      // seconds, refresh MCP state for the active session, then rehydrate the
      // TUI-specific busy-input policy from `config.get full`. This is scoped to
      // the renderer lifetime (no orphan interval/fiber after exit), and every
      // result is session-fenced before it mutates the live store.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(CONFIG_MTIME_POLL)
              const sid = gateway.sessionId()
              if (!store.state.ready || !sid || store.state.sessionId !== sid) return
              const rawMtime = yield* gateway
                .request<unknown>('config.get', { key: 'mtime' })
                .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
              const decodedMtime = decodeConfigMtimeResponse(rawMtime)
              const nextMtime = decodedMtime?.mtime ?? 0
              // `isTurnBusy` includes the server-confirmed-idle settle latch,
              // not just the optimistic spinner flag. A changed mtime remains
              // pending until an idle poll can safely request the global MCP
              // mutation; a server-side 4009 closes the final admission race.
              const plan = configSync.plan(nextMtime, configSyncBlocked(isTurnBusy(), isSessionTransitioning()))
              if (!plan) return
              const busyModeRevision = store.getBusyInputModeRevision()

              if (plan.reload) {
                const reload = yield* gateway
                  .request<unknown>('reload.mcp', { confirm: true, session_id: sid })
                  .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
                if (!configSync.completeReload(plan, mcpReloadSucceeded(reload))) return
              }

              const rawConfig = yield* gateway
                .request<unknown>('config.get', { key: 'full' })
                .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
              const decodedConfig = decodeConfigFullResponse(rawConfig)
              const active = gateway.sessionId() === sid && store.state.sessionId === sid
              if (!decodedConfig || !active) return

              store.hydrateBusyInputMode(busyInputModeFromConfig(decodedConfig.config), busyModeRevision)
              store.setVoiceMode({ recordKey: voiceRecordKeyFromConfig(decodedConfig.config) })
              if (configSync.completeHydration(plan, true) && plan.kind === 'change') {
                store.pushSystem('MCP reloaded after config change')
              }
            })
          )
        })
      )

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
        const interruptedBeforeStart = !store.isTurnInFlight()
        const interruptedPrompt = pendingPrompt
        Effect.runFork(
          gateway.request('session.interrupt', { session_id: sid }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                // An interrupt during deferred agent construction has no
                // message.start and no server session.info settlement. The
                // successful interrupt response is the user's explicit cancel
                // boundary; discard the local optimistic row without inventing
                // correlation/proof fields the Ink client does not use.
                if (
                  pendingPrompt === interruptedPrompt &&
                  interruptedPrompt?.sessionId === sid &&
                  gateway.sessionId() === sid
                ) {
                  if (interruptedBeforeStart && !store.isTurnInFlight()) {
                    preStartCancellationSessionId = sid
                    pendingPrompt = pendingPromptAfterBoundary(interruptedPrompt, 'interrupt.success')
                    store.removeClientMessage(interruptedPrompt.clientMessageId)
                    store.pushSystem(
                      store.queuedCount() > 0
                        ? 'prompt cancelled before it started — queued messages retained; send one explicitly when ready'
                        : 'prompt cancelled before it started'
                    )
                    store.applyInfo({ running: false })
                  } else {
                    // A correlated prompt still pending while some other turn
                    // runs is in the gateway's queued slot. session.interrupt
                    // deliberately clears that slot, so restore the body to the
                    // explicit-only local queue instead of leaving it stranded.
                    retainPendingPromptForRetry(
                      interruptedPrompt,
                      'queued prompt cancelled with the interrupted turn — message retained; send it explicitly to retry'
                    )
                  }
                }
              })
            ),
            Effect.catchCause(cause =>
              Effect.sync(() => getLog().warn('interrupt', 'failed', { cause: String(cause) }))
            )
          )
        )
      }
      const requestDashboardNewSession = () => {
        // Both hosted exit gestures replace the PTY. Keep them behind the same
        // loss-prevention fence as /resume and /new: a draft is not represented
        // in either queue, and the shared guard covers active turns, queued
        // input, pending steers, history mutations, and session transitions.
        if (store.state.composerDraft) {
          store.pushSystem('submit or clear the current draft before starting a fresh dashboard chat')
          return
        }
        if (guardBusySessionSwitch('start a fresh dashboard chat')) return
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
        if (isTurnBusy()) {
          interruptTurn()
          if (!hostedDashboard) armQuit('⏹ stopped — Ctrl+C again to quit')
          return
        }
        // An idle non-empty composer clears before any exit gesture, matching
        // Ink's input-first Ctrl+C precedence.
        if (store.state.composerDraft) {
          // This is an explicit abandon, not a session clear→restore. Release
          // every large-paste body before clearing the visible token/draft.
          pasteStore.clear()
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
      const showPasteLimit = (maxBytes: number): void => {
        const mebibytes = Math.max(1, Math.floor(maxBytes / (1024 * 1024)))
        flashHint(`paste exceeds the ${mebibytes} MiB input-memory limit — split it and retry`, 3500)
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
      const proactiveGc = startProactiveGc(isTurnBusy)
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
      let toggleVoiceRecording: () => void = () => {}
      const onGlobalAction = (key: KeyEvent) => {
        if (
          isVoiceRecordKey(key, store.state.voice.recordKey) &&
          !actionExitBlocked(store.state) &&
          activeTransitionOwner === undefined &&
          store.state.queueEditIndex === undefined &&
          store.state.completions === undefined
        ) {
          key.preventDefault()
          toggleVoiceRecording()
          return
        }
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

      const nonTransitionReservedQueueItems = () => pendingSteerCount + (pendingPrompt ? 1 : 0)
      const nonTransitionReservedQueueChars = () => pendingSteerCharacters + (pendingPrompt?.text.length ?? 0)
      const heldQueueReservation = () =>
        promoteHeldAfterRecovery ? transitionQueueReservation(transitionSubmissions) : { chars: 0, count: 0 }
      const reservedQueueItems = () => nonTransitionReservedQueueItems() + heldQueueReservation().count
      const reservedQueueChars = () => nonTransitionReservedQueueChars() + heldQueueReservation().chars
      const canSteer = (text: string, front = false) =>
        steerSlotAvailable(front, pendingSteers.values()) &&
        pendingSteerCount < PENDING_STEER_LIMIT &&
        text.length <= PENDING_STEER_MAX_CHARS &&
        pendingSteerCharacters + text.length <= PENDING_STEER_MAX_CHARS &&
        queueAccepts(store.state.queuedPrompts, text, undefined, reservedQueueItems(), reservedQueueChars())

      /** Add a client-side queued prompt without ever silently dropping it at
       * the fixed memory ceiling. */
      const enqueueClientPrompt = (text: string, front = false): boolean => {
        // Pending steer bodies reserve their eventual fallback slots/bytes. A
        // normal enqueue may not consume that capacity while the RPC is live.
        if (!queueAccepts(store.state.queuedPrompts, text, undefined, reservedQueueItems(), reservedQueueChars())) {
          store.pushSystem(BUSY_QUEUE_FULL_MESSAGE)
          return false
        }
        if (store.enqueuePrompt(text, front)) return true
        store.pushSystem(BUSY_QUEUE_FULL_MESSAGE)
        return false
      }

      /** Best-effort steer admission. Pending text reserves bounded fallback
       * capacity only until the RPC settles; no id, ledger, or post-crash proof
       * is invented. Definite rejection joins the normal queue. Ambiguous
       * transport delivery also joins it, but closes automatic draining until
       * the user explicitly chooses to retry. */
      const issueSteer = (sessionId: string, text: string, front = false): Promise<SteerDelivery> => {
        if (!canSteer(text, front)) throw new Error('steer reservation unavailable')
        pendingSteerCount += 1
        pendingSteerCharacters += text.length
        const sequence = ++pendingSteerSequence

        const drainSettledSteers = (): void => {
          const settled = takeSettledSteerPrefix(pendingSteers)
          if (settled.length === 0) return
          for (const request of settled) {
            pendingSteerCount = Math.max(0, pendingSteerCount - 1)
            pendingSteerCharacters = Math.max(0, pendingSteerCharacters - request.text.length)
          }

          const deliveries = new Map<PendingSteerRequest, SteerDelivery>()
          const needsRetention = settled.filter(request => request.outcome !== 'accepted')
          for (const request of steerRetentionOrder(needsRetention)) {
            const retained = enqueueClientPrompt(request.text, request.front)
            if (!retained) {
              deliveries.set(request, 'retained')
              continue
            }
            if (request.outcome === 'uncertain') {
              automaticQueueDrain.halt()
              deliveries.set(request, 'uncertain')
            } else {
              deliveries.set(request, 'fallback')
            }
          }

          let shouldDrain = false
          for (const request of settled) {
            const delivery = request.outcome === 'accepted' ? 'accepted' : (deliveries.get(request) ?? 'retained')
            if (delivery === 'fallback') shouldDrain = true
            request.resolve(delivery)
          }
          if (shouldDrain && automaticQueueDrain.canDrain() && !isTurnBusy()) {
            queueMicrotask(drainQueuedIfIdle)
          }
        }

        return new Promise<SteerDelivery>(resolve => {
          pendingSteers.set(sequence, { front, resolve, text })
          void Effect.runPromise(
            gateway.request<unknown>('session.steer', { session_id: sessionId, text }).pipe(
              Effect.map(classifySessionSteerResponse),
              Effect.catchTag('GatewayError', error =>
                Effect.succeed<SessionSteerDisposition>(deliveryFailureIsUncertain(error) ? 'uncertain' : 'rejected')
              )
            )
          ).then(
            outcome => {
              const request = pendingSteers.get(sequence)
              if (!request) return
              request.outcome = outcome
              drainSettledSteers()
            },
            () => {
              const request = pendingSteers.get(sequence)
              if (!request) return
              request.outcome = 'uncertain'
              drainSettledSteers()
            }
          )
        })
      }

      /** Start one real user turn and synchronously mark it running before the
       * RPC round-trip, closing the double-Enter race that otherwise launches
       * two prompt.submit calls before message.start arrives. */
      sendPromptNow = (text: string, skillCommand?: string): boolean => {
        const sid = gateway.sessionId()
        if (!sid) {
          getLog().warn('submit', 'no active session', { text })
          store.pushSystem('no active session — run /new to retry')
          return false
        }
        if (pendingPrompt) {
          store.pushSystem('a prompt is still waiting for gateway acceptance — input retained')
          return false
        }
        // The in-flight body must always fit back into the bounded queue after
        // ambiguous delivery. Reject synchronously so the composer keeps it
        // when that reservation cannot be made.
        const held = heldQueueReservation()
        if (
          text.length > BUSY_QUEUE_MAX_CHARS ||
          !queueAccepts(
            store.state.queuedPrompts,
            text,
            undefined,
            pendingSteerCount + held.count,
            pendingSteerCharacters + held.chars
          )
        ) {
          store.pushSystem(BUSY_QUEUE_FULL_MESSAGE)
          return false
        }
        const clientMessageId = skillCommand ? store.pushSkill(skillCommand, text) : store.pushUser(text)
        const current: PendingPrompt = { clientMessageId, submissionId: randomUUID(), sessionId: sid, text }
        pendingPrompt = current
        store.applyInfo({ running: true })

        Effect.runFork(
          gateway.request('prompt.submit', { client_submission_id: current.submissionId, session_id: sid, text }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                // An ACK only means the request handler spawned deferred startup.
                // Keep the body cancelable until committed message.start.
                if (pendingPrompt === current) {
                  pendingPrompt = pendingPromptAfterBoundary(current, 'rpc-ack')
                }
              })
            ),
            Effect.catchTag('GatewayError', error =>
              Effect.sync(() => {
                const notice = deliveryFailureIsUncertain(error)
                  ? 'prompt delivery uncertain — message retained; send it explicitly to retry'
                  : 'prompt rejected before start — message retained; send it explicitly to retry'
                retainPendingPromptForRetry(current, notice)
                getLog().warn('submit', 'failed', { error: error.message, reason: error.reason })
              })
            ),
            Effect.catchCause(cause =>
              Effect.sync(() => {
                retainPendingPromptForRetry(
                  current,
                  'prompt delivery uncertain — message retained; send it explicitly to retry'
                )
                getLog().warn('submit', 'unexpected failure', { cause: String(cause) })
              })
            )
          )
        )
        return true
      }

      /** Apply the configured busy-input mode. Queue edits can request a front
       * fallback so a failed steer never changes FIFO order. */
      const handleBusyInput = (text: string, front = false): boolean =>
        submitWhileBusy(
          {
            enqueue: enqueueClientPrompt,
            canSteer,
            haltAutomaticDrain: () => {
              automaticQueueDrain.halt()
            },
            interrupt: interruptTurn,
            mode: () => store.state.busyInputMode,
            pushSystem: message => store.pushSystem(message),
            sessionId: () => gateway.sessionId(),
            setStatus: message => store.setStatus(message),
            steer: issueSteer
          },
          text,
          front
        )

      const steerDirect = (
        sessionId: string,
        text: string
      ): Promise<'fallback' | 'queued' | 'retained' | 'saturated' | 'uncertain'> => {
        if (!canSteer(text)) return Promise.resolve('saturated')
        try {
          return issueSteer(sessionId, text).then(delivery => (delivery === 'accepted' ? 'queued' : delivery))
        } catch {
          return Promise.resolve('saturated')
        }
      }

      // Submit a user turn: transition-safe, policy-aware, and synchronous about
      // whether the composer may clear its uncontrolled textarea.
      const submitPrompt = (text: string): boolean => {
        if (isSessionTransitioning()) {
          return enqueueTransitionSubmission({ kind: 'prompt', text })
        }
        if (promoteHeldAfterRecovery && transitionSubmissions.length > 0) {
          // Preserve pre-crash FIFO and liveness: new input joins behind the
          // older held recovery list instead of repeatedly refilling the one
          // normal-queue slot that promotion needs to make progress.
          return enqueueTransitionSubmission({ kind: 'prompt', text })
        }
        if (historyMutationInFlight) {
          const accepted = enqueueClientPrompt(text)
          if (accepted) store.pushSystem(`⏳ queued until the history update finishes (${store.queuedCount()} queued)`)
          return accepted
        }
        if (isTurnBusy()) return handleBusyInput(text)
        return sendPromptNow(text)
      }

      submitVoiceTranscript = text => {
        submitPrompt(text)
      }
      toggleVoiceRecording = () => {
        if (!store.state.voice.enabled) {
          store.pushSystem('voice: mode is off — enable with /voice on')
          return
        }
        const starting = !store.state.voice.recording
        store.setVoiceActivity(starting, false)
        const action = starting ? 'start' : 'stop'
        Effect.runPromise(gateway.request('voice.record', { action, session_id: gateway.sessionId() ?? null }))
          .then(raw => {
            const response = decodeVoiceRecordResponse(raw)
            if (!response) throw new Error('invalid response: voice.record')
            if (starting && response.status !== 'recording') {
              store.setVoiceActivity(false, response.status === 'busy')
              if (response.status === 'busy') store.pushSystem('voice: still transcribing; try again shortly')
            }
          })
          .catch(error => {
            if (starting) store.setVoiceActivity(false, false)
            store.pushSystem(`voice error: ${error instanceof Error ? error.message : String(error)}`)
          })
      }

      // Submit a SKILL invocation (e.g. /dogfood): the full skill body still
      // goes to the model (so the model consumes the skill, prompt-cache intact),
      // but the transcript renders a COLLAPSED `▶ /name · N lines` row via
      // pushSkill instead of dumping the whole body as a giant user bubble
      // (glitch 2026-06-23). Mirrors submitPrompt's busy-guard + send path.
      const submitSkill = (command: string, body: string): boolean => {
        if (isSessionTransitioning()) {
          return enqueueTransitionSubmission({ body, command, kind: 'skill' })
        }
        if (promoteHeldAfterRecovery && transitionSubmissions.length > 0) {
          return enqueueTransitionSubmission({ body, command, kind: 'skill' })
        }
        if (historyMutationInFlight) {
          const accepted = enqueueClientPrompt(body)
          if (accepted) {
            store.pushSystem(`⏳ queued until the history update finishes (${store.queuedCount()} queued)`)
          }
          return accepted
        }
        if (isTurnBusy()) {
          return handleBusyInput(body)
        }
        return sendPromptNow(body, command)
      }

      drainTransitionSubmissions = (): void => {
        // A successful session transition is an ownership boundary. If the
        // guarded source queue is empty, do not let an already-explicitly
        // resolved ambiguity epoch pin newly authored transition submissions.
        automaticQueueDrain.resetIfEmpty(store.queuedCount())
        if (transitionSubmissions.length === 0) {
          heldTransitionOwner = undefined
          return
        }
        if (!transitionOwnerAccepts(heldTransitionOwner, activeTransitionOwner)) {
          reportFailedTransitionSubmissions()
          return
        }
        const { first } = planTransitionDrain(transitionSubmissions)
        // Exactly one request may start immediately. The remaining inputs join
        // the existing one-per-server-confirmed-turn queue; firing them all in
        // one tick races message.start and causes 4009 drops.
        const started =
          first?.kind === 'prompt' ? submitPrompt(first.text) : first ? submitSkill(first.command, first.body) : false
        if (!started) {
          reportFailedTransitionSubmissions()
          return
        }
        transitionSubmissions.shift()
        let accepted = 0
        while (transitionSubmissions.length > 0) {
          const next = transitionSubmissions[0]
          if (!next) break
          const text = transitionSubmissionText(next)
          if (!enqueueClientPrompt(text)) break
          transitionSubmissions.shift()
          accepted += 1
        }
        if (accepted > 0) store.pushSystem(`⏳ ${accepted} more queued for this session`)
        if (transitionSubmissions.length > 0) promoteHeldAfterRecovery = true
        else heldTransitionOwner = undefined
      }

      // `!cmd` — run a shell command directly (Ink/free-code parity: F9). The
      // gateway's `shell.exec` runs it (30s timeout, dangerous/hardline guards)
      // and returns {stdout, stderr, code}; we echo the invocation as a user line
      // and the combined output (or the error / non-zero exit) as a system line.
      // No model turn — this never hits prompt.submit. Detached like submitPrompt.
      const runShell = (cmd: string) => {
        if (!cmd) return
        store.pushLocalUser(`!${cmd}`, 'shell')
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
        const transitionOwner = `resume:${resumeSid}`
        if (guardBusySessionSwitch('switch sessions', transitionOwner)) return
        clearModelPrefetch()
        activeTransitionOwner = transitionOwner
        sessionTransitionInFlight = true
        store.setHint('resuming…')
        let transitionSucceeded = false
        Effect.runFork(
          Effect.gen(function* () {
            const liveSessionId = yield* resumeInto(gateway, store, resumeSid, input.cols, 'draft')
            pasteStore.retainOnly(store.state.composerDraft)
            stableSessionOwnerId = store.state.resumeId ?? resumeSid
            transitionSucceeded = true
            activeSessionsRefresher.invalidate()
            void activeSessionsRefresher.refresh(true)
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
                releaseTransitionOwnerUnlessPromoting()
              })
            )
          )
        )
      }

      // The unified Sessions orchestrator owns only transport calls. Live-list
      // commits remain centralized in the generation-fenced refresher so a
      // late response can never overwrite a newer activation/create result.
      const sessionOps: SessionOrchestratorOps = {
        history: () =>
          Effect.runPromise(
            gateway.request('session.list', {
              limit: 200,
              offset: 0,
              query: '',
              scope: 'all',
              sort: 'recent'
            })
          ),
        refresh: () => activeSessionsRefresher.refresh(true).then(() => undefined),
        close: sessionId => Effect.runPromise(gateway.request('session.close', { session_id: sessionId })),
        delete: sessionId => Effect.runPromise(gateway.request('session.delete', { session_id: sessionId }))
      }

      // The background-process panel's gateway calls (view/overlays/backgroundPanel.tsx):
      // `agents.list` lists the OS process registry; `process.stop` kills ALL of them
      // (the gateway exposes kill-all only — no per-process RPC, hence no per-row kill).
      const backgroundOps = {
        list: () => Effect.runPromise(gateway.request('agents.list', {})).then(parseProcessList),
        stopAll: () => Effect.runPromise(gateway.request('process.stop', {})).then(() => undefined)
      }

      const journeyOps = {
        frames: (cols: number, rows: number) =>
          Effect.runPromise(gateway.request('learning.frames', { cols, frames: 2, rows })),
        detail: (id: string) => Effect.runPromise(gateway.request('learning.detail', { id })),
        edit: (id: string, content: string) => Effect.runPromise(gateway.request('learning.edit', { content, id })),
        delete: (id: string) => Effect.runPromise(gateway.request('learning.delete', { id }))
      }
      const agentsOps = {
        refresh: () => delegationStatusRefresher.refresh(true).then(() => undefined),
        interrupt: async (id: string): Promise<string> => {
          try {
            const raw = await Effect.runPromise(gateway.request('subagent.interrupt', { subagent_id: id }))
            const decoded = decodeSubagentInterruptResponse(raw)
            if (Option.isNone(decoded)) throw new Error('invalid response')
            return decoded.value.found ? `killing ${id}` : `not found: ${id}`
          } catch {
            throw new Error(`kill failed: ${id}`)
          }
        },
        interruptSubtree: (ids: readonly string[]): Promise<void> => {
          for (const id of ids) {
            void Effect.runPromise(gateway.request('subagent.interrupt', { subagent_id: id })).catch(cause =>
              getLog().warn('agents', 'subtree interrupt failed', { cause: String(cause), subagent_id: id })
            )
          }
          return Promise.resolve()
        },
        setPaused: async (paused: boolean): Promise<string> => {
          try {
            const raw = await Effect.runPromise(gateway.request('delegation.pause', { paused }))
            if (!store.applyDelegationPauseResponse(raw)) throw new Error('invalid response')
            return store.state.delegation.paused ? 'spawning paused' : 'spawning resumed'
          } catch {
            throw new Error('pause failed')
          }
        }
      }

      // Boot-picker Esc fallback: the picker closed without a pick and no
      // session exists yet (bare `--resume` launch) — create a fresh one so
      // the composer has somewhere to send prompts.
      const onSessionPickerClosed = () => {
        if (gateway.sessionId()) return
        if (guardBusySessionSwitch('start a session', 'new')) return
        clearModelPrefetch()
        activeTransitionOwner = 'new'
        sessionTransitionInFlight = true
        store.setHint('starting session…')
        let transitionSucceeded = false
        Effect.runFork(
          createFreshSession(gateway, store, input, sendPromptNow).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                transitionSucceeded = gateway.sessionId() !== undefined
                if (transitionSucceeded) stableSessionOwnerId = store.state.resumeId
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
                releaseTransitionOwnerUnlessPromoting()
              })
            )
          )
        )
      }

      const startNewSession = (message?: string, title?: string): void => {
        if (guardBusySessionSwitch('start a new session', 'new')) return
        clearModelPrefetch()
        activeTransitionOwner = 'new'
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
                const draft = store.state.composerDraft
                store.detachSession()
                if (draft) {
                  pasteStore.retainOnly(draft)
                  store.replaceComposerDraft(draft)
                } else pasteStore.clear()
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

            const draft = store.state.composerDraft
            store.adoptFreshSession(result.sessionId, result.info, result.resumeId)
            if (draft) {
              pasteStore.retainOnly(draft)
              store.replaceComposerDraft(draft)
            } else pasteStore.clear()
            writeActiveSession(result.resumeId)
            stableSessionOwnerId = result.resumeId
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
                releaseTransitionOwnerUnlessPromoting()
              })
            )
          )
        )
      }

      const startNewLiveSession = async (message?: string, title?: string): Promise<string | undefined> => {
        if (isSessionTransitioning()) {
          store.pushSystem('a session switch is already in progress')
          return undefined
        }
        if (imageAttachInFlight || historyMutationInFlight || pendingPrompt || pendingSteerCount > 0) {
          store.pushSystem('finish the current session mutation before starting a live sibling')
          return undefined
        }
        if (store.queuedCount() > 0) {
          store.pushSystem(`send or delete ${store.queuedCount()} queued message(s) before starting a live sibling`)
          return undefined
        }
        if (heldTransitionBlocks(transitionSubmissions.length, heldTransitionOwner, 'live-new')) {
          store.pushSystem('held submissions belong to another session switch — retry it or /queue --clear')
          return undefined
        }
        clearModelPrefetch()
        activeTransitionOwner = 'live-new'
        sessionTransitionInFlight = true
        store.closeSessionPicker()
        store.setHint('starting live session…')
        let transitionSucceeded = false
        try {
          const created = await Effect.runPromise(
            createSession(gateway, {
              cols: input.cols,
              cwd: launchCwd()
            })
          )
          store.adoptFreshSession(created.sessionId, created.info, created.resumeId)
          pasteStore.clear()
          writeActiveSession(created.resumeId)
          stableSessionOwnerId = created.resumeId
          store.setStatus('starting agent…')
          if (message) store.pushSystem(message)
          const requestedTitle = title?.trim()
          if (requestedTitle) {
            void Effect.runPromise(
              gateway.request('session.title', {
                session_id: created.sessionId,
                title: requestedTitle
              })
            ).catch(cause => getLog().warn('sessions', 'live-session title failed', { cause: String(cause) }))
          }
          Effect.runFork(
            postSessionSetup(gateway, store, created.sessionId).pipe(
              Effect.catchCause(cause =>
                Effect.sync(() => getLog().warn('sessions', 'live-session setup failed', { cause: String(cause) }))
              )
            )
          )
          transitionSucceeded = true
          activeSessionsRefresher.invalidate()
          void activeSessionsRefresher.refresh(true)
          return created.sessionId
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause)
          store.pushSystem(`new live session failed: ${detail}`)
          return undefined
        } finally {
          sessionTransitionInFlight = false
          if (store.state.hint === 'starting live session…') store.setHint(undefined)
          if (transitionSucceeded) drainTransitionSubmissions()
          else reportFailedTransitionSubmissions()
          releaseTransitionOwnerUnlessPromoting()
        }
      }

      /** Switch the visible owner to an already-live sibling. Unlike a cold
       * resume, the source is allowed to keep running in the gateway. Local
       * mutations and reserved input are still fenced because those are owned
       * by this one renderer and must never be reassigned to the target. */
      const activateLiveSession = (targetSessionId: string): void => {
        const target = targetSessionId.trim()
        if (!target || target === gateway.sessionId()) {
          store.closeSessionPicker()
          return
        }
        if (imageAttachInFlight) {
          store.pushSystem('wait for the image attachment before switching live sessions')
          return
        }
        if (historyMutationInFlight) {
          store.pushSystem('wait for the history update before switching live sessions')
          return
        }
        if (pendingPrompt) {
          store.pushSystem('wait for the pending prompt request before switching live sessions')
          return
        }
        if (pendingSteerCount > 0) {
          store.pushSystem(`wait for ${pendingSteerCount} pending steer request(s) before switching live sessions`)
          return
        }
        if (store.queuedCount() > 0) {
          store.pushSystem(`send or delete ${store.queuedCount()} queued message(s) before switching live sessions`)
          return
        }
        const transitionOwner = `activate:${target}`
        if (heldTransitionBlocks(transitionSubmissions.length, heldTransitionOwner, transitionOwner)) {
          store.pushSystem(
            `${transitionSubmissions.length} held submission(s) belong to ${heldTransitionOwner ?? 'another switch'} — retry it or /queue --clear before switching live sessions`
          )
          return
        }
        if (isSessionTransitioning()) {
          store.pushSystem('a session switch is already in progress')
          return
        }

        clearModelPrefetch()
        activeTransitionOwner = transitionOwner
        sessionTransitionInFlight = true
        store.closeSessionPicker()
        store.setHint('switching session…')
        let transitionSucceeded = false
        Effect.runFork(
          activateSession(gateway, store, { targetSessionId: target }).pipe(
            Effect.tap(result =>
              Effect.sync(() => {
                pasteStore.retainOnly(store.state.composerDraft)
                stableSessionOwnerId = result.resumeId
                writeActiveSession(result.resumeId)
                transitionSucceeded = true
                Effect.runFork(
                  postSessionSetup(gateway, store, result.sessionId).pipe(
                    Effect.catchCause(cause =>
                      Effect.sync(() =>
                        getLog().warn('sessions', 'post-activate setup failed', { cause: String(cause) })
                      )
                    )
                  )
                )
                activeSessionsRefresher.invalidate()
                void activeSessionsRefresher.refresh(true)
              })
            ),
            Effect.catchCause(cause =>
              Effect.sync(() => {
                const error = Cause.squash(cause)
                const detail = error instanceof Error ? error.message : String(error)
                getLog().warn('sessions', 'activate failed', { cause: detail, target })
                store.pushSystem(`session switch failed: ${detail}`)
              })
            ),
            Effect.ensuring(
              Effect.sync(() => {
                sessionTransitionInFlight = false
                if (store.state.hint === 'switching session…') store.setHint(undefined)
                if (transitionSucceeded) drainTransitionSubmissions()
                else reportFailedTransitionSubmissions()
                releaseTransitionOwnerUnlessPromoting()
              })
            )
          )
        )
      }

      const startBranchSession = (name: string): void => {
        const owner = `branch:${gateway.sessionId() ?? 'detached'}`
        if (guardBusySessionSwitch('branch the session', owner)) return
        clearModelPrefetch()
        activeTransitionOwner = owner
        sessionTransitionInFlight = true
        store.setHint('branching session…')
        let transitionSucceeded = false
        Effect.runFork(
          branchSession(gateway, store, { name }).pipe(
            Effect.tap(result =>
              Effect.sync(() => {
                pasteStore.retainOnly(store.state.composerDraft)
                stableSessionOwnerId = result.resumeId
                writeActiveSession(result.resumeId)
                store.pushSystem(`branched → ${result.title}`)
                if (result.closeFailed)
                  store.pushSystem('warning: branch created, but parent session could not be closed')
                transitionSucceeded = true
                activeSessionsRefresher.invalidate()
                void activeSessionsRefresher.refresh(true)
                Effect.runFork(
                  postSessionSetup(gateway, store, result.childSessionId).pipe(
                    Effect.catchCause(cause =>
                      Effect.sync(() => getLog().warn('branch', 'post-branch setup failed', { cause: String(cause) }))
                    )
                  )
                )
              })
            ),
            Effect.catchCause(cause =>
              Effect.sync(() => {
                const error = Cause.squash(cause)
                store.pushSystem(`branch failed: ${error instanceof Error ? error.message : String(error)}`)
              })
            ),
            Effect.ensuring(
              Effect.sync(() => {
                sessionTransitionInFlight = false
                if (store.state.hint === 'branching session…') store.setHint(undefined)
                if (transitionSucceeded) drainTransitionSubmissions()
                else reportFailedTransitionSubmissions()
                releaseTransitionOwnerUnlessPromoting()
              })
            )
          )
        )
      }

      /** Create a kept-live sibling, apply the exact Ink config.set model
       * contract, then consume the draft only after prompt admission. */
      const startNewPromptSession = async (prompt: string, modelArg?: string): Promise<void> => {
        store.closeSessionPicker()
        await coordinatePromptLiveSession({
          create: () => startNewLiveSession('new live session started'),
          ...(modelArg === undefined ? {} : { modelArg }),
          notify: message => store.pushSystem(message),
          onModelSwitched: value => {
            if (gateway.sessionId() === store.state.sessionId) store.applyInfo({ model: value })
          },
          owns: sessionId => gateway.sessionId() === sessionId && store.state.sessionId === sessionId,
          prompt,
          restore: (text, notice) => {
            store.replaceComposerDraft(text)
            store.pushSystem(notice)
          },
          submit: text => sendPromptNow(text),
          switchModel: async (sessionId, requestedModel) => {
            const raw = await Effect.runPromise(
              gateway.request('config.set', {
                key: 'model',
                session_id: sessionId,
                value: requestedModel
              })
            )
            const decoded = decodeConfigValueResponse(raw)
            const value = decoded?.value.trim() ?? ''
            if (!value) throw new Error('invalid response: model switch')
            if (raw && typeof raw === 'object') {
              const warning = (raw as { warning?: unknown }).warning
              if (typeof warning === 'string' && warning.trim()) store.pushSystem(`warning: ${warning.trim()}`)
            }
            return value
          }
        })
      }

      const loadSessionModelItems = async (): Promise<readonly PickerItem[]> => {
        const sessionId = gateway.sessionId()
        if (!sessionId) return []
        const cached = store.state.modelItems
        if (cached?.length) return cached
        await awaitModelPrefetch(sessionId)
        if (gateway.sessionId() !== sessionId) return []
        const hydrated = store.state.modelItems
        if (hydrated?.length) return hydrated
        const raw = await Effect.runPromise(gateway.request('model.options', { session_id: sessionId }))
        if (gateway.sessionId() !== sessionId) return []
        const items = mapModelOptions(raw)
        if (items.length) store.setModelItems(items)
        return items
      }

      const suspendSync = (run: () => void): void => {
        renderer.suspend()
        try {
          run()
        } finally {
          renderer.resume()
        }
      }
      const openExternalEditor = async (seed: string): Promise<void> => {
        const original = seed || store.state.composerDraft
        let edited: null | string
        try {
          edited = await openInEditor(original, suspendSync, '.md')
        } catch (error) {
          store.pushSystem('external editor: ' + (error instanceof Error ? error.message : String(error)))
          return
        }
        if (edited === null) return
        const text = edited.trimEnd()
        if (!text) return
        store.replaceComposerDraft('')
        if (submitPrompt(text) === false) store.replaceComposerDraft(text)
      }
      const attachImage = async (inputText: string): Promise<void> => {
        const sid = gateway.sessionId()
        if (!sid) {
          store.pushSystem('no active session')
          return
        }
        const raw = await Effect.runPromise(
          gateway.request<unknown>('image.attach', { path: inputText, session_id: sid })
        )
        const response = decodeImageAttachResponse(raw)
        if (!response) {
          store.pushSystem('error: invalid response: image.attach')
          return
        }
        store.pushSystem(attachedImageNotice(response))
        if (response.remainder) store.replaceComposerDraft(response.remainder)
      }
      const configureTerminal = async (target: string): Promise<void> => {
        const result =
          target === 'auto'
            ? await configureDetectedTerminalKeybindings()
            : await configureTerminalKeybindings(target as 'cursor' | 'vscode' | 'windsurf')
        store.pushSystem(result.message)
        if (result.success && result.requiresRestart)
          store.pushSystem('restart the IDE terminal for the new keybindings to take effect')
      }
      const runExternalSetup = async (args: readonly string[]): Promise<void> => {
        store.pushSystem('launching `hermes ' + args.join(' ') + '`…')
        store.setHint('setup running…')
        renderer.suspend()
        let result
        try {
          result = await launchHermesCommand([...args])
        } finally {
          renderer.resume()
        }
        if (result.error) {
          store.pushSystem('error launching hermes: ' + result.error)
          store.setHint('setup required')
          return
        }
        if (result.code !== 0) {
          store.pushSystem('hermes ' + args[0] + ' exited with code ' + String(result.code))
          store.setHint('setup required')
          return
        }
        const raw = await Effect.runPromise(gateway.request<unknown>('setup.status', {}))
        const setup = decodeSetupStatusResponse(raw)
        if (!setup) {
          store.pushSystem('error: invalid response: setup.status')
          store.setHint('setup required')
          return
        }
        if (setup.provider_configured === false) {
          store.pushSystem('still no provider configured')
          store.setHint('setup required')
          return
        }
        store.pushSystem('setup complete — starting session…')
        startNewSession('new session started')
      }

      // Slash dispatch context (Solid logic; the boundary just hands it a
      // Promise-returning `request` + the host capabilities it needs).
      const slashCtx: SlashContext = {
        guardBusySessionSwitch,
        newSession: startNewSession,
        branchSession: startBranchSession,
        newLiveSession: (message, title) => void startNewLiveSession(message, title),
        beginToolsConfigure: () => {
          clearModelPrefetch()
          activeTransitionOwner = `tools:${currentSessionOwnerId() ?? 'detached'}`
          sessionTransitionInFlight = true
          store.setHint('changing tools…')
        },
        endToolsConfigure: () => {
          sessionTransitionInFlight = false
          if (store.state.hint === 'changing tools…') store.setHint(undefined)
          if (gateway.sessionId() && store.state.sessionId) drainTransitionSubmissions()
          else reportFailedTransitionSubmissions()
          releaseTransitionOwnerUnlessPromoting()
        },
        resetAfterToolsConfigure: info => {
          const sid = gateway.sessionId()
          if (!sid || store.state.sessionId !== sid) return
          const draft = store.state.composerDraft
          store.adoptFreshSession(sid, info, store.state.resumeId ?? sid)
          if (draft) {
            pasteStore.retainOnly(draft)
            store.replaceComposerDraft(draft)
          } else pasteStore.clear()
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
        replaceConversationSnapshot: (messages, info, usage) =>
          store.replaceConversationSnapshot(messages, info, usage),
        setCompressedSessionKey: sessionKey => {
          if (gateway.sessionId() !== store.state.sessionId) return
          store.setResumeId(sessionKey)
          stableSessionOwnerId = sessionKey
          writeActiveSession(sessionKey)
        },
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
        isBusy: isTurnBusy,
        isSessionTransitioning,
        beginHistoryMutation: () => {
          if (historyMutationInFlight) return false
          historyMutationInFlight = true
          store.setHint('updating history…')
          return true
        },
        endHistoryMutation: () => {
          historyMutationInFlight = false
          if (store.state.hint === 'updating history…') store.setHint(undefined)
          queueMicrotask(drainQueuedIfIdle)
        },
        busyInputMode: () => store.state.busyInputMode,
        setBusyInputMode: mode => store.setBusyInputMode(mode),
        queueCount: () => store.queuedCount() + transitionSubmissions.length,
        enqueueQueued: enqueueClientPrompt,
        clearQueued: () => {
          const count = store.queuedCount() + transitionSubmissions.length
          const wasEditing = store.state.queueEditIndex !== undefined
          store.clearQueue()
          automaticQueueDrain.reset()
          queueEditDrain.reset()
          transitionSubmissions.splice(0)
          heldTransitionOwner = undefined
          promoteHeldAfterRecovery = false
          if (!sessionTransitionInFlight) activeTransitionOwner = undefined
          if (wasEditing) {
            pasteStore.clear()
            store.clearComposerDraft()
          }
          return count
        },
        steer: steerDirect,
        lastUserMessage: () => store.lastUserMessage(),
        trimLastExchange: () => store.trimLastExchange(),
        openExternalEditor,
        pasteClipboardImage: onImagePaste,
        attachImage,
        configureTerminal,
        runExternalSetup,
        prefillComposer: text => {
          // Slash submission clears the uncontrolled textarea immediately after
          // its synchronous local handler returns. Publish prefill on the next
          // microtask so a rejected `/queue`/`/steer` cannot be cleared again by
          // that same submit stack.
          queueMicrotask(() => {
            let editable: string | undefined
            if (text.length > BUSY_QUEUE_MAX_EDIT_CHARS) editable = pasteStore.replace(text)
            else {
              pasteStore.retainOnly(text)
              editable = text
            }
            if (editable === undefined) {
              showPasteLimit(pasteStore.stats().maxBytes)
              return
            }
            const wasQueueEditing = store.state.queueEditIndex !== undefined
            store.replaceComposerDraft(editable)
            if (wasQueueEditing) releaseQueueEditDrain()
          })
        },
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
        setBrowserState: (connected, url) => store.setBrowserState({ connected, ...(url ? { url } : {}) }),
        setVoiceMode: patch => store.setVoiceMode(patch),
        logTail: limit => gateway.logTail(limit),
        agentsControl: {
          applyPauseResponse: raw => store.applyDelegationPauseResponse(raw),
          delegation: () => store.state.delegation,
          history: () => store.state.spawnHistory,
          loadSnapshot: (raw, path) => store.loadSpawnTreeSnapshot(raw, path)
        },
        openDashboard: request => store.openDashboard(request),
        openJourney: () => store.openJourney(),
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
        sessionOwnerId: currentSessionOwnerId,
        submit: submitPrompt,
        submitSkill
      }

      // The composer's submit: `!cmd` runs a shell command (F9), `/command`
      // routes through the slash ladder, else a prompt turn.
      const submit = (text: string): boolean => {
        const route = classifySubmit(text)
        if (route.kind === 'shell') {
          runShell(route.payload)
          return true
        }
        if (route.kind === 'slash') {
          void dispatchSlash(route.payload, slashCtx).catch(error => {
            store.pushSystem(`slash command failed: ${error instanceof Error ? error.message : String(error)}`)
          })
          return true
        }
        return submitPrompt(route.payload)
      }

      // Drain ONE row per authoritative settle. Queue editing pins the selected
      // row; ending that edit while already idle retries this same drain seam.
      const sendQueuedAt = (index: number): boolean => {
        const sid = gateway.sessionId()
        const queued = store.state.queuedPrompts[index]
        if (
          !sid ||
          store.state.sessionId !== sid ||
          isSessionTransitioning() ||
          historyMutationInFlight ||
          queued === undefined
        ) {
          if (!sid || store.state.sessionId !== sid) store.pushSystem('no active session — queued message retained')
          return false
        }

        // Queue entries are model inputs. Do not reinterpret a skill body or a
        // `/queue !cmd` string as executable local shell/slash syntax without a
        // typed queue-item provenance model; surprising execution is worse than
        // the documented thinner queue routing in this milestone.
        if (isTurnBusy()) {
          const removed = store.removeQueuedPrompt(index)
          if (removed === undefined) return false
          const accepted = handleBusyInput(removed, true)
          if (!accepted) enqueueClientPrompt(removed, true)
          else automaticQueueDrain.resetIfEmpty(store.queuedCount())
          return accepted
        }

        if (pendingPrompt) return false
        const removed = store.removeQueuedPrompt(index)
        if (removed === undefined) return false
        // Explicit queue submission is the retry boundary after ambiguous
        // delivery. Because rows are still plain strings, one successful send
        // cannot prove that every sibling row is safe to auto-replay: the drain
        // gate stays explicit-only until this queue provenance epoch is empty.
        const accepted = sendPromptNow(removed)
        if (!accepted) enqueueClientPrompt(removed, true)
        else automaticQueueDrain.resetIfEmpty(store.queuedCount())
        return accepted
      }

      promoteHeldTransitionSubmissions = () => {
        if (!promoteHeldAfterRecovery) return
        if (!transitionOwnerAccepts(heldTransitionOwner, activeTransitionOwner)) {
          reportFailedTransitionSubmissions()
          return
        }
        let accepted = 0
        while (transitionSubmissions.length > 0) {
          const next = transitionSubmissions[0]
          if (!next) break
          const text = transitionSubmissionText(next)
          if (
            !queueAccepts(
              store.state.queuedPrompts,
              text,
              undefined,
              nonTransitionReservedQueueItems(),
              nonTransitionReservedQueueChars()
            )
          ) {
            break
          }
          if (!store.enqueuePrompt(text)) break
          transitionSubmissions.shift()
          accepted += 1
        }
        if (accepted > 0) store.pushSystem(`⏳ ${accepted} recovered submission(s) joined this session's queue`)
        if (transitionSubmissions.length > 0) {
          store.pushSystem(`${transitionSubmissions.length} submission(s) remain held until queue capacity frees`)
        } else {
          const settledOwner = heldTransitionOwner
          promoteHeldAfterRecovery = false
          heldTransitionOwner = undefined
          if (!sessionTransitionInFlight && activeTransitionOwner === settledOwner) {
            activeTransitionOwner = undefined
          }
        }
      }

      drainQueuedIfIdle = () => {
        // Deleting or explicitly sending the final row closes the conservative
        // string-queue provenance epoch. Keep this mutation separate from the
        // pure canDrain read so a mixed steer settlement cannot clear its own
        // just-raised ambiguity halt.
        automaticQueueDrain.resetIfEmpty(store.queuedCount())
        if (
          !automaticQueueDrain.canDrain() ||
          isSessionTransitioning() ||
          historyMutationInFlight ||
          pendingPrompt !== undefined ||
          isTurnBusy() ||
          !gateway.sessionId()
        )
          return
        if (store.state.queueEditIndex !== undefined) {
          queueEditDrain.defer()
          return
        }
        promoteHeldTransitionSubmissions()
        sendQueuedAt(0)
      }
      store.registerTurnCompleteHandler(drainQueuedIfIdle)

      const submitQueued = (index: number, text: string): boolean => {
        if (
          !queueAccepts(store.state.queuedPrompts, text, index, reservedQueueItems(), reservedQueueChars()) ||
          !store.replaceQueuedPrompt(index, text)
        ) {
          store.pushSystem(BUSY_QUEUE_FULL_MESSAGE)
          return false
        }
        return sendQueuedAt(index)
      }

      const onDoubleEmptySubmit = () => {
        const sid = gateway.sessionId()
        if (!sid || store.state.sessionId !== sid || isSessionTransitioning() || historyMutationInFlight) return
        if (isTurnBusy()) {
          interruptTurn()
          return
        }
        if (store.queuedCount() === 0) return
        store.setQueueEditIndex(undefined)
        sendQueuedAt(0)
      }

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

      // Blocking prompts retain UI ownership until a decoded gateway ack.
      const respond = async (method: PromptResponseMethod, params: Record<string, unknown>): Promise<boolean> => {
        try {
          const raw = await Effect.runPromise(gateway.request(method, params))
          const acknowledged = promptResponseAcknowledged(method, raw)
          if (!acknowledged) getLog().warn('respond', 'invalid acknowledgement', { method })
          return acknowledged
        } catch (cause) {
          getLog().warn('respond', 'failed', { cause: String(cause), method })
          throw cause
        }
      }

      // Live backend: drive a session (create + optional initial prompt)
      // concurrently, but acquire the same transition lock BEFORE rendering so
      // an early /new or /resume cannot race boot hydration.
      if (!input.fake) {
        sessionTransitionInFlight = true
        store.setHint('starting session…')
        yield* Effect.forkScoped(
          bootstrapSession(gateway, store, input, sendPromptNow).pipe(
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
                  onSubmitQueued={submitQueued}
                  onSendQueuedIndex={sendQueuedAt}
                  onDoubleEmptySubmit={onDoubleEmptySubmit}
                  onQueueEditChange={index => {
                    if (index === undefined) releaseQueueEditDrain()
                  }}
                  onType={onType}
                  onRespond={respond}
                  onResume={onResume}
                  onActivateSession={activateLiveSession}
                  onNewLiveSession={() => void startNewLiveSession('new live session started')}
                  onNewPromptSession={(prompt, modelArg) => void startNewPromptSession(prompt, modelArg)}
                  loadModelItems={loadSessionModelItems}
                  sessionOps={sessionOps}
                  journeyOps={journeyOps}
                  onSessionPickerClosed={onSessionPickerClosed}
                  sessionId={() => gateway.sessionId()}
                  history={history}
                  onImagePaste={onImagePaste}
                  onOpenEditor={draft => void openExternalEditor(draft)}
                  pasteStore={pasteStore}
                  onPasteLimitExceeded={showPasteLimit}
                  backgroundOps={backgroundOps}
                  agentsOps={agentsOps}
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
