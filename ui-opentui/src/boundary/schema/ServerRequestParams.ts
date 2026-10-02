/**
 * Decoders for the params of the backend→client requests ui-opentui answers, one per method
 * (`tui_gateway/contracts/server_requests.py`). The table is typed against the generated
 * `ServerRequestMap`, so a decoder whose output drifts from the contract fails `tsc`. A key the
 * contract requires is required here; a frame that fails is answered -32602 by the router.
 */
import { Option, Schema } from 'effect'

import type { ServerRequestParams } from '../gateway/rpc.ts'

const opt = Schema.optionalKey
const Str = Schema.String
const Bool = Schema.Boolean
const StrList = Schema.mutable(Schema.Array(Str))

const ClarifyQuestion = Schema.Struct({
  qid: Str,
  question: Str,
  choices: opt(Schema.NullOr(StrList)),
  multi_select: opt(Bool)
})

// One shape for 1-5 questions. `answers` rides only on a reconnect replay (null = skipped).
// A list with no askable entry (non-empty qid and question) asks nothing: -32602.
const ClarifyParams = Schema.Struct({
  session_id: Str,
  questions: Schema.mutable(Schema.Array(ClarifyQuestion)),
  answers: opt(Schema.NullOr(Schema.Record(Str, Schema.NullOr(Str))))
}).check(
  Schema.makeFilter(p => p.questions.some(q => q.qid !== '' && q.question.trim() !== ''), {
    expected: 'a questions list with at least one non-empty qid and question'
  })
)

const ApprovalParams = Schema.Struct({
  session_id: Str,
  request_id: Str,
  command: opt(Str),
  description: opt(Str),
  choices: opt(Schema.mutable(Schema.Array(Schema.Literals(['once', 'session', 'always', 'deny'])))),
  allow_permanent: opt(Schema.NullOr(Bool)),
  allow_session: opt(Schema.NullOr(Bool)),
  smart_denied: opt(Schema.NullOr(Bool)),
  tool_name: opt(Schema.NullOr(Str)),
  gateway_session_id: opt(Schema.NullOr(Str))
})

const SudoParams = Schema.Struct({ session_id: Str, command: opt(Str) })

const SecretParams = Schema.Struct({
  session_id: Str,
  env_var: Str,
  prompt: Str,
  metadata: opt(Schema.NullOr(Schema.Record(Str, Schema.Unknown)))
})

const VaultUnlockParams = Schema.Struct({ session_id: Str, backend: Str, display_name: Str })

const decoder = <T>(schema: Schema.Decoder<T>) => {
  const decode = Schema.decodeUnknownOption(schema)
  return (raw: unknown): T | undefined => Option.getOrUndefined(decode(raw))
}

/** Request methods ui-opentui answers with a prompt. */
export type PromptMethod = 'approval' | 'clarify' | 'secret' | 'sudo' | 'vault.unlock_prompt'

export const SERVER_REQUEST_DECODERS: {
  readonly [M in PromptMethod]: (raw: unknown) => ServerRequestParams<M> | undefined
} = {
  approval: decoder(ApprovalParams),
  clarify: decoder(ClarifyParams),
  secret: decoder(SecretParams),
  sudo: decoder(SudoParams),
  'vault.unlock_prompt': decoder(VaultUnlockParams)
}
