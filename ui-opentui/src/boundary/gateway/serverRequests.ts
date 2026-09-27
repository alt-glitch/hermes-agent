/**
 * Backend→client JSON-RPC requests (`tui_gateway/server_requests.py`, contracts in
 * `tui_gateway/contracts/server_requests.py`). One handler per request method turns the request
 * params into the store's `ActivePrompt`; the prompt overlay renders it and answers through
 * `answer(id, result)`, which writes the JSON-RPC response `{jsonrpc, id, result}`.
 * Methods without a row (desktop GUI bridges: preview.*, window.read, terminal.read, tour,
 * vault.save_login, vault.code) are not handled; the client answers -32601 so the tool fails fast.
 */
import { createEffect, createRoot, on } from 'solid-js'

import type { ActivePrompt } from '../../logic/store.ts'
import { approvalPolicy } from '../../logic/approval.ts'
import { normalizeClarifyQuestions } from '../../logic/clarifyBatch.ts'
import type { ServerRequest } from './client.ts'

type Params = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length > 0 ? v.filter((c): c is string => typeof c === 'string') : null
const strRecord = (v: unknown): Record<string, string> =>
  v && typeof v === 'object'
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')
      )
    : {}

/** Result shapes per `contracts/server_requests.py`: ClarifyResult, ApprovalResult, ValueResult. */
export type ServerRequestResult =
  | { readonly answer: string }
  | { readonly answers: Record<string, string> }
  | { readonly choice: 'once' | 'session' | 'always' | 'deny'; readonly all?: boolean }
  | { readonly value: string }

export const SERVER_REQUEST_PROMPTS: Readonly<Record<string, (id: string, params: Params) => ActivePrompt>> = {
  clarify: (id, p) => {
    const questions = normalizeClarifyQuestions(
      (Array.isArray(p['questions']) ? (p['questions'] as unknown[]) : []).map(raw => {
        const q = raw && typeof raw === 'object' ? (raw as Params) : {}
        return {
          choices: strList(q['choices']),
          multi_select: q['multi_select'] === true,
          qid: str(q['qid']),
          question: str(q['question'])
        }
      })
    )
    return questions.length
      ? { kind: 'clarify', question: '', choices: null, requestId: id, questions, answers: strRecord(p['answers']) }
      : { kind: 'clarify', question: str(p['question']), choices: strList(p['choices']), requestId: id }
  },
  approval: (id, p) => {
    const choices = strList(p['choices'])
    return {
      kind: 'approval',
      allowPermanent: approvalPolicy({
        ...(typeof p['allow_permanent'] === 'boolean' ? { allowPermanent: p['allow_permanent'] } : {}),
        ...(choices ? { choices } : {}),
        ...(typeof p['smart_denied'] === 'boolean' ? { smartDenied: p['smart_denied'] } : {})
      }),
      command: str(p['command']),
      description: str(p['description']) || 'dangerous command',
      requestId: id,
      sessionId: str(p['session_id'])
    }
  },
  sudo: id => ({ kind: 'sudo', requestId: id }),
  secret: (id, p) => ({ kind: 'secret', envVar: str(p['env_var']), prompt: str(p['prompt']), requestId: id }),
  'vault.unlock_prompt': (id, p) => ({
    kind: 'vaultUnlock',
    backend: str(p['backend']),
    displayName: str(p['display_name']),
    requestId: id
  })
}

/** How `answer` ended: written, not written (transport down — the request stays open for a retry),
 *  or no longer open (answered, cancelled, or never received). */
export type AnswerOutcome = 'sent' | 'not-sent' | 'closed'

export interface ServerRequestRouter {
  /** RawClientOptions.onServerRequest; also the replay path for a hydration's `open_requests`. */
  readonly handle: (request: ServerRequest) => boolean
  /** Answer held request `id`. On 'sent' the next request of the displayed session opens. */
  readonly answer: (id: string, result: ServerRequestResult) => AnswerOutcome
  /** The backend settled `id` without this answer (`request.cancel`, final `clarify.lock`): drop it and,
   *  when it was the shown one, open the next. True when it was held. */
  readonly forget: (id: string) => boolean
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
}

interface Held {
  readonly request: ServerRequest
  readonly prompt: ActivePrompt
}

/**
 * Every request is held, per session, oldest first, until it is answered or the backend settles it
 * (`request.cancel` → `forget`; the backend cancels a closed session's requests). Only the displayed
 * session's oldest request is shown. When the displayed session changes, its oldest held request
 * opens, so a request that arrived for a session before it was displayed is shown as soon as it is,
 * whether it came before or after the hydration's `open_requests`. A replayed id that is already held
 * keeps its place.
 */
export function createServerRequestRouter(options: ServerRequestRouterOptions): ServerRequestRouter {
  const held = new Map<string, Held[]>()
  const sessionOf = (request: ServerRequest): string => str(request.params['session_id'])
  const showHead = (sessionId: string | undefined): void => {
    const head = sessionId === undefined ? undefined : held.get(sessionId)?.[0]
    if (head) options.openPrompt(head.prompt)
  }
  const find = (id: string): { readonly sessionId: string; readonly queue: Held[]; readonly index: number } | null => {
    for (const [sessionId, queue] of held) {
      const index = queue.findIndex(h => h.request.id === id)
      if (index >= 0) return { sessionId, queue, index }
    }
    return null
  }
  const remove = (id: string): boolean => {
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
      const toPrompt = SERVER_REQUEST_PROMPTS[request.method]
      if (!toPrompt) return false
      const sessionId = sessionOf(request)
      const queue = held.get(sessionId) ?? []
      held.set(sessionId, queue)
      const next = { request, prompt: toPrompt(request.id, request.params) }
      const index = queue.findIndex(h => h.request.id === request.id)
      // A replay of a held request takes its place (it carries the batch answers locked so far).
      if (index >= 0) queue[index] = next
      else queue.push(next)
      // The shown one re-opens too: hydration cleared the store prompt.
      if (queue[0] === next && sessionId === options.displayedSessionId()) options.openPrompt(next.prompt)
      return true
    },
    answer: (id, result) => {
      const found = find(id)
      const request = found?.queue[found.index]?.request
      if (!request) return 'closed'
      if (!request.respond({ ...result })) return 'not-sent'
      remove(id)
      return 'sent'
    },
    forget: remove,
    pending: () => {
      const displayed = options.displayedSessionId()
      return displayed === undefined ? [] : (held.get(displayed) ?? []).map(h => h.request.id)
    },
    dispose
  }
}
