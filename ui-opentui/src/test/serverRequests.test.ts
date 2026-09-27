import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { Option, Schema } from 'effect'
import { expect, test, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { RawGatewayClient } from '../boundary/gateway/client.ts'
import { createServerRequestRouter } from '../boundary/gateway/serverRequests.ts'
import { Log } from '../boundary/log.ts'
import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import { createSessionStore } from '../logic/store.ts'

// Recorded from the worktree gateway (tui_gateway.entry + server._clarify_block, stdio) on 2026-09-27.
const RECORDED_CLARIFY_FRAME = {
  jsonrpc: '2.0',
  id: 'srq-83c17576c465',
  method: 'clarify',
  params: { session_id: '68b3763a', question: 'Pick one', choices: ['alpha', 'beta'] }
}

test('a clarify server request opens the prompt and the answer is a JSON-RPC response with the request id', async () => {
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
  const written: Record<string, unknown>[] = []
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) written.push(JSON.parse(line))
  })

  const store = createSessionStore()
  const router = createServerRequestRouter(store.openPrompt)
  const client = new RawGatewayClient({ log: new Log(null), onEvent: () => {}, onServerRequest: router.handle })
  client.start()
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } })}\n`)
  stdout.write(`${JSON.stringify(RECORDED_CLARIFY_FRAME)}\n`)
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

  expect(router.answer('srq-83c17576c465', { answer: 'beta' })).toBe(true)
  await vi.waitFor(() => expect(written.some(f => f['id'] === 'srq-83c17576c465')).toBe(true))
  // ClarifyResult (tui_gateway/contracts/server_requests.py): {answer?: str, answers?: dict}.
  expect(written.find(f => f['id'] === 'srq-83c17576c465')).toEqual({
    jsonrpc: '2.0',
    id: 'srq-83c17576c465',
    result: { answer: 'beta' }
  })
  // A second answer for the same id writes nothing: the request is no longer open.
  expect(router.answer('srq-83c17576c465', { answer: 'alpha' })).toBe(false)
  client.stop()
})

test('a server request method without a handler is answered -32601 at once', async () => {
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
  const written: Record<string, unknown>[] = []
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) written.push(JSON.parse(line))
  })
  const router = createServerRequestRouter(() => {})
  const client = new RawGatewayClient({ log: new Log(null), onEvent: () => {}, onServerRequest: router.handle })
  client.start()
  stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 'srq-000000000001', method: 'window.read', params: { session_id: 's' } })}\n`
  )
  await vi.waitFor(() => expect(written.some(f => f['id'] === 'srq-000000000001')).toBe(true))
  expect(written.find(f => f['id'] === 'srq-000000000001')?.['error']).toMatchObject({ code: -32601 })
  client.stop()
})

test('round trip: answer writes one response, request.cancel closes the prompt and writes nothing, approval answers {choice}', async () => {
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
  const written: Record<string, unknown>[] = []
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) written.push(JSON.parse(line))
  })
  const responsesFor = (id: string) => written.filter(f => f['id'] === id && !('method' in f))

  // Same wiring as entry/main.tsx: router.handle serves requests; a decoded request.cancel
  // makes the router forget the id and is applied to the store.
  const store = createSessionStore()
  const router = createServerRequestRouter(store.openPrompt)
  const decode = Schema.decodeUnknownOption(GatewayEventSchema)
  const client = new RawGatewayClient({
    log: new Log(null),
    onEvent: raw => {
      const event = decode(raw)
      if (Option.isNone(event)) return
      if (event.value.type === 'request.cancel') router.forget(event.value.payload.id)
      store.apply(event.value)
    },
    onServerRequest: router.handle
  })
  client.start()
  const send = (frame: unknown) => stdout.write(`${JSON.stringify(frame)}\n`)
  send({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } })

  // 1. clarify frame → prompt; the answer is exactly one response frame with that id.
  send({ jsonrpc: '2.0', id: 'srq-a', method: 'clarify', params: { session_id: 's', question: 'Name?' } })
  await vi.waitFor(() => expect(store.state.prompt).toMatchObject({ kind: 'clarify', requestId: 'srq-a' }))
  expect(router.answer('srq-a', { answer: 'Ada' })).toBe(true)
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
  expect(router.answer('srq-b', { answer: 'too late' })).toBe(false)

  // 3. approval frame answered → {choice}.
  send({
    jsonrpc: '2.0',
    id: 'srq-c',
    method: 'approval',
    params: { session_id: 's', command: 'rm -rf /tmp/x', description: 'delete temp' }
  })
  await vi.waitFor(() => expect(store.state.prompt).toMatchObject({ kind: 'approval', requestId: 'srq-c' }))
  expect(router.answer('srq-c', { choice: 'once' })).toBe(true)
  await vi.waitFor(() => expect(responsesFor('srq-c')).toHaveLength(1))
  expect(responsesFor('srq-c')[0]).toEqual({ jsonrpc: '2.0', id: 'srq-c', result: { choice: 'once' } })

  // The cancelled request never got a response frame; the answered one got exactly one.
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(responsesFor('srq-b')).toEqual([])
  expect(responsesFor('srq-a')).toHaveLength(1)
  client.stop()
})
