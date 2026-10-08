/**
 * Plain-language error copy (Ink userMessages parity, upstream 66878996dd).
 * Table tests for the pure mapping in logic/errorCopy.ts, plus the store,
 * slash and schema wiring that routes real wire failures through it.
 */
import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import { GatewayError } from '../boundary/errors.ts'
import { decodeServerRequest } from '../boundary/gateway/serverRequests.ts'
import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import {
  backendGaveUp,
  describeRpcError,
  describeSlashExecError,
  describeTurnFailure,
  exitCodeFromReason,
  isVersionSkewError,
  lastStderrLine,
  promptTimeoutNotice,
  RPC_COPY,
  setupRequiredText,
  shouldFallbackToDispatch
} from '../logic/errorCopy.ts'
import { dispatchSlash, type SlashContext } from '../logic/slash.ts'
import { createSessionStore } from '../logic/store.ts'

const rpcErr = (message: string, code?: number) =>
  new GatewayError({ method: 'x', reason: 'rpc-error', message, ...(code === undefined ? {} : { code }) })

describe('describeTurnFailure — error_surface code/layer table', () => {
  const rows: Array<[string, { code?: string; layer?: string; retryable?: boolean }, string, string]> = [
    [
      'upstream_blocked',
      { code: 'upstream_blocked', layer: 'provider' },
      'A firewall/CDN in front of the model provider blocked the request',
      "Set a User-Agent via the provider's extra_headers, or switch with /model."
    ],
    [
      'rate_limit',
      { code: 'rate_limit' },
      'The model provider is rate-limiting requests',
      'Wait a moment, then /retry.'
    ],
    [
      'context_overflow',
      { code: 'context_overflow' },
      'The conversation is too long for this model',
      'Run /compress, then /retry.'
    ],
    [
      'auth',
      { code: 'auth', layer: 'auth' },
      'The model provider rejected the API key',
      'Fix the key with /model, then /retry.'
    ],
    [
      'unknown code → layer',
      { code: 'weird', layer: 'streaming' },
      'The connection to the model provider dropped mid-reply',
      'Send /retry.'
    ],
    [
      'retryable=false picks hintNoRetry',
      { code: 'timeout', retryable: false },
      'The model provider did not answer in time',
      'Pick another model with /model; if it keeps happening, switch with /model.'
    ],
    ['no surface → fallback', {}, 'The request failed', 'Send /retry, or switch with /model.'],
    ['prototype key is not a row', { code: 'constructor', layer: 'toString' }, 'The request failed', 'Send /retry']
  ]
  test.each(rows)('%s', (_name, surface, title, hint) => {
    const text = describeTurnFailure({ error: 'Error: raw body', error_surface: surface, recoverable: true })
    const [first, details, next] = text.split('\n')
    expect(first).toBe(`${title}. Your message was not answered.`)
    expect(details).toBe('Details: raw body')
    expect(next).toContain(hint)
  })

  test('names the provider and clips a long raw detail', () => {
    const text = describeTurnFailure({
      error: 'x'.repeat(500),
      error_surface: { code: 'overloaded', provider: 'openai' }
    })
    expect(text.split('\n')[0]).toBe('The model provider is overloaded (openai). Your message was not answered.')
    expect(text.split('\n')[1]).toHaveLength('Details: '.length + 300)
    expect(text.split('\n')[1]?.endsWith('…')).toBe(true)
  })
})

describe('describeRpcError — transport/session table', () => {
  const rows: Array<[string, unknown, string]> = [
    ['unknown method code', rpcErr('nope', -32601), RPC_COPY.versionSkew],
    ['4000 extra inputs', rpcErr('Extra inputs are not permitted', 4000), RPC_COPY.versionSkew],
    ['uncoded unknown method', 'unknown method: foo.bar', RPC_COPY.versionSkew],
    ['4001 session not found', rpcErr('session not found', 4001), RPC_COPY.sessionNotFound],
    ['client not connected', new Error('gateway not connected: prompt.submit'), RPC_COPY.notConnected],
    ['client not running', new Error('gateway not running'), RPC_COPY.notConnected],
    ['Ink timeout text', 'request timed out after 30s', RPC_COPY.timedOut('30')],
    [
      'native timeout reason',
      new GatewayError({ method: 'x', reason: 'timeout', message: 'timeout: x' }),
      RPC_COPY.timedOut(undefined)
    ],
    ['4001 reused for another refusal passes through', rpcErr('no active session', 4001), 'no active session'],
    ['other errors pass through', rpcErr('model not allowed', 4002), 'model not allowed']
  ]
  test.each(rows)('%s', (_name, err, expected) => {
    expect(describeRpcError(err)).toBe(expected)
  })

  test('version skew needs the skew text on 4000', () => {
    expect(isVersionSkewError(rpcErr('bad value', 4000))).toBe(false)
  })
})

describe('slash.exec failure copy and the command.dispatch fallback gate', () => {
  const fallback: Array<[string, unknown, boolean]> = [
    ['skill refusal (4018)', rpcErr('skill command: use command.dispatch for /foo', 4018), true],
    [
      'snapshot refusal (4018)',
      rpcErr('snapshot restore mutates live config/state; use command.dispatch for /snapshot restore', 4018),
      true
    ],
    ['forwarded dispatch 4018 (would run twice)', rpcErr('nothing to retry', 4018), false],
    ['worker crash 5030', rpcErr('slash worker exited: boom', 5030), false],
    [
      'client timeout',
      new GatewayError({ method: 'slash.exec', reason: 'timeout', message: 'timeout: slash.exec' }),
      false
    ],
    [
      'transport down',
      new GatewayError({ method: 'slash.exec', reason: 'transport-down', message: 'gateway not running' }),
      false
    ],
    ['legacy uncoded refusal', new Error('unknown command'), true],
    ['legacy uncoded worker timeout', new Error('slash worker timed out'), false]
  ]
  test.each(fallback)('%s → fallback=%s', (_name, err, expected) => {
    expect(shouldFallbackToDispatch(err)).toBe(expected)
  })

  test('names the command, not the helper', () => {
    expect(describeSlashExecError('tools', rpcErr('slash worker timed out', 5030))).toBe(
      RPC_COPY.slashTimedOut('tools')
    )
    expect(describeSlashExecError('tools', rpcErr('slash worker exited: ImportError: x', 5030))).toBe(
      `${RPC_COPY.slashCrashed('tools')}\nDetails: ImportError: x`
    )
  })
})

describe('prompt timeout + crash-loop + setup copy', () => {
  test.each([
    ['sudo', 'timeout', 'Password prompt closed'],
    ['secret', 'timeout', 'Secret prompt closed'],
    ['vault.unlock_prompt', 'timeout', 'Unlock prompt closed'],
    ['sudo', 'interrupted', undefined],
    ['clarify', 'timeout', undefined]
  ])('%s/%s', (method, reason, prefix) => {
    const notice = promptTimeoutNotice(method, reason)
    if (prefix === undefined) expect(notice).toBeUndefined()
    else expect(notice?.startsWith(prefix)).toBe(true)
  })

  test('exit code + last real stderr line', () => {
    expect(exitCodeFromReason('gateway exited (code=3 signal=null)')).toBe(3)
    expect(exitCodeFromReason('gateway exited (code=null signal=SIGKILL)')).toBeUndefined()
    expect(lastStderrLine(['ImportError: no module x', '[lifecycle] spawn', ''])).toBe('ImportError: no module x')
    const text = backendGaveUp(3, 'ImportError: no module x')
    expect(text.split('\n').slice(0, 2)).toEqual([
      'Hermes stopped (exit code 3) and could not be restarted. Your chat is saved.',
      'Details: ImportError: no module x'
    ])
    expect(text).toContain('/logs')
  })

  test('Setup Required lists /setup before /model and the Models-page note (Ink order)', () => {
    const text = setupRequiredText()
    expect(text.indexOf('/setup')).toBeLessThan(text.indexOf('/model'))
    expect(text).toContain('• /model — pick a model (needs a session — add a provider first)')
    expect(text).toContain('Settings -> Models')
  })
})

describe('wiring', () => {
  test('a text-less failed turn renders error_surface copy (upstream_blocked), not `error: <msg>`', () => {
    const decoded = Schema.decodeUnknownOption(GatewayEventSchema)({
      type: 'message.complete',
      payload: {
        error: 'HTTP 403: <html>cloudflare</html>',
        error_surface: { code: 'upstream_blocked', layer: 'provider', retryable: false, provider: 'custom', extra: 1 },
        recoverable: true,
        status: 'error',
        text: 'Error: HTTP 403'
      }
    })
    expect(Option.isSome(decoded)).toBe(true)
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    if (Option.isSome(decoded)) store.apply(decoded.value)
    const last = store.state.messages.at(-1)?.text ?? ''
    expect(last.split('\n')[0]).toBe(
      'A firewall/CDN in front of the model provider blocked the request (custom). Your message was not answered.'
    )
    expect(last).toContain('Details: HTTP 403: <html>cloudflare</html>')
    expect(last).not.toMatch(/^error: /)
  })

  test('a malformed error_surface never drops the terminal frame', () => {
    const decoded = Schema.decodeUnknownOption(GatewayEventSchema)({
      type: 'message.complete',
      payload: { error: 'boom', error_surface: 'not-an-object', status: 'error' }
    })
    expect(Option.isSome(decoded)).toBe(true)
  })

  test('a timed-out sudo card says what was skipped', () => {
    const store = createSessionStore()
    const decoded = decodeServerRequest({
      id: 'sudo-1',
      method: 'sudo',
      params: { session_id: 'live-1', request_id: 'sudo-1' },
      respond: () => false
    })
    if (typeof decoded === 'string') throw new Error(decoded)
    store.openPrompt(decoded.prompt)
    store.apply({ type: 'request.cancel', payload: { id: 'sudo-1', method: 'sudo', reason: 'timeout' } })
    expect(store.state.prompt).toBeUndefined()
    expect(store.state.messages.at(-1)?.text).toBe(promptTimeoutNotice('sudo', 'timeout'))
  })

  test('crash-loop exhaustion is reported once per outage with exit code + stderr', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.stderr', payload: { line: 'ModuleNotFoundError: No module named x' } })
    store.apply({ type: 'gateway.recovery_exhausted', payload: { code: 1, reason: 'gateway exited (code=1)' } })
    store.apply({ type: 'gateway.recovery_exhausted', payload: { code: 1 } })
    const rows = store.state.messages.filter(m => m.text.includes('could not be restarted'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toContain('exit code 1')
    expect(rows[0]?.text).toContain('Details: ModuleNotFoundError: No module named x')
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'gateway.recovery_exhausted', payload: {} })
    expect(store.state.messages.filter(m => m.text.includes('could not be restarted'))).toHaveLength(2)
  })

  test('the `error` event rewrites session-not-found into /resume copy', () => {
    const store = createSessionStore()
    store.apply({ type: 'error', payload: { message: 'session not found' } })
    expect(store.state.messages.at(-1)?.text).toBe(`error: ${RPC_COPY.sessionNotFound}`)
  })

  const slashCtx = (request: (method: string) => Promise<unknown>) => {
    const system: string[] = []
    const calls: string[] = []
    const ctx = {
      sessionId: () => 'sid-1',
      request: async (method: string) => {
        calls.push(method)
        return request(method)
      },
      pushSystem: (text: string) => system.push(text)
    } as unknown as SlashContext
    return { ctx, system, calls }
  }

  test('a slash worker timeout surfaces as itself; no command.dispatch fallback', async () => {
    const p = slashCtx(async () => {
      throw rpcErr('slash worker timed out', 5030)
    })
    await dispatchSlash('/frobnicate', p.ctx)
    expect(p.calls).toEqual(['slash.exec'])
    expect(p.system).toEqual([`error: ${RPC_COPY.slashTimedOut('frobnicate')}`])
  })

  test('a "not mine" refusal still falls back to command.dispatch', async () => {
    const p = slashCtx(async method => {
      if (method === 'slash.exec') throw rpcErr('skill command: use command.dispatch for /frobnicate', 4018)
      return { type: 'exec', output: 'ran' }
    })
    await dispatchSlash('/frobnicate', p.ctx)
    expect(p.calls).toEqual(['slash.exec', 'command.dispatch'])
  })
})
