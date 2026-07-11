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
import { eventBelongsToSession } from '../logic/eventScope.ts'
import { mapResumeHistory } from '../logic/resume.ts'
import type { SessionStore } from '../logic/store.ts'

const InfoRecord = Schema.Record(Schema.String, Schema.Unknown)
const SetupStatusResponseSchema = Schema.Struct({ provider_configured: Schema.optionalKey(Schema.Boolean) })
const SessionCreateResponseSchema = Schema.Struct({
  session_id: Schema.String,
  stored_session_id: Schema.optionalKey(Schema.String),
  info: Schema.optionalKey(InfoRecord)
})
const SessionResumeResponseSchema = Schema.Struct({
  session_id: Schema.String,
  resumed: Schema.optionalKey(Schema.String),
  messages: Schema.optionalKey(Schema.Unknown),
  info: Schema.optionalKey(InfoRecord)
})

const decodeSetupStatus = Schema.decodeUnknownOption(SetupStatusResponseSchema)
const decodeSessionCreate = Schema.decodeUnknownOption(SessionCreateResponseSchema)
const decodeSessionResume = Schema.decodeUnknownOption(SessionResumeResponseSchema)

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
  readonly method: 'setup.status' | 'session.create' | 'session.resume'
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
    const decoded = decodeSessionResume(raw)
    if (Option.isNone(decoded)) {
      return yield* new SessionProtocolError({
        message: 'session.resume returned an invalid response',
        method: 'session.resume'
      })
    }
    const response = decoded.value
    const liveSessionId = response.session_id.trim()
    if (!liveSessionId) {
      return yield* new SessionProtocolError({
        message: 'session.resume returned no session_id',
        method: 'session.resume'
      })
    }

    const t1 = Date.now()
    const snapshot = mapResumeHistory(response.messages)
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
      response.info,
      event => eventBelongsToSession(event, liveSessionId),
      resumedId
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
