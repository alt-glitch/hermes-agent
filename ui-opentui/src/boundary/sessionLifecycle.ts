/**
 * Fresh-session replacement at the Effect boundary.
 *
 * The ordering is the Ink contract: verify setup, close the current live
 * session, then create a replacement. `onClosed` runs inside Effect immediately
 * after a successful close so the host can atomically detach its old UI state;
 * if creation subsequently fails, a closed session can never remain believable.
 */
import { Data, Effect, Option, Schema } from 'effect'

import type { GatewayServiceShape } from './gateway/GatewayService.ts'
import {
  decodeSessionActivateResponse,
  decodeSessionBranchResponse,
  decodeSessionCloseResponse,
  decodeSessionResumeResponse,
  type LiveSessionSnapshot
} from './schema/SessionOrchestratorResponses.ts'
import { eventBelongsToSession } from '../logic/eventScope.ts'
import { mapResumeHistory } from '../logic/resume.ts'
import type { Message, SessionStore } from '../logic/store.ts'

const InfoRecord = Schema.Record(Schema.String, Schema.Unknown)
const SetupStatusResponseSchema = Schema.Struct({ provider_configured: Schema.optionalKey(Schema.Boolean) })
const SessionCreateResponseSchema = Schema.Struct({
  session_id: Schema.String,
  stored_session_id: Schema.optionalKey(Schema.String),
  info: Schema.optionalKey(InfoRecord)
})

const decodeSetupStatus = Schema.decodeUnknownOption(SetupStatusResponseSchema)
const decodeSessionCreate = Schema.decodeUnknownOption(SessionCreateResponseSchema)

export interface ReplaceSessionOptions {
  readonly activeSessionId: string | undefined
  readonly cols: number
  readonly cwd: string | undefined
  readonly onClosed: () => void
}

export interface CreateSessionOptions {
  readonly cols: number
  readonly cwd: string | undefined
}

export interface CreatedSession {
  readonly sessionId: string
  readonly resumeId: string
  readonly info?: Readonly<Record<string, unknown>>
}

export type ReplaceSessionResult =
  | { readonly kind: 'setup-required' }
  | {
      readonly kind: 'created'
      readonly sessionId: string
      readonly resumeId: string
      readonly info?: Readonly<Record<string, unknown>>
    }

export class SessionProtocolError extends Data.TaggedError('SessionProtocolError')<{
  readonly message: string
  readonly method: 'setup.status' | 'session.activate' | 'session.branch' | 'session.create' | 'session.resume'
}> {}

/** Create and schema-decode a session without any close/setup policy. */
export const createSession = Effect.fn('SessionLifecycle.create')(function* (
  gateway: GatewayServiceShape,
  options: CreateSessionOptions
) {
  const createdRaw = yield* gateway.request<unknown>('session.create', {
    cols: options.cols,
    ...(options.cwd ? { cwd: options.cwd } : {})
  })
  const decoded = decodeSessionCreate(createdRaw)
  if (Option.isNone(decoded)) {
    return yield* new SessionProtocolError({
      message: 'session.create returned an invalid response',
      method: 'session.create'
    })
  }
  const created = decoded.value
  const sessionId = created.session_id.trim()
  if (!sessionId) {
    return yield* new SessionProtocolError({
      message: 'session.create returned no session_id',
      method: 'session.create'
    })
  }
  return {
    sessionId,
    resumeId: created.stored_session_id?.trim() || sessionId,
    ...(created.info ? { info: created.info } : {})
  } satisfies CreatedSession
})

export const replaceSession = Effect.fn('SessionLifecycle.replace')(function* (
  gateway: GatewayServiceShape,
  options: ReplaceSessionOptions
) {
  const setupRaw = yield* gateway.request<unknown>('setup.status', {})
  const setup = decodeSetupStatus(setupRaw)
  if (Option.isNone(setup)) {
    return yield* new SessionProtocolError({
      message: 'setup.status returned an invalid response',
      method: 'setup.status'
    })
  }
  if (setup.value.provider_configured === false) return { kind: 'setup-required' } as const

  if (options.activeSessionId) {
    yield* gateway.request('session.close', { session_id: options.activeSessionId })
    yield* Effect.sync(options.onClosed)
  }

  const created = yield* createSession(gateway, { cols: options.cols, cwd: options.cwd })

  return {
    kind: 'created',
    sessionId: created.sessionId,
    resumeId: created.resumeId,
    ...(created.info ? { info: created.info } : {})
  } as const
})

export interface ResumeSessionOptions {
  readonly cols: number
  /** Preserve input authored after the async transition began. Ordinary user
   * switches retain only the draft intended for the target session; crash
   * recovery retains the same durable session's bounded queue/editor too. */
  readonly preserveLocalInput?: 'draft' | 'same-session'
  readonly targetSessionId: string
}

export interface ResumeSessionResult {
  readonly sessionId: string
  readonly resumedId: string
  readonly messageCount: number
  readonly rpcMs: number
  readonly hydrateMs: number
  readonly previousSessionId?: string
}

function liveSnapshotMessages(response: LiveSessionSnapshot): Message[] {
  const messages = mapResumeHistory(response.messages)
  const inflightUser = response.inflight?.user?.trim()
  if (inflightUser) messages.push({ role: 'user', text: inflightUser })
  const inflightAssistant = response.inflight?.assistant ?? ''
  if (inflightAssistant || response.inflight?.streaming) {
    messages.push({
      role: 'assistant',
      text: inflightAssistant,
      parts: inflightAssistant ? [{ id: 'inflight-1', text: inflightAssistant, type: 'text' }] : [],
      streaming: true
    })
  }
  return messages
}

function liveSnapshotInfo(response: LiveSessionSnapshot): Readonly<Record<string, unknown>> {
  const running =
    response.running === true || response.status === 'working' || response.status === 'waiting' || response.status === 'streaming'
  return { ...(response.info ?? {}), running }
}

function liveSnapshotRunning(response: LiveSessionSnapshot): boolean {
  return (
    response.running === true ||
    response.status === 'working' ||
    response.status === 'waiting' ||
    response.status === 'streaming' ||
    response.inflight?.streaming === true
  )
}

function liveSnapshotStartedAtMs(response: LiveSessionSnapshot): number | undefined {
  return response.started_at === undefined ? undefined : response.started_at * 1_000
}

/**
 * Transactionally hydrate a persisted session into its returned LIVE routing
 * id. The requested id is a database key and is never used for live event/RPC
 * routing. Failed resumes abort the buffer and leave the prior session intact;
 * successful ones filter coalesced old-session events. The caller receives the
 * previous live id so it can close that session off the resume critical path.
 */
export const resumeSession = Effect.fn('SessionLifecycle.resume')(function* (
  gateway: GatewayServiceShape,
  store: SessionStore,
  options: ResumeSessionOptions
) {
  const previousLiveSessionId = gateway.sessionId()
  let committed = false
  store.beginBuffer()
  const t0 = Date.now()
  return yield* Effect.gen(function* () {
    const raw = yield* gateway.request<unknown>('session.resume', {
      cols: options.cols,
      session_id: options.targetSessionId,
      with_tool_output: true
    })
    const response = decodeSessionResumeResponse(raw)
    if (!response || !response.session_id.trim()) {
      return yield* new SessionProtocolError({
        message: 'session.resume returned an invalid response',
        method: 'session.resume'
      })
    }
    const liveSessionId = response.session_id.trim()

    const t1 = Date.now()
    const snapshot = liveSnapshotMessages(response)
    const resumedId = response.resumed?.trim() || options.targetSessionId
    // Capture at the COMMIT boundary, not before the RPC: the composer remains
    // editable while session.resume is in flight and those latest bytes own the
    // target session. Crash recovery additionally owns the same-session queue.
    const preservedDraft = options.preserveLocalInput ? store.state.composerDraft : ''
    const preservedQueue = options.preserveLocalInput === 'same-session' ? [...store.state.queuedPrompts] : []
    const preservedEditIndex = options.preserveLocalInput === 'same-session' ? store.state.queueEditIndex : undefined
    store.commitSessionSnapshot(
      liveSessionId,
      snapshot,
      liveSnapshotInfo(response),
      event => eventBelongsToSession(event, liveSessionId),
      resumedId,
      liveSnapshotRunning(response),
      liveSnapshotStartedAtMs(response)
    )
    for (const text of preservedQueue) store.enqueuePrompt(text)
    if (preservedDraft) store.replaceComposerDraft(preservedDraft)
    if (preservedEditIndex !== undefined && preservedEditIndex < store.queuedCount()) {
      store.setQueueEditIndex(preservedEditIndex)
    }
    committed = true
    const t2 = Date.now()

    return {
      hydrateMs: t2 - t1,
      messageCount: snapshot.length,
      ...(previousLiveSessionId && previousLiveSessionId !== liveSessionId
        ? { previousSessionId: previousLiveSessionId }
        : {}),
      resumedId,
      rpcMs: t1 - t0,
      sessionId: liveSessionId
    } satisfies ResumeSessionResult
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!committed) {
          store.abortBuffer(event => eventBelongsToSession(event, previousLiveSessionId))
        }
      })
    )
  )
})

export interface ActivateSessionOptions {
  readonly targetSessionId: string
}

/** Switch visible ownership to an already-live sibling without closing the
 * previous session. The activate snapshot and any racing target events commit
 * atomically; failure replays only the still-current session's buffered events. */
export const activateSession = Effect.fn('SessionLifecycle.activate')(function* (
  gateway: GatewayServiceShape,
  store: SessionStore,
  options: ActivateSessionOptions
) {
  const previousLiveSessionId = gateway.sessionId()
  let committed = false
  store.beginBuffer()
  return yield* Effect.gen(function* () {
    const raw = yield* gateway.request<unknown>('session.activate', { session_id: options.targetSessionId })
    const response = decodeSessionActivateResponse(raw)
    const liveSessionId = response?.session_id.trim() ?? ''
    if (!response || !liveSessionId) {
      return yield* new SessionProtocolError({
        message: 'session.activate returned an invalid response',
        method: 'session.activate'
      })
    }
    const resumeId = response.session_key?.trim() || liveSessionId
    const snapshot = liveSnapshotMessages(response)
    store.commitSessionSnapshot(
      liveSessionId,
      snapshot,
      liveSnapshotInfo(response),
      event => eventBelongsToSession(event, liveSessionId),
      resumeId,
      liveSnapshotRunning(response),
      liveSnapshotStartedAtMs(response)
    )
    committed = true
    return {
      messageCount: snapshot.length,
      resumeId,
      sessionId: liveSessionId
    } as const
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!committed) store.abortBuffer(event => eventBelongsToSession(event, previousLiveSessionId))
      })
    )
  )
})

export const branchSession = Effect.fn('SessionLifecycle.branch')(function* (
  gateway: GatewayServiceShape,
  store: SessionStore,
  options: { readonly name: string }
) {
  const parentSessionId = gateway.sessionId()
  if (!parentSessionId) {
    return yield* new SessionProtocolError({ message: 'no active session to branch', method: 'session.branch' })
  }
  const parentResumeId = store.state.resumeId
  const visible = [...store.state.messages]
  const info = { ...store.state.info }
  let committed = false
  store.beginBuffer()
  return yield* Effect.gen(function* () {
    const raw = yield* gateway.request<unknown>('session.branch', {
      name: options.name,
      session_id: parentSessionId
    })
    const response = decodeSessionBranchResponse(raw)
    const childSessionId = response?.session_id.trim() ?? ''
    if (!response || !childSessionId) {
      return yield* new SessionProtocolError({
        message: 'session.branch returned an invalid response',
        method: 'session.branch'
      })
    }
    if (parentResumeId && response.parent !== undefined && response.parent.trim() !== parentResumeId) {
      return yield* new SessionProtocolError({
        message: 'session.branch returned a mismatched parent identity',
        method: 'session.branch'
      })
    }
    const resumeId = response.session_key?.trim() || childSessionId
    const preservedDraft = store.state.composerDraft
    store.commitSessionSnapshot(
      childSessionId,
      visible,
      info,
      event => eventBelongsToSession(event, childSessionId),
      resumeId,
      false,
      Date.now()
    )
    if (preservedDraft) store.replaceComposerDraft(preservedDraft)
    committed = true
    let closeFailed = false
    yield* gateway.request<unknown>('session.close', { session_id: parentSessionId }).pipe(
      Effect.tap(raw =>
        Effect.sync(() => {
          const closed = decodeSessionCloseResponse(raw)
          closeFailed = !closed || closed.closed !== true
        })
      ),
      Effect.catchCause(() => Effect.sync(() => (closeFailed = true)))
    )
    return { childSessionId, closeFailed, parentSessionId, resumeId, title: response.title.trim() } as const
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!committed) store.abortBuffer(event => eventBelongsToSession(event, parentSessionId))
      })
    )
  )
})
