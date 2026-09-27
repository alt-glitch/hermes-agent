import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { expect, test, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { RawGatewayClient } from '../boundary/gateway/client.ts'
import { createServerRequestRouter } from '../boundary/gateway/serverRequests.ts'
import { Log } from '../boundary/log.ts'
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
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'srq-000000000001', method: 'window.read', params: { session_id: 's' } })}\n`)
  await vi.waitFor(() => expect(written.some(f => f['id'] === 'srq-000000000001')).toBe(true))
  expect(written.find(f => f['id'] === 'srq-000000000001')?.['error']).toMatchObject({ code: -32601 })
  client.stop()
})
