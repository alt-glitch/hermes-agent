/**
 * Backend→client JSON-RPC requests (`tui_gateway/server_requests.py`, contracts in
 * `tui_gateway/contracts/server_requests.py`). Each frame is decoded once, against its method's
 * decoder (`schema/ServerRequestParams.ts`, typed by the generated `ServerRequestMap`); params that
 * fail are answered -32602. One row per method turns the decoded params into the store's
 * `ActivePrompt`; the prompt overlay renders it and answers through `answer(id, result)`, which
 * writes the JSON-RPC response `{jsonrpc, id, result}`.
 * Methods without a row (desktop GUI bridges: preview.*, window.read, terminal.read, tour,
 * vault.save_login, vault.code) are not handled; the client answers -32601 so the tool fails fast.
 */
import { createEffect, createRoot, on } from 'solid-js'

import type { ActivePrompt } from '../../logic/store.ts'
import { approvalPolicy } from '../../logic/approval.ts'
import { lockedClarifyAnswers, normalizeClarifyQuestions } from '../../logic/clarifyBatch.ts'
import { type PromptMethod, SERVER_REQUEST_DECODERS } from '../schema/ServerRequestParams.ts'
import type { ServerRequest, ServerRequestDisposition } from './client.ts'
import type { ServerRequestParams, ServerRequestResult } from './rpc.ts'

/** What the prompt overlay answers: ClarifyResult, ApprovalResult or ValueResult. */
export type PromptAnswer = ServerRequestResult<PromptMethod>

interface PromptRow<M extends PromptMethod> {
  /** The prompt for decoded params (SERVER_REQUEST_DECODERS already checked the frame). */
  readonly open: (id: string, params: ServerRequestParams<M>) => ActivePrompt
  /** True when an overlay answer is this method's result shape; only then is it written. */
  readonly accepts: (answer: PromptAnswer) => answer is ServerRequestResult<M>
}

const isValue = (answer: PromptAnswer): answer is ServerRequestResult<'sudo'> => 'value' in answer

export const SERVER_REQUEST_PROMPTS: { readonly [M in PromptMethod]: PromptRow<M> } = {
  clarify: {
    open: (id, p) => {
      // The decoder guarantees at least one askable entry, so `questions` is never empty here.
      const questions = normalizeClarifyQuestions(p.questions)
      const [only] = questions
      // One question keeps the single-question card; its answer is `{answers: {[qid]: …}}`.
      if (questions.length === 1 && only) {
        return { kind: 'clarify', question: only.question, choices: only.choices, qid: only.qid, requestId: id }
      }
      // A batch locks one answer at a time (clarify.lock); a replay carries the locks so far.
      const answers = lockedClarifyAnswers(p.answers)
      return { kind: 'clarify', question: '', choices: null, requestId: id, questions, answers }
    },
    accepts: (answer): answer is ServerRequestResult<'clarify'> => !('choice' in answer) && !('value' in answer)
  },
  approval: {
    open: (id, p) => ({
      kind: 'approval',
      allowPermanent: approvalPolicy({
        ...(p.allow_permanent != null ? { allowPermanent: p.allow_permanent } : {}),
        ...(p.choices ? { choices: p.choices } : {}),
        ...(p.smart_denied != null ? { smartDenied: p.smart_denied } : {})
      }),
      // `command` / `description` default to "" in the contract.
      command: p.command ?? '',
      description: p.description || 'dangerous command',
      requestId: id,
      sessionId: p.session_id
    }),
    accepts: (answer): answer is ServerRequestResult<'approval'> => 'choice' in answer
  },
  sudo: { open: id => ({ kind: 'sudo', requestId: id }), accepts: isValue },
  secret: {
    open: (id, p) => ({ kind: 'secret', envVar: p.env_var, prompt: p.prompt, requestId: id }),
    accepts: isValue
  },
  'vault.unlock_prompt': {
    open: (id, p) => ({ kind: 'vaultUnlock', backend: p.backend, displayName: p.display_name, requestId: id }),
    accepts: isValue
  }
}

/** One request decoded against its method's contract. */
export interface DecodedServerRequest {
  readonly id: string
  readonly method: PromptMethod
  readonly sessionId: string
  readonly prompt: ActivePrompt
  /** Write the JSON-RPC response. False when nothing was written (transport down, or `answer` is
   *  not this method's result shape). */
  readonly respond: (answer: PromptAnswer) => boolean
}

const isPromptMethod = (method: string): method is PromptMethod => Object.hasOwn(SERVER_REQUEST_PROMPTS, method)

function decodeAs<M extends PromptMethod>(method: M, request: ServerRequest): DecodedServerRequest | undefined {
  const params = SERVER_REQUEST_DECODERS[method](request.params)
  if (params === undefined) return undefined
  const row: PromptRow<M> = SERVER_REQUEST_PROMPTS[method]
  const send: (result: ServerRequestResult<M>) => boolean = request.respond
  return {
    id: request.id,
    method,
    sessionId: params.session_id,
    prompt: row.open(request.id, params),
    respond: answer => row.accepts(answer) && send(answer)
  }
}

/** Decode a raw request frame once: unknown method → 'method-not-found', params that fail the
 *  method's decoder → 'invalid-params'. */
export function decodeServerRequest(
  request: ServerRequest
): DecodedServerRequest | Exclude<ServerRequestDisposition, 'held'> {
  if (!isPromptMethod(request.method)) return 'method-not-found'
  return decodeAs(request.method, request) ?? 'invalid-params'
}

/** How `answer` ended: written, not written (transport down — the request stays open for a retry),
 *  or no longer open (answered, cancelled, or never received). */
export type AnswerOutcome = 'sent' | 'not-sent' | 'closed'

export interface ServerRequestRouter {
  /** RawClientOptions.onServerRequest; also the replay path for a hydration's `open_requests`. */
  readonly handle: (request: ServerRequest) => ServerRequestDisposition
  /** Answer held request `id`. On 'sent' the next request of the displayed session opens. */
  readonly answer: (id: string, result: PromptAnswer) => AnswerOutcome
  /** The backend settled `id` without this answer (`request.cancel`, final `clarify.lock`): drop it and,
   *  when it was the shown one, open the next. True when it was held. */
  readonly forget: (id: string) => boolean
  /** The gateway connection is gone (`gateway.exited`: the process exited, or the client replaced the
   *  transport because the attach URL changed): it will never answer or cancel what it asked,
   *  and a respawned one never issued these ids. Drop every held request and settle each through
   *  `settleWithdrawn` with `reason`, the same store path as a `request.cancel`. */
  readonly withdrawAll: (reason: string) => void
  /** Held request ids for the displayed session, shown one first. */
  readonly pending: () => readonly string[]
  /** Stop following the displayed session. */
  readonly dispose: () => void
}

export interface ServerRequestRouterOptions {
  /** Show one prompt (store.openPrompt); the store holds a single visible prompt. */
  readonly openPrompt: (prompt: ActivePrompt) => void
  /** The session whose transcript is on screen (store.state.sessionId). A reactive accessor: the
   *  router follows it and opens the new session's oldest held request when it changes. */
  readonly displayedSessionId: () => string | undefined
  /** Settle a withdrawn request's prompt the way a `request.cancel` event does (store.apply). */
  readonly settleWithdrawn: (cancel: { readonly id: string; readonly method: string; readonly reason: string }) => void
}

/**
 * Every request is held, per session, oldest first, until it is answered or the backend settles it
 * (`request.cancel` → `forget`; the backend cancels a closed session's requests). Only the displayed
 * session's oldest request is shown. When the displayed session changes, its oldest held request
 * opens, so a request that arrived for a session before it was displayed is shown as soon as it is,
 * whether it came before or after the hydration's `open_requests`. A replayed id that is already held
 * keeps its place. A replayed id that was already answered or settled stays closed: `open_requests` is
 * a snapshot taken when the backend handled session.activate / session.resume, and a `request.cancel`
 * (or our answer) for one of its ids can land before that response does.
 */
/** Closed ids kept for replays; far more than can settle while one hydration request is in flight. */
const CLOSED_IDS_KEPT = 256

export function createServerRequestRouter(options: ServerRequestRouterOptions): ServerRequestRouter {
  const held = new Map<string, DecodedServerRequest[]>()
  // Ids answered or settled, oldest first. Backend ids are unique (`srq-<uuid>`), and an id only needs
  // to stay here until the hydration response that may still list it has been replayed.
  const closed = new Set<string>()
  const close = (id: string): void => {
    closed.add(id)
    if (closed.size > CLOSED_IDS_KEPT) closed.delete(closed.values().next().value as string)
  }
  const showHead = (sessionId: string | undefined): void => {
    const head = sessionId === undefined ? undefined : held.get(sessionId)?.[0]
    if (head) options.openPrompt(head.prompt)
  }
  const find = (
    id: string
  ): {
    readonly sessionId: string
    readonly queue: DecodedServerRequest[]
    readonly index: number
  } | null => {
    for (const [sessionId, queue] of held) {
      const index = queue.findIndex(h => h.id === id)
      if (index >= 0) return { sessionId, queue, index }
    }
    return null
  }
  const remove = (id: string): boolean => {
    close(id)
    const found = find(id)
    if (!found) return false
    found.queue.splice(found.index, 1)
    if (found.queue.length === 0) held.delete(found.sessionId)
    if (found.index === 0 && found.sessionId === options.displayedSessionId()) showHead(found.sessionId)
    return true
  }
  const dispose = createRoot(dispose => {
    createEffect(on(options.displayedSessionId, showHead, { defer: true }))
    return dispose
  })
  return {
    handle: request => {
      const next = decodeServerRequest(request)
      if (typeof next === 'string') return next
      // Already answered or settled: a replay from a snapshot older than that. Nothing to show or write.
      if (closed.has(next.id)) return 'held'
      const queue = held.get(next.sessionId) ?? []
      held.set(next.sessionId, queue)
      const index = queue.findIndex(h => h.id === next.id)
      // A replay of a held request takes its place (it carries the batch answers locked so far).
      if (index >= 0) queue[index] = next
      else queue.push(next)
      // The shown one re-opens too: hydration cleared the store prompt.
      if (queue[0] === next && next.sessionId === options.displayedSessionId()) options.openPrompt(next.prompt)
      return 'held'
    },
    answer: (id, result) => {
      const found = find(id)
      const request = found?.queue[found.index]
      if (!request) return 'closed'
      if (!request.respond(result)) return 'not-sent'
      remove(id)
      return 'sent'
    },
    forget: remove,
    withdrawAll: reason => {
      const dropped = [...held.values()].flat()
      held.clear()
      for (const { id, method } of dropped) options.settleWithdrawn({ id, method, reason })
    },
    pending: () => {
      const displayed = options.displayedSessionId()
      return displayed === undefined ? [] : (held.get(displayed) ?? []).map(h => h.id)
    },
    dispose
  }
}
