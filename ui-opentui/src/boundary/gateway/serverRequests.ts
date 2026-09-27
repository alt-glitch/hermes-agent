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
    const questions = (Array.isArray(p['questions']) ? (p['questions'] as unknown[]) : [])
      .map(raw => (raw && typeof raw === 'object' ? (raw as Params) : {}))
      .filter(q => str(q['qid']) && str(q['question']).trim())
      .map(q => ({
        choices: strList(q['choices']),
        multiSelect: q['multi_select'] === true,
        qid: str(q['qid']),
        question: str(q['question']).trim()
      }))
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

export interface ServerRequestRouter {
  /** RawClientOptions.onServerRequest. */
  readonly handle: (request: ServerRequest) => boolean
  /** Answer open request `id`; false when it is no longer open (answered, cancelled) or the transport is down. */
  readonly answer: (id: string, result: ServerRequestResult) => boolean
  /** `request.cancel {id}`: forget the request; true when it was open. */
  readonly forget: (id: string) => boolean
}

export function createServerRequestRouter(openPrompt: (prompt: ActivePrompt) => void): ServerRequestRouter {
  const open = new Map<string, ServerRequest>()
  return {
    handle: request => {
      const toPrompt = SERVER_REQUEST_PROMPTS[request.method]
      if (!toPrompt) return false
      open.set(request.id, request)
      openPrompt(toPrompt(request.id, request.params))
      return true
    },
    answer: (id, result) => {
      const request = open.get(id)
      if (!request) return false
      open.delete(id)
      return request.respond({ ...result })
    },
    forget: id => open.delete(id)
  }
}
