/**
 * Backend→client JSON-RPC requests (`tui_gateway/server_requests.py`, contracts in
 * `tui_gateway/contracts/server_requests.py`). One handler per request method turns the request
 * params into the store's `ActivePrompt`; the prompt overlay renders it and answers through
 * `answer(id, result)`, which writes the JSON-RPC response `{jsonrpc, id, result}`.
 * Methods without a row (desktop GUI bridges: preview.*, window.read, terminal.read, tour,
 * vault.save_login, vault.code) are not handled; the client answers -32601 so the tool fails fast.
 */
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
 *  or no longer open (answered, cancelled, or owned by a session that is no longer displayed). */
export type AnswerOutcome = 'sent' | 'not-sent' | 'closed'

export interface ServerRequestRouter {
  /** RawClientOptions.onServerRequest; also the replay path for a hydration's `open_requests`. */
  readonly handle: (request: ServerRequest) => boolean
  /** Answer queued request `id`. On 'sent' the next queued request opens. */
  readonly answer: (id: string, result: ServerRequestResult) => AnswerOutcome
  /** The backend settled `id` without this answer (`request.cancel`, final `clarify.lock`): drop it and,
   *  when it was the shown one, open the next. True when it was queued. */
  readonly forget: (id: string) => boolean
  /** Queued request ids for the displayed session, shown one first. */
  readonly pending: () => readonly string[]
}

export interface ServerRequestRouterOptions {
  /** Show one prompt (store.openPrompt); the store holds a single visible prompt. */
  readonly openPrompt: (prompt: ActivePrompt) => void
  /** The session whose transcript is on screen (store.state.sessionId). */
  readonly displayedSessionId: () => string | undefined
}

/**
 * Requests are shown only for the displayed session, one at a time, oldest first. A request for any
 * other session is neither answered nor kept: the backend keeps it in `open_requests` until it is
 * answered or expires, and activating that session replays it through `handle`
 * (sessionLifecycle.ts → GatewayTransport.replayRequests). The queue belongs to one session; the
 * first call after a session switch starts it empty.
 */
interface Queued {
  readonly request: ServerRequest
  readonly prompt: ActivePrompt
}

export function createServerRequestRouter(options: ServerRequestRouterOptions): ServerRequestRouter {
  let owner: string | undefined
  let queue: Queued[] = []
  const current = (): Queued[] => {
    const displayed = options.displayedSessionId()
    if (displayed !== owner) {
      owner = displayed
      queue = []
    }
    return queue
  }
  const show = (queued: Queued | undefined): void => {
    if (queued) options.openPrompt(queued.prompt)
  }
  const remove = (id: string): boolean => {
    const requests = current()
    const index = requests.findIndex(q => q.request.id === id)
    if (index < 0) return false
    requests.splice(index, 1)
    if (index === 0) show(requests[0])
    return true
  }
  return {
    handle: request => {
      const toPrompt = SERVER_REQUEST_PROMPTS[request.method]
      if (!toPrompt) return false
      const requests = current()
      if (owner === undefined || request.params['session_id'] !== owner) return true
      const queued = { request, prompt: toPrompt(request.id, request.params) }
      const index = requests.findIndex(q => q.request.id === request.id)
      // A replay of a request already queued takes its place (it carries the batch answers locked
      // so far); the shown one re-opens, since hydration cleared the store prompt.
      if (index >= 0) requests[index] = queued
      else requests.push(queued)
      if (requests[0] === queued) show(queued)
      return true
    },
    answer: (id, result) => {
      const request = current().find(q => q.request.id === id)?.request
      if (!request) return 'closed'
      if (!request.respond({ ...result })) return 'not-sent'
      remove(id)
      return 'sent'
    },
    forget: remove,
    pending: () => current().map(q => q.request.id)
  }
}
