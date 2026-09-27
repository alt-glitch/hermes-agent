import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { Effect, Option, Schema } from 'effect'
import { expect, test, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { RawGatewayClient } from '../boundary/gateway/client.ts'
import type { GatewayTransport } from '../boundary/gateway/GatewayService.ts'
import { createServerRequestRouter } from '../boundary/gateway/serverRequests.ts'
import { Log } from '../boundary/log.ts'
import { createPromptResponder } from '../boundary/promptResponses.ts'
import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import { activateSession } from '../boundary/sessionLifecycle.ts'
import { createSessionStore } from '../logic/store.ts'

type Frame = Record<string, unknown>

/**
 * A mocked stdio gateway child. `replies` answers client RPCs by method (result per params);
 * `written` is every frame the client wrote on stdin.
 */
function mockGateway(replies: Readonly<Record<string, (params: Frame) => unknown>> = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    unref: vi.fn()
  }) as unknown as ChildProcessWithoutNullStreams
  spawnMock.mockReturnValueOnce(child)
  const written: Frame[] = []
  const send = (frame: unknown) => stdout.write(`${JSON.stringify(frame)}\n`)
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      const frame = JSON.parse(line) as Frame
      written.push(frame)
      const reply = typeof frame['method'] === 'string' ? replies[frame['method']] : undefined
      if (reply) send({ jsonrpc: '2.0', id: frame['id'], result: reply((frame['params'] ?? {}) as Frame) })
    }
  })
  const responsesFor = (id: string) => written.filter(f => f['id'] === id && !('method' in f))
  return { stdin, send, written, responsesFor }
}

/** The main.tsx wiring over a real RawGatewayClient: router shows prompts for the store's session;
 *  a request.cancel settles the store first, then the router forgets the id. */
function startClient(gateway: ReturnType<typeof mockGateway>, displayed?: string) {
  const store = createSessionStore()
  if (displayed) store.adoptFreshSession(displayed)
  const router = createServerRequestRouter({
    openPrompt: store.openPrompt,
    displayedSessionId: () => store.state.sessionId
  })
  const decode = Schema.decodeUnknownOption(GatewayEventSchema)
  const client = new RawGatewayClient({
    log: new Log(null),
    onEvent: raw => {
      const event = decode(raw)
      if (Option.isNone(event)) return
      store.apply(event.value)
      if (event.value.type === 'request.cancel') router.forget(event.value.payload.id)
    },
    onServerRequest: router.handle
  })
  client.start()
  gateway.send({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } })
  // The slice of GatewayTransport session hydration uses, over the same client.
  const transport: GatewayTransport = {
    subscribe: () => Effect.succeed(() => {}),
    request: (method, params) => Effect.promise(() => client.request(method, params)),
    replayRequests: entries => client.replayServerRequests(entries),
    sessionId: () => store.state.sessionId,
    logTail: () => []
  }
  const respond = createPromptResponder({
    router,
    lock: params => client.request('clarify.lock', params),
    warn: () => {}
  })
  return { store, router, client, transport, respond }
}

const clarify = (id: string, sessionId: string, question: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'clarify',
  params: { session_id: sessionId, question }
})

// Recorded from the worktree gateway (tui_gateway.entry + server._clarify_block, stdio) on 2026-09-27.
const RECORDED_CLARIFY_FRAME = {
  jsonrpc: '2.0',
  id: 'srq-83c17576c465',
  method: 'clarify',
  params: { session_id: '68b3763a', question: 'Pick one', choices: ['alpha', 'beta'] }
}

test('a clarify server request opens the prompt and the answer is a JSON-RPC response with the request id', async () => {
  const gateway = mockGateway()
  const { written } = gateway
  const { store, router, client } = startClient(gateway, '68b3763a')
  gateway.send(RECORDED_CLARIFY_FRAME)
  await vi.waitFor(() => expect(store.state.prompt?.kind).toBe('clarify'))

  expect(store.state.prompt).toEqual({
    kind: 'clarify',
    question: 'Pick one',
    choices: ['alpha', 'beta'],
    requestId: 'srq-83c17576c465'
  })
  // gateway.ready → the client advertises that it answers server requests.
  await vi.waitFor(() =>
    expect(written.find(f => f['method'] === 'client.capabilities')?.['params']).toEqual({ server_requests: true })
  )

  expect(router.answer('srq-83c17576c465', { answer: 'beta' })).toBe('sent')
  await vi.waitFor(() => expect(written.some(f => f['id'] === 'srq-83c17576c465')).toBe(true))
  // ClarifyResult (tui_gateway/contracts/server_requests.py): {answer?: str, answers?: dict}.
  expect(written.find(f => f['id'] === 'srq-83c17576c465')).toEqual({
    jsonrpc: '2.0',
    id: 'srq-83c17576c465',
    result: { answer: 'beta' }
  })
  // A second answer for the same id writes nothing: the request is no longer open.
  expect(router.answer('srq-83c17576c465', { answer: 'alpha' })).toBe('closed')
  client.stop()
})

test('a server request method without a handler is answered -32601 at once', async () => {
  const gateway = mockGateway()
  const { client } = startClient(gateway, 's')
  gateway.send({ jsonrpc: '2.0', id: 'srq-000000000001', method: 'window.read', params: { session_id: 's' } })
  await vi.waitFor(() => expect(gateway.responsesFor('srq-000000000001')).toHaveLength(1))
  expect(gateway.responsesFor('srq-000000000001')[0]?.['error']).toMatchObject({ code: -32601 })
  client.stop()
})

test('round trip: answer writes one response, request.cancel closes the prompt and writes nothing, approval answers {choice}', async () => {
  const gateway = mockGateway()
  const { send, responsesFor } = gateway
  const { store, router, client } = startClient(gateway, 's')

  // 1. clarify frame → prompt; the answer is exactly one response frame with that id.
  send({ jsonrpc: '2.0', id: 'srq-a', method: 'clarify', params: { session_id: 's', question: 'Name?' } })
  await vi.waitFor(() => expect(store.state.prompt).toMatchObject({ kind: 'clarify', requestId: 'srq-a' }))
  expect(router.answer('srq-a', { answer: 'Ada' })).toBe('sent')
  await vi.waitFor(() => expect(responsesFor('srq-a')).toHaveLength(1))
  expect(responsesFor('srq-a')[0]).toEqual({ jsonrpc: '2.0', id: 'srq-a', result: { answer: 'Ada' } })

  // 2. request.cancel for an open clarify closes its prompt; a late answer writes nothing.
  store.clearPrompt()
  send({ jsonrpc: '2.0', id: 'srq-b', method: 'clarify', params: { session_id: 's', question: 'Again?' } })
  await vi.waitFor(() => expect(store.state.prompt).toMatchObject({ kind: 'clarify', requestId: 'srq-b' }))
  send({
    jsonrpc: '2.0',
    method: 'event',
    params: { type: 'request.cancel', session_id: 's', payload: { id: 'srq-b', method: 'clarify', reason: 'timeout' } }
  })
  await vi.waitFor(() => expect(store.state.prompt).toBeUndefined())
  expect(store.state.messages.at(-1)?.text).toBe('clarification expired — no response was accepted')
  expect(router.answer('srq-b', { answer: 'too late' })).toBe('closed')

  // 3. approval frame answered → {choice}.
  send({
    jsonrpc: '2.0',
    id: 'srq-c',
    method: 'approval',
    params: { session_id: 's', command: 'rm -rf /tmp/x', description: 'delete temp' }
  })
  await vi.waitFor(() => expect(store.state.prompt).toMatchObject({ kind: 'approval', requestId: 'srq-c' }))
  expect(router.answer('srq-c', { choice: 'once' })).toBe('sent')
  await vi.waitFor(() => expect(responsesFor('srq-c')).toHaveLength(1))
  expect(responsesFor('srq-c')[0]).toEqual({ jsonrpc: '2.0', id: 'srq-c', result: { choice: 'once' } })

  // The cancelled request never got a response frame; the answered one got exactly one.
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(responsesFor('srq-b')).toEqual([])
  expect(responsesFor('srq-a')).toHaveLength(1)
  client.stop()
})

test('an open_requests replay on session activation opens the prompt; the answer carries the original id', async () => {
  const gateway = mockGateway({
    'session.activate': params => ({
      session_id: params['session_id'],
      messages: [],
      open_requests: [{ id: 'srq-replay', method: 'clarify', params: { session_id: 's1', question: 'Still there?' } }]
    })
  })
  const { store, client, transport, respond } = startClient(gateway)

  await Effect.runPromise(activateSession(transport, store, { targetSessionId: 's1' }))
  expect(store.state.sessionId).toBe('s1')
  expect(store.state.prompt).toMatchObject({ kind: 'clarify', question: 'Still there?', requestId: 'srq-replay' })

  expect(await respond({ kind: 'answer', requestId: 'srq-replay', result: { answer: 'yes' } })).toEqual({
    kind: 'accepted'
  })
  await vi.waitFor(() => expect(gateway.responsesFor('srq-replay')).toHaveLength(1))
  expect(gateway.responsesFor('srq-replay')[0]).toEqual({ jsonrpc: '2.0', id: 'srq-replay', result: { answer: 'yes' } })
  client.stop()
})

test('a request for a session that is not displayed is held; switching to that session opens it without a replay', async () => {
  const gateway = mockGateway({
    // open_requests was built before either s2 request existed; srq-late lands mid-activate, before
    // the response (the window where displayedSessionId is still s1).
    'session.activate': params => {
      gateway.send(clarify('srq-late', 's2', 'Also for s2?'))
      return { session_id: params['session_id'], messages: [], open_requests: [] }
    }
  })
  const { store, router, client, transport } = startClient(gateway, 's1')

  gateway.send(clarify('srq-other', 's2', 'For s2?'))
  // A later frame on the same stream proves the first one was processed.
  gateway.send(clarify('srq-mine', 's1', 'For s1?'))
  await vi.waitFor(() => expect(store.state.prompt).toMatchObject({ requestId: 'srq-mine' }))
  expect(router.pending()).toEqual(['srq-mine'])
  expect(gateway.responsesFor('srq-other')).toEqual([])

  // The backend built open_requests before srq-other existed: the switch alone must show it.
  await Effect.runPromise(activateSession(transport, store, { targetSessionId: 's2' }))
  expect(store.state.prompt).toMatchObject({ kind: 'clarify', question: 'For s2?', requestId: 'srq-other' })
  expect(router.pending()).toEqual(['srq-other', 'srq-late'])
  expect(router.answer('srq-other', { answer: 'ok' })).toBe('sent')
  expect(store.state.prompt).toMatchObject({ question: 'Also for s2?', requestId: 'srq-late' })
  await vi.waitFor(() => expect(gateway.responsesFor('srq-other')).toHaveLength(1))
  client.stop()
})

test('a replay of a held request does not duplicate it: the answer writes exactly one frame', async () => {
  const pending = { id: 'srq-other', method: 'clarify', params: { session_id: 's2', question: 'For s2?' } }
  const gateway = mockGateway({
    'session.activate': params => ({ session_id: params['session_id'], messages: [], open_requests: [pending] })
  })
  const { store, router, client, transport } = startClient(gateway, 's1')

  gateway.send({ jsonrpc: '2.0', ...pending })
  gateway.send(clarify('srq-mine', 's1', 'For s1?'))
  await vi.waitFor(() => expect(store.state.prompt).toMatchObject({ requestId: 'srq-mine' }))

  await Effect.runPromise(activateSession(transport, store, { targetSessionId: 's2' }))
  expect(store.state.prompt).toMatchObject({ requestId: 'srq-other' })
  expect(router.pending()).toEqual(['srq-other'])
  expect(router.answer('srq-other', { answer: 'ok' })).toBe('sent')
  expect(router.answer('srq-other', { answer: 'again' })).toBe('closed')
  await vi.waitFor(() => expect(gateway.responsesFor('srq-other')).toHaveLength(1))
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(gateway.responsesFor('srq-other')).toEqual([{ jsonrpc: '2.0', id: 'srq-other', result: { answer: 'ok' } }])
  expect(router.pending()).toEqual([])
  client.stop()
})

test('request.cancel for a held request of a session that is not displayed drops it; a later switch shows nothing', async () => {
  const gateway = mockGateway({
    'session.activate': params => ({ session_id: params['session_id'], messages: [], open_requests: [] })
  })
  const { store, router, client, transport } = startClient(gateway, 's1')

  gateway.send(clarify('srq-other', 's2', 'For s2?'))
  gateway.send({
    jsonrpc: '2.0',
    method: 'event',
    params: {
      type: 'request.cancel',
      session_id: 's2',
      payload: { id: 'srq-other', method: 'clarify', reason: 'timeout' }
    }
  })
  gateway.send(clarify('srq-mine', 's1', 'For s1?'))
  await vi.waitFor(() => expect(store.state.prompt).toMatchObject({ requestId: 'srq-mine' }))
  expect(router.forget('srq-other')).toBe(false)

  await Effect.runPromise(activateSession(transport, store, { targetSessionId: 's2' }))
  expect(store.state.sessionId).toBe('s2')
  expect(store.state.prompt).toBeUndefined()
  expect(router.pending()).toEqual([])
  expect(router.answer('srq-other', { answer: 'late' })).toBe('closed')
  expect(gateway.responsesFor('srq-other')).toEqual([])
  client.stop()
})

test('requests queue: answering the shown one writes one frame and shows the next; cancelling a queued one is silent', async () => {
  const gateway = mockGateway()
  const { store, router, client } = startClient(gateway, 's')
  gateway.send(clarify('srq-1', 's', 'First?'))
  gateway.send(clarify('srq-2', 's', 'Second?'))
  gateway.send(clarify('srq-3', 's', 'Third?'))
  await vi.waitFor(() => expect(router.pending()).toEqual(['srq-1', 'srq-2', 'srq-3']))
  expect(store.state.prompt).toMatchObject({ requestId: 'srq-1' })

  expect(router.answer('srq-1', { answer: 'one' })).toBe('sent')
  expect(store.state.prompt).toMatchObject({ question: 'Second?', requestId: 'srq-2' })
  await vi.waitFor(() => expect(gateway.responsesFor('srq-1')).toHaveLength(1))

  const shown = store.state.prompt
  const messages = store.state.messages.length
  gateway.send({
    jsonrpc: '2.0',
    method: 'event',
    params: { type: 'request.cancel', session_id: 's', payload: { id: 'srq-3', method: 'clarify', reason: 'timeout' } }
  })
  await vi.waitFor(() => expect(router.pending()).toEqual(['srq-2']))
  expect(store.state.prompt).toBe(shown)
  expect(store.state.messages).toHaveLength(messages)
  expect(gateway.written.filter(f => !('method' in f)).map(f => f['id'])).toEqual(['srq-1'])
  client.stop()
})

test('an answer that could not be written keeps the request open; the retry writes exactly one frame', async () => {
  const gateway = mockGateway()
  const { store, router, client, respond } = startClient(gateway, 's')
  gateway.send(clarify('srq-w', 's', 'Name?'))
  await vi.waitFor(() => expect(store.state.prompt).toMatchObject({ requestId: 'srq-w' }))

  vi.spyOn(gateway.stdin, 'write').mockImplementationOnce(() => {
    throw new Error('write EPIPE')
  })
  const reply = { kind: 'answer', requestId: 'srq-w', result: { answer: 'Ada' } } as const
  expect(await respond(reply)).toMatchObject({ kind: 'uncertain', message: expect.stringContaining('not sent') })
  expect(router.pending()).toEqual(['srq-w'])
  expect(store.state.prompt).toMatchObject({ requestId: 'srq-w' })

  expect(await respond(reply)).toEqual({ kind: 'accepted' })
  await vi.waitFor(() => expect(gateway.responsesFor('srq-w')).toHaveLength(1))
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(gateway.responsesFor('srq-w')).toEqual([{ jsonrpc: '2.0', id: 'srq-w', result: { answer: 'Ada' } }])
  expect(router.pending()).toEqual([])
  client.stop()
})

test('the final clarify.lock forgets the batch request', async () => {
  const gateway = mockGateway({
    'clarify.lock': params => ({ status: 'ok', remaining: params['question_id'] === 'q1' ? ['q2'] : [] })
  })
  const { store, router, client, respond } = startClient(gateway, 's')
  gateway.send({
    jsonrpc: '2.0',
    id: 'srq-batch',
    method: 'clarify',
    params: {
      session_id: 's',
      questions: [
        { qid: 'q1', question: 'One?' },
        { qid: 'q2', question: 'Two?' }
      ]
    }
  })
  await vi.waitFor(() => expect(store.state.prompt).toMatchObject({ requestId: 'srq-batch' }))

  const lock = (questionId: string) =>
    respond({ kind: 'lock', requestId: 'srq-batch', questionId, answer: `a-${questionId}` })
  expect(await lock('q1')).toEqual({ kind: 'accepted' })
  expect(router.pending()).toEqual(['srq-batch'])
  expect(await lock('q2')).toEqual({ kind: 'accepted' })
  expect(router.pending()).toEqual([])
  // Nothing is left to answer: a late response is refused and nothing is written.
  expect(router.answer('srq-batch', { answer: '' })).toBe('closed')
  expect(router.forget('srq-batch')).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(gateway.responsesFor('srq-batch')).toEqual([])
  client.stop()
})
