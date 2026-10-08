/**
 * Plain-language copy for gateway/transport failures (pure; no Solid, no Effect).
 *
 * Ported from Ink's `ui-tui/src/app/userMessages.ts` + `i18n/en/userMessages.ts`
 * (upstream 66878996dd, upstream_blocked row from 6f6ed01355) and the Setup
 * Required panel (`ui-tui/src/content/setup.ts`, 5ae7ec8623). Every message says
 * what happened and names a real next step (/retry, /model, /resume, /logs…)
 * instead of echoing raw wire text. Kept pure so the copy is table-testable.
 */

/** JSON-RPC error codes the gateway answers with. */
export const RPC_INVALID_PARAMS = 4000
export const RPC_SESSION_NOT_FOUND = 4001
export const RPC_NOT_DISPATCHABLE = 4018
export const RPC_UNKNOWN_METHOD = -32601

const DETAIL_LIMIT = 300

/** The fields the copy reads off any rejection: a typed `GatewayError`
 *  (`code`/`reason`/`message`), a raw `Error`, or a bare string. */
interface RpcErrorShape {
  readonly code: number | undefined
  readonly reason: string | undefined
  readonly message: string | undefined
}

const rpcShape = (err: unknown): RpcErrorShape => {
  if (typeof err === 'string') return { code: undefined, reason: undefined, message: err }
  if (typeof err !== 'object' || err === null) return { code: undefined, reason: undefined, message: undefined }
  const record = err as { code?: unknown; reason?: unknown; message?: unknown }
  return {
    code: typeof record.code === 'number' && Number.isFinite(record.code) ? record.code : undefined,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    message: typeof record.message === 'string' ? record.message : undefined
  }
}

const detailLine = (raw: string | undefined): string | undefined => {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return `Details: ${text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text}`
}

const joinLines = (lines: ReadonlyArray<string | undefined>): string =>
  lines.filter((line): line is string => Boolean(line)).join('\n')

// ── RPC errors ────────────────────────────────────────────────────────────

export const RPC_COPY = {
  versionSkew:
    'The terminal UI and the Hermes backend are out of sync (different versions). Run /update, or exit and run `hermes update`, then start the TUI again.',
  sessionNotFound:
    'This chat is no longer attached to the backend (it was idle or the backend restarted). Your history is saved: type /resume to reopen it.',
  notConnected:
    'Hermes is not connected right now, so that was not sent. It reconnects automatically; wait a moment and try again, or type /logs if this persists.',
  timedOut: (secs: string | undefined) =>
    `Hermes did not answer ${secs ? `within ${secs}s` : 'in time'}. Try again; if it keeps happening, type /logs and report the last lines.`,
  slashTimedOut: (command: string) =>
    `/${command} did not finish: the command helper timed out. Try again; if it keeps happening, type /logs and report the last lines.`,
  slashCrashed: (command: string) =>
    `/${command} did not finish: the command helper crashed. Try again; type /logs for the trace.`
} as const

const VERSION_SKEW_RE = /Extra inputs are not permitted|^unknown method:/
const SESSION_NOT_FOUND_RE = /session not found/i
// Ink's wire text plus the native client's own transport rejections
// (`gateway not running`, `gateway not connected: <method>`).
const NOT_CONNECTED_RE = /^gateway not (?:connected|running)\b/
// Ink: `request timed out after Ns`; native client: `timeout: <method>`.
const TIMED_OUT_RE = /^request timed out after (\d+)s|^timeout: /

/** The UI bundle and the Python backend disagree on the wire: stale dist or an older attached backend. */
export const isVersionSkewError = (err: unknown): boolean => {
  const { code, message } = rpcShape(err)
  return (
    code === RPC_UNKNOWN_METHOD ||
    (code === RPC_INVALID_PARAMS && VERSION_SKEW_RE.test(message ?? '')) ||
    (code === undefined && VERSION_SKEW_RE.test(message ?? ''))
  )
}

type RpcErrorRow = readonly [
  matcher: (shape: RpcErrorShape, text: string) => RegExpExecArray | boolean | null,
  render: (match: RegExpExecArray | null) => string
]

// Ordered: first matching row wins. 4001 is reused by the backend for unrelated
// refusals ("no active session", "slug is required", NOT_OWNER), so the code
// alone must not trigger the /resume copy — only the "session not found" text.
const RPC_ERROR_ROWS: ReadonlyArray<RpcErrorRow> = [
  [
    ({ code }, text) => (code === RPC_SESSION_NOT_FOUND || code === undefined) && SESSION_NOT_FOUND_RE.test(text),
    () => RPC_COPY.sessionNotFound
  ],
  [(_shape, text) => NOT_CONNECTED_RE.test(text), () => RPC_COPY.notConnected],
  [({ reason }, text) => TIMED_OUT_RE.exec(text) ?? reason === 'timeout', match => RPC_COPY.timedOut(match?.[1])]
]

/** Rewrite transport/session errors into plain words; other errors pass through unchanged. */
export const describeRpcError = (err: unknown): string => {
  const shape = rpcShape(err)
  const text = shape.message?.trim() ? shape.message : 'request failed'
  if (isVersionSkewError(err)) return RPC_COPY.versionSkew
  for (const [matcher, render] of RPC_ERROR_ROWS) {
    const match = matcher(shape, text)
    if (match) return render(match === true ? null : match)
  }
  return text
}

/** The slash worker (built-in command helper) failed; name the command, not the helper. */
export const describeSlashExecError = (command: string, err: unknown): string => {
  const text = rpcShape(err).message ?? ''
  if (/slash worker timed out/.test(text)) return RPC_COPY.slashTimedOut(command)
  if (/slash worker (?:exited|closed pipe|start failed)/.test(text)) {
    const detail = detailLine(text.replace(/^slash worker (?:exited|closed pipe|start failed):?\s*/, ''))
    return joinLines([RPC_COPY.slashCrashed(command), detail])
  }
  return describeRpcError(err)
}

// slash.exec answers 4018 with exactly these texts when it does NOT own the
// command (tui_gateway/methods_tools.py). Every other 4018 came from a
// command.dispatch handler slash.exec already forwarded to (/retry, /undo,
// /compress, /queue, bundles): re-dispatching would run a mutating command twice.
const NOT_MINE_REFUSAL_RE = /^skill command: use command\.dispatch for \/|use command\.dispatch for \/snapshot restore/

/** command.dispatch is only a fallback for "slash.exec does not own this command" refusals.
 *  A helper timeout/crash (5030), a client-side RPC timeout, or a dead transport
 *  must surface as itself instead of being buried by the fallback's refusal. */
export const shouldFallbackToDispatch = (err: unknown): boolean => {
  const { code, reason, message } = rpcShape(err)
  if (code === RPC_NOT_DISPATCHABLE) return NOT_MINE_REFUSAL_RE.test(message ?? '')
  if (code !== undefined) return false
  if (reason === 'timeout' || reason === 'transport-down') return false
  // Legacy/attached backends without a code: keep the historical behaviour
  // unless the text is unmistakably a helper/transport failure.
  return !/slash worker|timed out|^timeout: |not connected|not running/.test(message ?? '')
}

// ── Turn failures (message.complete status=error) ─────────────────────────

interface TurnCopy {
  readonly title: string
  readonly hint: string
  readonly hintNoRetry?: string
}

// error_surface.code (snake_case wire values) → copy.
export const TURN_CODE_COPY: Readonly<Record<string, TurnCopy>> = {
  auth: { title: 'The model provider rejected the API key', hint: 'Fix the key with /model, then /retry.' },
  auth_permanent: { title: 'The model provider rejected the API key', hint: 'Fix the key with /model, then /retry.' },
  billing: { title: 'The model provider reports no credit left', hint: 'Top up the account or switch with /model.' },
  billing_unverified: {
    title: 'The model provider reports no credit left',
    hint: 'Top up the account or switch with /model.'
  },
  content_policy_blocked: {
    title: 'The model provider refused this request (content policy)',
    hint: 'Rephrase and send again.'
  },
  context_overflow: { title: 'The conversation is too long for this model', hint: 'Run /compress, then /retry.' },
  format_error: {
    title: 'The model provider rejected the request format',
    hint: 'Try /retry; if it persists, switch with /model.',
    hintNoRetry: 'Pick another model with /model; if it persists, switch with /model.'
  },
  model_not_found: { title: 'The model provider does not know this model', hint: 'Pick another model with /model.' },
  overloaded: { title: 'The model provider is overloaded', hint: 'Wait a moment, then /retry.' },
  payload_too_large: { title: 'The request was too large for this model', hint: 'Run /compress, then /retry.' },
  provider_policy_blocked: {
    title: 'The model provider refused this request (account policy)',
    hint: 'Switch with /model.'
  },
  rate_limit: { title: 'The model provider is rate-limiting requests', hint: 'Wait a moment, then /retry.' },
  server_error: { title: 'The model provider had an internal error', hint: 'Wait a moment, then /retry.' },
  ssl_cert_verification: {
    title: 'The connection to the model provider could not be verified (TLS)',
    hint: "Check the endpoint's certificate, then /retry."
  },
  timeout: {
    title: 'The model provider did not answer in time',
    hint: 'Try /retry; if it keeps happening, switch with /model.',
    hintNoRetry: 'Pick another model with /model; if it keeps happening, switch with /model.'
  },
  upstream_blocked: {
    title: 'A firewall/CDN in front of the model provider blocked the request',
    hint: "Set a User-Agent via the provider's extra_headers, or switch with /model."
  },
  upstream_rate_limit: { title: 'The model provider is rate-limiting requests', hint: 'Wait a moment, then /retry.' }
}

// error_surface.layer → copy, used when the code has no row.
export const TURN_LAYER_COPY: Readonly<Record<string, TurnCopy>> = {
  auth: { title: 'The model provider rejected the credentials', hint: 'Fix them with /model, then /retry.' },
  billing: { title: 'The model provider reports no credit left', hint: 'Top up the account or switch with /model.' },
  disk: { title: 'The disk is full, so Hermes could not save the turn', hint: 'Free some space, then /retry.' },
  endpoint: { title: 'Your custom model endpoint did not answer', hint: 'Check the endpoint is running, then /retry.' },
  gateway: {
    title: 'Hermes hit an internal error while running this turn',
    hint: 'Send /retry; type /logs for the trace.',
    hintNoRetry: 'Pick another model with /model; type /logs for the trace.'
  },
  provider: {
    title: 'The model provider returned an error',
    hint: 'Send /retry, or switch with /model.',
    hintNoRetry: 'Pick another model with /model, or switch with /model.'
  },
  streaming: {
    title: 'The connection to the model provider dropped mid-reply',
    hint: 'Send /retry.',
    hintNoRetry: 'Pick another model with /model.'
  }
}

export const TURN_FALLBACK_COPY: TurnCopy = {
  title: 'The request failed',
  hint: 'Send /retry, or switch with /model.',
  hintNoRetry: 'Pick another model with /model, or switch with /model.'
}

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined

/** The advisory `error_surface` descriptor fields the copy reads (all optional). */
export interface ErrorSurfaceLike {
  readonly code?: string | undefined
  readonly layer?: string | undefined
  readonly provider?: string | undefined
  readonly retryable?: boolean | undefined
}

export interface TurnFailure {
  readonly error?: string | undefined
  readonly error_surface?: ErrorSurfaceLike | undefined
  readonly recoverable?: boolean | undefined
}

/** Plain title + Details line + next step for a failed turn with no reply text. */
export const describeTurnFailure = (payload: TurnFailure): string => {
  const surface = payload.error_surface ?? {}
  const copy =
    own(TURN_CODE_COPY, surface.code ?? '') ?? own(TURN_LAYER_COPY, surface.layer ?? '') ?? TURN_FALLBACK_COPY
  const title = surface.provider ? `${copy.title} (${surface.provider})` : copy.title
  // The backend always sets recoverable=true on a turn error; error_surface.retryable
  // is the signal that actually says whether /retry can help.
  const retryable = surface.retryable !== false && payload.recoverable !== false
  const nextStep = retryable ? copy.hint : (copy.hintNoRetry ?? copy.hint)
  const raw = (payload.error ?? '').replace(/^Error:\s*/, '')
  return joinLines([`${title}. Your message was not answered.`, detailLine(raw), nextStep])
}

// ── Withdrawn password / secret prompts (request.cancel reason=timeout) ────

// server-request method → copy.
export const PROMPT_TIMEOUT_COPY: Readonly<Record<string, string>> = {
  secret:
    'Secret prompt closed: no answer in time, so the step that needed it was skipped. Send your request again when you are ready to enter it.',
  sudo: 'Password prompt closed: no answer in time, so the command was skipped. Send your request again when you are ready to enter it.',
  'vault.code':
    'Verification-code prompt closed: no answer in time, so the sign-in was skipped. Send your request again when you have the code.',
  'vault.save_login':
    'Save-login prompt closed: no answer in time, so nothing was saved. Send your request again when you are ready.',
  'vault.unlock_prompt':
    'Unlock prompt closed: no answer in time, so the password manager stayed locked. Send your request again when you are ready to unlock it.'
}

/** Timeout-specific copy for a withdrawn secret/sudo/vault card; undefined → generic settlement copy. */
export const promptTimeoutNotice = (method: string | undefined, reason: string | undefined): string | undefined =>
  reason === 'timeout' && method ? own(PROMPT_TIMEOUT_COPY, method) : undefined

// ── Backend crash loop (respawn budget exhausted) ─────────────────────────

/** Exit code from the transport's exit reason (`gateway exited (code=1 signal=null)`). */
export const exitCodeFromReason = (reason: string | undefined): number | undefined => {
  const match = /\bcode=(-?\d+)\b/.exec(reason ?? '')
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/** Last stderr line that is not our own [lifecycle]/[startup]/… bookkeeping. */
export const lastStderrLine = (lines: ReadonlyArray<string>): string | undefined =>
  lines
    .map(line => line.trim())
    .filter(line => line && !/^\[(?:lifecycle|startup|protocol|sidecar|spawn)\]/.test(line))
    .at(-1)

/** Said ONCE per outage when the respawn budget is spent. Unlike Ink's client,
 *  the native transport does not keep retrying after the budget, so the next
 *  step is an honest restart rather than "reconnecting in the background". */
export const backendGaveUp = (code: number | undefined, lastLine: string | undefined): string =>
  joinLines([
    code === undefined
      ? 'Hermes stopped and could not be restarted. Your chat is saved.'
      : `Hermes stopped (exit code ${code}) and could not be restarted. Your chat is saved.`,
    detailLine(lastLine),
    'Type /quit and start Hermes again, then /resume to reopen this chat.',
    'Type /logs for the full log, or /quit and run `hermes doctor` to check the install.'
  ])

// ── Setup Required panel ──────────────────────────────────────────────────

export const SETUP_REQUIRED_TITLE = 'Setup Required'

/** Ink order: /setup first (it adds the provider /model needs), then /model, then exit. */
export const setupRequiredText = (): string =>
  [
    'Hermes needs a model provider before the TUI can start a session.',
    '',
    'Actions',
    '• /setup — run the first-time setup wizard in-place (adds a provider)',
    '• /model — pick a model (needs a session — add a provider first)',
    '• Ctrl+C — exit and run `hermes setup` manually',
    '',
    'In the dashboard the Models page sets the profile default; on Desktop it is Settings -> Models.'
  ].join('\n')
