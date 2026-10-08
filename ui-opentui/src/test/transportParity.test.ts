import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { EventEmitter } from 'node:events'

import { DEAD_OUTPUT_EXIT_THRESHOLD, deadStreamCode, installDeadOutputGuard } from '../boundary/deadOutput.ts'
import { RawGatewayClient, WS_HEARTBEAT_DEAD_MS, WS_HEARTBEAT_INTERVAL_MS } from '../boundary/gateway/client.ts'
import { resolvePython } from '../boundary/gateway/python.ts'
import { Log } from '../boundary/log.ts'
import { ATTACHED_CONNECTION_LOST_NOTICE, ATTACHED_CONNECTION_LOST_STATUS, createSessionStore } from '../logic/store.ts'

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = []
  readyState = 0
  readonly sent: string[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(frame: string): void {
    if (this.readyState !== 1) throw new Error('socket not open')
    this.sent.push(frame)
  }

  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  close(code = 1000): void {
    if (this.readyState === 3) return
    this.readyState = 3
    const event = new Event('close')
    Object.defineProperty(event, 'code', { value: code })
    this.dispatchEvent(event)
  }
}

const event = (type: string, payload: unknown = {}) =>
  JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, payload } })

describe('attach-mode transport parity', () => {
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

  test('streamed frames keep a socket alive past the deadline while its pong is delayed', async () => {
    vi.useFakeTimers()
    const onExit = vi.fn()
    const client = new RawGatewayClient({ log: new Log(), onEvent: vi.fn(), onExit })
    client.start()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.message(event('gateway.ready', { heartbeat: true }))

    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_INTERVAL_MS)
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({ method: 'gateway.ping' })
    // A long turn streams a delta every second; the pong never arrives.
    for (let elapsed = 0; elapsed < WS_HEARTBEAT_DEAD_MS * 3; elapsed += 1_000) {
      socket.message(event('message.delta', { text: '.' }))
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(onExit).not.toHaveBeenCalled()
    expect(socket.readyState).toBe(1)

    // A socket gone fully silent still trips the deadline.
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_DEAD_MS)
    expect(onExit.mock.calls).toEqual([['gateway websocket heartbeat acknowledgement timed out']])
    client.stop()
  })

  test('a frame from a replaced socket does not extend the new generation', async () => {
    vi.useFakeTimers()
    const exits: string[] = []
    const client = new RawGatewayClient({ log: new Log(), onEvent: vi.fn(), onExit: reason => exits.push(reason) })
    client.start()
    const first = FakeWebSocket.instances[0]!
    first.open()
    process.env.HERMES_TUI_GATEWAY_URL = 'ws://replacement.test/api/ws?token=new'
    client.start()
    const second = FakeWebSocket.instances[1]!
    second.open()
    second.message(event('gateway.ready', { heartbeat: true }))
    await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_INTERVAL_MS)
    for (let elapsed = 0; elapsed < WS_HEARTBEAT_DEAD_MS; elapsed += 5_000) {
      first.message(event('message.delta', { text: 'stale' }))
      await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(exits).toEqual(['gateway attach url changed', 'gateway websocket heartbeat acknowledgement timed out'])
    client.stop()
  })

  test('the client reports attach mode while onExit runs for a websocket drop', () => {
    const seen: boolean[] = []
    const client: RawGatewayClient = new RawGatewayClient({
      log: new Log(),
      onEvent: vi.fn(),
      onExit: () => seen.push(client.attached)
    })
    client.start()
    FakeWebSocket.instances[0]!.open()
    FakeWebSocket.instances[0]!.close(1006)
    expect(seen).toEqual([true])
    client.stop()
  })
})

describe('attached drop copy', () => {
  test('an attached drop says "connection lost · reconnecting…", not the crash line', () => {
    const store = createSessionStore()
    store.setSessionId('sid-1')
    store.apply({ type: 'message.start' })
    store.apply({ type: 'gateway.exited', payload: { reason: 'gateway websocket closed (1006)', attached: true } })
    expect(store.state.info.running).toBe(false)
    expect(store.state.status).toBe(ATTACHED_CONNECTION_LOST_STATUS)
    const sys = store.state.messages.filter(m => m.role === 'system').map(m => m.text)
    expect(sys).toEqual([ATTACHED_CONNECTION_LOST_NOTICE])
    expect(sys.join('\n')).not.toContain('gateway exited')

    store.apply({ type: 'gateway.recovering', payload: { attempt: 2, delay_ms: 2000, attached: true } })
    expect(store.state.status).toBe('retrying in 2s (attempt 2)')
  })

  test('spawn-mode exit keeps the crash copy', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.exited', payload: { reason: 'SIGKILL' } })
    expect(store.state.status).toBe('gateway exited')
    expect(store.state.messages.at(-1)?.text).toContain('in-flight reply was lost')
  })
})

describe('gateway python resolution', () => {
  test('trusts HERMES_PYTHON only, else bare python3 (python on win32)', () => {
    expect(resolvePython({ HERMES_PYTHON: ' /opt/hermes/bin/python ' }, 'linux')).toBe('/opt/hermes/bin/python')
    expect(resolvePython({ PYTHON: '/stale/python', VIRTUAL_ENV: '/stale/venv' }, 'linux')).toBe('python3')
    expect(resolvePython({ HERMES_PYTHON: '   ' }, 'linux')).toBe('python3')
    expect(resolvePython({}, 'win32')).toBe('python')
  })
})

describe('dead output stream guard', () => {
  const ioError = (code: string) => Object.assign(new Error(`write ${code}`), { code })

  test(`exits after ${DEAD_OUTPUT_EXIT_THRESHOLD} consecutive EIO/EPIPE errors`, () => {
    const emitter = new EventEmitter()
    const onDeadOutput = vi.fn()
    const dispose = installDeadOutputGuard({ emitter, onDeadOutput })
    for (let i = 0; i < DEAD_OUTPUT_EXIT_THRESHOLD - 1; i += 1) emitter.emit('uncaughtExceptionMonitor', ioError('EIO'))
    expect(onDeadOutput).not.toHaveBeenCalled()
    emitter.emit('uncaughtExceptionMonitor', ioError('EPIPE'))
    expect(onDeadOutput.mock.calls).toEqual([['EPIPE', DEAD_OUTPUT_EXIT_THRESHOLD]])
    emitter.emit('uncaughtExceptionMonitor', ioError('EIO'))
    expect(onDeadOutput).toHaveBeenCalledTimes(1)
    dispose()
    expect(emitter.listenerCount('uncaughtExceptionMonitor')).toBe(0)
  })

  test('any other error resets the streak', () => {
    const emitter = new EventEmitter()
    const onDeadOutput = vi.fn()
    installDeadOutputGuard({ emitter, onDeadOutput })
    for (let i = 0; i < 4; i += 1) emitter.emit('uncaughtExceptionMonitor', ioError('EIO'))
    emitter.emit('uncaughtExceptionMonitor', new Error('render bug'))
    for (let i = 0; i < 4; i += 1) emitter.emit('uncaughtExceptionMonitor', ioError('EIO'))
    expect(onDeadOutput).not.toHaveBeenCalled()
    expect(deadStreamCode(ioError('ENOENT'))).toBeUndefined()
    expect(deadStreamCode('EIO')).toBeUndefined()
  })
})
