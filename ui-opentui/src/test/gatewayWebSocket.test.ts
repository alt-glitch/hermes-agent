import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import {
  RawGatewayClient,
  RawGatewayRequestError,
  redactGatewayUrl,
  resolveGatewayAttachUrl,
  WS_HEARTBEAT_DEAD_MS,
  WS_HEARTBEAT_INTERVAL_MS
} from '../boundary/gateway/client.ts'
import { Log } from '../boundary/log.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly sent: string[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(frame: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket not open')
    this.sent.push(frame)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  message(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    const event = new Event('close')
    Object.defineProperty(event, 'code', { value: code })
    this.dispatchEvent(event)
  }
}

function frameId(socket: FakeWebSocket, index = 0): string {
  const parsed: unknown = JSON.parse(socket.sent[index] ?? '{}')
  if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || typeof parsed.id !== 'string') {
    throw new Error('missing request id')
  }
  return parsed.id
}

function binaryFrame(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

describe('RawGatewayClient dashboard websocket attachment', () => {
  const originalWebSocket = globalThis.WebSocket
  let originalUrl: string | undefined

  beforeEach(() => {
    spawnMock.mockReset()
    FakeWebSocket.instances = []
    originalUrl = process.env.HERMES_TUI_GATEWAY_URL
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    process.env.HERMES_TUI_GATEWAY_URL = 'ws://gateway.test/api/ws?token=secret'
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalUrl === undefined) delete process.env.HERMES_TUI_GATEWAY_URL
    else process.env.HERMES_TUI_GATEWAY_URL = originalUrl
    globalThis.WebSocket = originalWebSocket
  })

  test('attaches instead of spawning, waits for open, and routes text RPC responses', async () => {
    const client = new RawGatewayClient({ log: new Log(), onEvent: vi.fn() })
    client.start()
    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()
    expect(spawnMock).not.toHaveBeenCalled()

    const response = client.request<{ ok: boolean }>('session.create', { cols: 80 })
    expect(socket?.sent).toEqual([])
    socket?.open()
    await vi.waitFor(() => expect(socket?.sent).toHaveLength(1))
    const request = JSON.parse(socket?.sent[0] ?? '{}') as { method?: unknown }
    expect(request.method).toBe('session.create')

    socket?.message(JSON.stringify({ id: frameId(socket!), jsonrpc: '2.0', result: { ok: true } }))
    await expect(response).resolves.toEqual({ ok: true })
    client.stop()
  })

  test('delivers an early ready event and decodes binary event frames', () => {
    const events: unknown[] = []
    const client = new RawGatewayClient({ log: new Log(), onEvent: event => events.push(event) })
    client.start()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.message(
      binaryFrame({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { skin: {} } } })
    )
    expect(events).toEqual([{ type: 'gateway.ready', payload: { skin: {} } }])
    expect(client.getLogTail()).toContain('[gateway] ready')
    client.stop()
  })

  test('publishes transport exit before rejecting pending RPCs on close', async () => {
    const order: string[] = []
    const client = new RawGatewayClient({
      log: new Log(),
      onEvent: vi.fn(),
      onExit: () => order.push('exit')
    })
    client.start()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    const request = client.request('session.create', {}).catch(error => {
      order.push('rejected')
      throw error
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    socket.close(1011)
    await expect(request).rejects.toMatchObject({
      reason: 'transport-down',
      message: 'gateway websocket closed (1011)'
    })
    expect(order).toEqual(['exit', 'rejected'])
  })

  test('rotates URLs, rejects stale pending work, and recovers onto the new socket', async () => {
    const client = new RawGatewayClient({ log: new Log(), onEvent: vi.fn() })
    client.start()
    const oldSocket = FakeWebSocket.instances[0]!
    oldSocket.open()
    const stale = client.request('session.create', {})
    await vi.waitFor(() => expect(oldSocket.sent).toHaveLength(1))

    process.env.HERMES_TUI_GATEWAY_URL = 'ws://new.test/api/ws?token=new-secret'
    const fresh = client.request<{ ok: boolean }>('session.create', {})
    await expect(stale).rejects.toMatchObject({ reason: 'transport-down', message: 'gateway attach url changed' })
    expect(FakeWebSocket.instances).toHaveLength(2)
    const newSocket = FakeWebSocket.instances[1]!
    expect(newSocket.url).toContain('new.test')
    newSocket.open()
    await vi.waitFor(() => expect(newSocket.sent).toHaveLength(1))
    newSocket.message(JSON.stringify({ id: frameId(newSocket), jsonrpc: '2.0', result: { ok: true } }))
    await expect(fresh).resolves.toEqual({ ok: true })
    client.stop()
  })

  test('can restart the attached transport after a close', () => {
    const client = new RawGatewayClient({ log: new Log(), onEvent: vi.fn() })
    client.start()
    const first = FakeWebSocket.instances[0]!
    first.open()
    first.close(1006)
    client.start()
    expect(FakeWebSocket.instances).toHaveLength(2)
    client.stop()
  })

  test('does not heartbeat when gateway.ready omits the advertised capability', async () => {
    vi.useFakeTimers()
    const onExit = vi.fn()
    const client = new RawGatewayClient({ log: new Log(), onEvent: vi.fn(), onExit })
    client.start()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.message(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }))

    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_INTERVAL_MS + WS_HEARTBEAT_DEAD_MS + 1)

    expect(socket.sent).toEqual([])
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(onExit).not.toHaveBeenCalled()
    client.stop()
  })

  test('keeps a healthy idle socket open while heartbeat acknowledgements arrive', async () => {
    vi.useFakeTimers()
    const onExit = vi.fn()
    const client = new RawGatewayClient({ log: new Log(), onEvent: vi.fn(), onExit })
    client.start()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.message(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'gateway.ready', payload: { heartbeat: true } }
      })
    )

    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_INTERVAL_MS)
      const heartbeat = JSON.parse(socket.sent.at(-1) ?? '{}') as { id?: string; method?: string }
      expect(heartbeat.method).toBe('gateway.ping')
      socket.message(JSON.stringify({ id: heartbeat.id, jsonrpc: '2.0', result: { ok: true } }))
    }

    expect(socket.sent).toHaveLength(4)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(onExit).not.toHaveBeenCalled()
    client.stop()
  })

  test('forces existing attach recovery when a heartbeat acknowledgement is swallowed', async () => {
    vi.useFakeTimers()
    const exits: string[] = []
    const client = new RawGatewayClient({
      log: new Log(),
      onEvent: vi.fn(),
      onExit: reason => {
        exits.push(reason)
        client.start()
      }
    })
    client.start()
    const first = FakeWebSocket.instances[0]!
    first.open()
    first.message(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'gateway.ready', payload: { heartbeat: true } }
      })
    )

    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_INTERVAL_MS)
    expect(JSON.parse(first.sent[0] ?? '{}')).toMatchObject({ method: 'gateway.ping' })
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_DEAD_MS)

    expect(first.readyState).toBe(FakeWebSocket.CLOSED)
    expect(exits).toEqual(['gateway websocket heartbeat acknowledgement timed out'])
    expect(FakeWebSocket.instances).toHaveLength(2)
    const replacement = FakeWebSocket.instances[1]!
    replacement.open()
    replacement.message(
      JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } })
    )
    client.stop()
  })

  test('disarms heartbeat timers on generation replacement and stop', async () => {
    vi.useFakeTimers()
    const onExit = vi.fn()
    const client = new RawGatewayClient({ log: new Log(), onEvent: vi.fn(), onExit })
    client.start()
    const first = FakeWebSocket.instances[0]!
    first.open()
    first.message(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'gateway.ready', payload: { heartbeat: true } }
      })
    )
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_INTERVAL_MS)
    expect(first.sent).toHaveLength(1)

    process.env.HERMES_TUI_GATEWAY_URL = 'ws://replacement.test/api/ws?token=new-secret'
    client.start()
    const replacement = FakeWebSocket.instances[1]!
    replacement.open()
    replacement.message(
      JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } })
    )
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_DEAD_MS + WS_HEARTBEAT_INTERVAL_MS)
    expect(first.sent).toHaveLength(1)
    expect(replacement.sent).toEqual([])
    expect(onExit).not.toHaveBeenCalled()

    client.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('redacts user-info and query credentials from all attach diagnostics', () => {
    const secret = 'ws://alice:hunter2@gateway.test/api/ws?token=secret&channel=private'
    process.env.HERMES_TUI_GATEWAY_URL = secret
    globalThis.WebSocket = class ThrowingWebSocket {
      constructor() {
        throw new Error('constructor failed')
      }
    } as unknown as typeof WebSocket
    const client = new RawGatewayClient({ log: new Log(), onEvent: vi.fn() })
    client.start()
    const tail = client.getLogTail().join('\n')
    expect(tail).toContain('ws://***@gateway.test/api/ws?***')
    expect(tail).not.toContain('alice')
    expect(tail).not.toContain('hunter2')
    expect(tail).not.toContain('token=secret')
    client.stop()
  })

  test('resolves and redacts attach URLs without leaking malformed credentials', () => {
    expect(resolveGatewayAttachUrl({ HERMES_TUI_GATEWAY_URL: '  ws://example.test/ws  ' })).toBe('ws://example.test/ws')
    expect(redactGatewayUrl('ws://alice:hunter2@gateway.test:99999/ws?token=secret')).toBe(
      'ws://***@gateway.test:99999/ws?***'
    )
  })

  test('uses typed transport-down failures before a socket is available', async () => {
    delete process.env.HERMES_TUI_GATEWAY_URL
    const client = new RawGatewayClient({ log: new Log(), onEvent: vi.fn() })
    await expect(client.request('session.create', {})).rejects.toBeInstanceOf(RawGatewayRequestError)
  })
})
