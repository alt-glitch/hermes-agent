import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import {
  CHILD_CLOSE_GRACE_MS,
  CHILD_FORCE_KILL_GRACE_MS,
  RawGatewayClient,
  RawGatewayRequestError,
  SESSION_RESPONSE_FRAME_ABSOLUTE_MAX_BYTES,
  SESSION_RESPONSE_FRAME_MAX_BYTES,
  STARTUP_TIMEOUT_MS,
  STDERR_LINE_MAX_BYTES,
  STDOUT_FRAME_MAX_BYTES,
  sessionResponseFrameLimitForHeap
} from '../boundary/gateway/client.ts'
import { Log } from '../boundary/log.ts'

interface FakeChild {
  readonly kill: ReturnType<typeof vi.fn>
  readonly process: ChildProcessWithoutNullStreams
  readonly stderr: PassThrough
  readonly stdout: PassThrough
  readonly unref: ReturnType<typeof vi.fn>
}

interface FakeChildOptions {
  readonly ignoreEof?: boolean
  readonly ignoreSignals?: boolean
  readonly killError?: Error
  readonly killResult?: boolean
}

interface LargeHistoryMessage {
  readonly text: string
}

interface LargeHistoryResponse {
  readonly messages: readonly LargeHistoryMessage[]
}

function fakeChild(options: FakeChildOptions = {}): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const events = new EventEmitter()
  const kill = vi.fn(() => {
    if (options.killError) throw options.killError
    const result = options.killResult ?? true
    if (!result) return false
    if (!options.ignoreSignals) events.emit('close', null, 'SIGTERM')
    return true
  })
  const unref = vi.fn()
  const process = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    kill,
    unref
  }) as unknown as ChildProcessWithoutNullStreams
  if (!options.ignoreEof) {
    stdin.once('finish', () => process.emit('close', 0, null))
  }
  return { kill, process, stderr, stdout, unref }
}

function readyFrame(): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } })}\n`
}

function eventTypes(events: readonly unknown[]): string[] {
  return events.flatMap(event => {
    if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') return []
    return [event.type]
  })
}

function stderrLines(events: readonly unknown[]): string[] {
  return events.flatMap(event => {
    if (!event || typeof event !== 'object' || !('type' in event) || event.type !== 'gateway.stderr') return []
    if (!('payload' in event) || !event.payload || typeof event.payload !== 'object') return []
    if (!('line' in event.payload) || typeof event.payload.line !== 'string') return []
    return [event.payload.line]
  })
}

async function rawRequestFailure(promise: Promise<unknown>): Promise<RawGatewayRequestError> {
  try {
    await promise
    throw new Error('expected request to reject')
  } catch (error) {
    if (error instanceof RawGatewayRequestError) return error
    throw error
  }
}

describe('RawGatewayClient child lifecycle isolation', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('derives the large session-response ceiling from heap headroom with an absolute bound', () => {
    const mib = 1024 * 1024
    expect(sessionResponseFrameLimitForHeap(Number.NaN)).toBe(STDOUT_FRAME_MAX_BYTES)
    expect(sessionResponseFrameLimitForHeap(128 * mib)).toBe(STDOUT_FRAME_MAX_BYTES)
    expect(sessionResponseFrameLimitForHeap(1024 * mib)).toBe(128 * mib)
    expect(sessionResponseFrameLimitForHeap(16 * 1024 * mib)).toBe(SESSION_RESPONSE_FRAME_ABSOLUTE_MAX_BYTES)
  })

  test('accepts valid resume and history responses above the ordinary frame ceiling', async () => {
    expect(SESSION_RESPONSE_FRAME_MAX_BYTES).toBeGreaterThan(STDOUT_FRAME_MAX_BYTES)
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child.process)
    const events: unknown[] = []
    const client = new RawGatewayClient({
      log: new Log(null, 'debug'),
      onEvent: event => events.push(event)
    })

    client.start()
    child.stdout.write(readyFrame())
    const bodyChars = STDOUT_FRAME_MAX_BYTES + 1024
    const chunk = 'h'.repeat(1024 * 1024)
    let requestIndex = 0
    const methods: readonly string[] = ['session.resume', 'session.history']
    for (const method of methods) {
      requestIndex += 1
      const pending = client.request<LargeHistoryResponse>(method, { session_id: 'large' })
      child.stdout.write(
        method === 'session.resume'
          ? `{"jsonrpc": "2.0", "id": "r${requestIndex}", "result": {"messages": [{"text": "`
          : `{"jsonrpc":"2.0","id":"r${requestIndex}","result":{"messages":[{"text":"`
      )
      let remaining = bodyChars
      while (remaining > 0) {
        const fragment = remaining >= chunk.length ? chunk : chunk.slice(0, remaining)
        child.stdout.write(fragment)
        remaining -= fragment.length
      }
      child.stdout.write('"}]}}\n')

      const result = await pending
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0]?.text.length).toBe(bodyChars)
    }

    expect(eventTypes(events)).toEqual(['gateway.ready'])
    expect(child.kill).not.toHaveBeenCalled()
    client.stop()
  })

  test('drains buffered stdout between child exit and stdio close', async () => {
    vi.useFakeTimers()
    const first = fakeChild()
    const second = fakeChild()
    spawnMock.mockReturnValueOnce(first.process).mockReturnValueOnce(second.process)
    const events: unknown[] = []
    const exits: string[] = []
    const client = new RawGatewayClient({
      log: new Log(null, 'debug'),
      onEvent: event => events.push(event),
      onExit: reason => exits.push(reason)
    })

    client.start()
    const pending = client.request<{ hydrated: boolean }>('session.resume', { session_id: 'session-1' })
    first.stdout.write('{"jsonrpc":"2.0","id":"r1","result":')
    first.process.emit('exit', 1, null)

    // New writes are fenced once the process is known dead, but data already
    // buffered in its stdout remains authoritative until the stdio close.
    await expect(client.request('session.status', {})).rejects.toThrow('gateway not running')
    first.stdout.write('{"hydrated":true}}\n')
    await expect(pending).resolves.toEqual({ hydrated: true })
    expect(exits).toEqual([])

    first.process.emit('close', 1, null)
    expect(exits).toEqual(['gateway exited (code=1 signal=null)'])
    expect(vi.getTimerCount()).toBe(0)

    client.start()
    // Bytes delivered after close belong to the old generation and cannot
    // poison the replacement's first frame.
    first.stdout.write('not-json\n')
    second.stdout.write(readyFrame())

    expect(eventTypes(events).filter(type => type === 'gateway.ready')).toHaveLength(1)
    expect(eventTypes(events)).not.toContain('gateway.protocol_error')
    client.stop()
  })

  test('dispatches a buffered event before exit recovery rejects pending work', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child.process)
    const order: string[] = []
    const client = new RawGatewayClient({
      log: new Log(null, 'debug'),
      onEvent: event => {
        if (eventTypes([event]).includes('message.complete')) order.push('event:message.complete')
      },
      onExit: () => order.push('exit')
    })

    client.start()
    const pending = client.request('prompt.submit', { session_id: 'ephemeral', text: 'keep me' })
    const settled = pending.catch(error => {
      order.push('reject')
      return error
    })
    child.stdout.write(
      '{"jsonrpc":"2.0","method":"event","params":{"type":"message.complete","session_id":"ephemeral",'
    )

    child.process.emit('exit', 1, null)
    child.stdout.write('"payload":{"text":"done"}}}\n')
    expect(order).toEqual(['event:message.complete'])

    child.process.emit('close', 1, null)
    const failure = await settled
    expect(failure).toBeInstanceOf(RawGatewayRequestError)
    expect(failure).toMatchObject({
      message: expect.stringContaining('exited'),
      reason: 'transport-down'
    })
    expect(order).toEqual(['event:message.complete', 'exit', 'reject'])
    expect(vi.getTimerCount()).toBe(0)
    client.stop()
  })

  test('an explicit JSON-RPC error is the only definite rpc-error failure', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child.process)
    const client = new RawGatewayClient({ log: new Log(null, 'debug'), onEvent: () => {} })

    client.start()
    child.stdout.write(readyFrame())
    const pending = rawRequestFailure(client.request('session.steer', { session_id: 's1', text: 'reject me' }))
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 'r1', error: { code: 4009, message: 'session busy' } })}\n`
    )

    await expect(pending).resolves.toMatchObject({ reason: 'rpc-error', message: 'session busy' })
    client.stop()
  })

  test('direct stdio close rejects a pending steer as transport-down', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child.process)
    const client = new RawGatewayClient({ log: new Log(null, 'debug'), onEvent: () => {} })

    client.start()
    child.stdout.write(readyFrame())
    const pending = rawRequestFailure(client.request('session.steer', { session_id: 's1', text: 'maybe admitted' }))
    child.process.emit('close', 1, null)

    await expect(pending).resolves.toMatchObject({
      reason: 'transport-down',
      message: expect.stringContaining('gateway closed')
    })
    client.stop()
  })

  test('stdin write callback failure rejects a pending steer as transport-down', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child.process)
    const client = new RawGatewayClient({ log: new Log(null, 'debug'), onEvent: () => {} })

    client.start()
    child.stdout.write(readyFrame())
    vi.spyOn(child.process.stdin, 'write').mockImplementation(((
      _frame: string,
      callback: (error?: Error | null) => void
    ) => {
      callback(new Error('write callback exploded'))
      return false
    }) as typeof child.process.stdin.write)
    const error = await rawRequestFailure(
      client.request('session.steer', { session_id: 's1', text: 'possibly written' })
    )

    expect(error.reason).toBe('transport-down')
    expect(error.message).toContain('gateway stdin write failed')
    expect(child.kill).toHaveBeenCalledTimes(1)
    client.stop()
  })

  test('cancels both generations watchdogs when a replacement becomes ready', () => {
    vi.useFakeTimers()
    const first = fakeChild()
    const second = fakeChild()
    spawnMock.mockReturnValueOnce(first.process).mockReturnValueOnce(second.process)
    const events: unknown[] = []
    const client = new RawGatewayClient({ log: new Log(null, 'debug'), onEvent: event => events.push(event) })

    client.start()
    first.process.emit('exit', 1, null)
    first.process.emit('close', 1, null)
    client.start()
    second.stdout.write(readyFrame())

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(eventTypes(events)).toEqual(['gateway.ready'])
    expect(eventTypes(events)).not.toContain('gateway.start_timeout')
    client.stop()
  })

  test('stop gracefully ends stdin, then kills only the captured child when EOF is ignored', () => {
    vi.useFakeTimers()
    const first = fakeChild({ ignoreEof: true, ignoreSignals: true })
    const second = fakeChild()
    spawnMock.mockReturnValueOnce(first.process).mockReturnValueOnce(second.process)
    const client = new RawGatewayClient({ log: new Log(null, 'debug'), onEvent: () => {} })

    client.start()
    first.stdout.write(readyFrame())
    client.stop()
    expect(first.process.stdin.writableEnded).toBe(true)
    expect(first.kill).not.toHaveBeenCalled()

    // Even if another generation is installed before the shutdown grace ends,
    // the fallback closes over the retired child and cannot kill its successor.
    client.start()
    second.stdout.write(readyFrame())
    vi.advanceTimersByTime(CHILD_CLOSE_GRACE_MS)
    expect(first.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(second.kill).not.toHaveBeenCalled()

    vi.advanceTimersByTime(CHILD_FORCE_KILL_GRACE_MS)
    expect(first.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(first.process.stdin.destroyed).toBe(true)
    expect(first.process.stdout.destroyed).toBe(true)
    expect(first.process.stderr.destroyed).toBe(true)
    expect(second.kill).not.toHaveBeenCalled()

    client.stop()
    second.process.emit('close', 0, null)
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each([
    { label: 'returns false', options: { ignoreEof: true, killResult: false } },
    { label: 'throws', options: { ignoreEof: true, killError: new Error('signal unavailable') } }
  ])('stop detaches every captured handle when SIGTERM $label', ({ options }) => {
    vi.useFakeTimers()
    const child = fakeChild(options)
    spawnMock.mockReturnValueOnce(child.process)
    const client = new RawGatewayClient({ log: new Log(null, 'debug'), onEvent: () => {} })

    client.start()
    child.stdout.write(readyFrame())
    client.stop()
    vi.advanceTimersByTime(CHILD_CLOSE_GRACE_MS)

    expect(child.process.stdin.destroyed).toBe(true)
    expect(child.process.stdout.destroyed).toBe(true)
    expect(child.process.stderr.destroyed).toBe(true)
    expect(child.unref).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('forces recovery when stdio never closes after child exit', async () => {
    vi.useFakeTimers()
    const first = fakeChild()
    const second = fakeChild()
    spawnMock.mockReturnValueOnce(first.process).mockReturnValueOnce(second.process)
    const exits: string[] = []
    const client = new RawGatewayClient({
      log: new Log(null, 'debug'),
      onEvent: () => {},
      onExit: reason => exits.push(reason)
    })

    client.start()
    first.stdout.write(readyFrame())
    const pending = client.request('session.status', {})
    const rejection = expect(pending).rejects.toThrow('stdio close timed out')

    first.process.emit('exit', 1, null)
    vi.advanceTimersByTime(CHILD_CLOSE_GRACE_MS)

    await rejection
    expect(exits).toEqual(['gateway exited (code=1 signal=null); stdio close timed out'])
    expect(first.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    client.start()
    second.stdout.write(readyFrame())
    // A late close from the retired generation is inert.
    first.process.emit('close', 1, null)
    expect(exits).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    client.stop()
  })

  test.each([
    {
      label: 'stdout',
      fail: (child: FakeChild) => child.stdout.emit('error', new Error('read exploded')),
      expected: 'gateway stdout failed: Error: read exploded'
    },
    {
      label: 'stdin',
      fail: (child: FakeChild) => child.process.stdin.emit('error', new Error('write exploded')),
      expected: 'gateway stdin failed: Error: write exploded'
    }
  ])('settles pending RPCs and recovers after an async $label stream error', async ({ fail, expected }) => {
    vi.useFakeTimers()
    const first = fakeChild()
    const second = fakeChild()
    spawnMock.mockReturnValueOnce(first.process).mockReturnValueOnce(second.process)
    const exits: string[] = []
    const client = new RawGatewayClient({
      log: new Log(null, 'debug'),
      onEvent: () => {},
      onExit: reason => exits.push(reason)
    })

    client.start()
    first.stdout.write(readyFrame())
    const pending = client.request('session.status', {})
    const rejection = expect(pending).rejects.toThrow(expected)
    fail(first)

    await rejection
    expect(exits).toEqual([expected])
    expect(first.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    client.start()
    second.stdout.write(readyFrame())
    fail(first)
    expect(exits).toEqual([expected])
    expect(second.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    client.stop()
  })

  test('startup timeout terminates the hung generation and permits recovery', async () => {
    vi.useFakeTimers()
    const first = fakeChild()
    const second = fakeChild()
    spawnMock.mockReturnValueOnce(first.process).mockReturnValueOnce(second.process)
    const events: unknown[] = []
    const exits: string[] = []
    const client = new RawGatewayClient({
      log: new Log(null, 'debug'),
      onEvent: event => events.push(event),
      onExit: reason => exits.push(reason)
    })

    client.start()
    const pending = client.request('session.status', {})
    const rejection = expect(pending).rejects.toThrow('gateway startup timeout')
    vi.advanceTimersByTime(STARTUP_TIMEOUT_MS)

    await rejection
    expect(events).toContainEqual({
      type: 'gateway.start_timeout',
      payload: { message: `no gateway.ready within ${STARTUP_TIMEOUT_MS}ms` }
    })
    expect(exits).toEqual([`gateway startup timeout: no gateway.ready within ${STARTUP_TIMEOUT_MS}ms`])
    expect(first.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    client.start()
    second.stdout.write(readyFrame())
    first.stdout.write(readyFrame())
    expect(eventTypes(events).filter(type => type === 'gateway.ready')).toHaveLength(1)
    expect(second.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    client.stop()
  })

  test('bounds chunked stderr without a newline, emits once, then resumes after the delimiter', () => {
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child.process)
    const events: unknown[] = []
    const client = new RawGatewayClient({ log: new Log(null, 'debug'), onEvent: event => events.push(event) })

    client.start()
    child.stdout.write(readyFrame())
    const chunk = 'e'.repeat(8 * 1024)
    const writesToOverflow = Math.floor(STDERR_LINE_MAX_BYTES / Buffer.byteLength(chunk, 'utf8')) + 1
    for (let index = 0; index < writesToOverflow; index++) child.stderr.write(chunk)
    child.stderr.write('still-discarded-without-a-newline')

    expect(stderrLines(events)).toEqual([
      `stderr line exceeded ${STDERR_LINE_MAX_BYTES} bytes; discarded until newline`
    ])
    expect(child.kill).not.toHaveBeenCalled()

    // The prefix before the first newline belongs to the oversized line and is
    // discarded. Framing resumes immediately for the next physical line.
    child.stderr.write('discarded-tail\nnext-diagnostic-line\n')
    expect(stderrLines(events)).toEqual([
      `stderr line exceeded ${STDERR_LINE_MAX_BYTES} bytes; discarded until newline`,
      'next-diagnostic-line'
    ])
    client.stop()
  })

  test('oversized chunked stdout frame rejects pending RPCs and recycles only its generation', async () => {
    const first = fakeChild()
    const second = fakeChild()
    spawnMock.mockReturnValueOnce(first.process).mockReturnValueOnce(second.process)
    const events: unknown[] = []
    const exits: string[] = []
    const client = new RawGatewayClient({
      log: new Log(null, 'debug'),
      onEvent: event => events.push(event),
      onExit: reason => exits.push(reason)
    })

    client.start()
    const pending = client.request('session.resume', { session_id: 'large' })
    const rejection = expect(pending).rejects.toThrow('gateway protocol error')
    const chunk = 'x'.repeat(1024 * 1024)
    const writesToOverflow = Math.floor(STDOUT_FRAME_MAX_BYTES / Buffer.byteLength(chunk, 'utf8')) + 1
    for (let index = 0; index < writesToOverflow; index++) first.stdout.write(chunk)

    await rejection
    expect(eventTypes(events).filter(type => type === 'gateway.protocol_error')).toHaveLength(1)
    expect(events).toContainEqual({
      type: 'gateway.protocol_error',
      payload: { preview: `stdout JSON-RPC frame exceeded ${STDOUT_FRAME_MAX_BYTES} bytes without newline` }
    })
    expect(exits).toEqual([
      `gateway protocol error: stdout JSON-RPC frame exceeded ${STDOUT_FRAME_MAX_BYTES} bytes without newline`
    ])
    expect(first.kill).toHaveBeenCalledTimes(1)

    // finish() makes a replacement legal immediately. Late bytes from the
    // oversized generation cannot poison or terminate the replacement.
    client.start()
    first.stdout.write(`${readyFrame()}late-old-generation\n`)
    second.stdout.write(readyFrame())
    expect(eventTypes(events).filter(type => type === 'gateway.ready')).toHaveLength(1)
    expect(eventTypes(events).filter(type => type === 'gateway.protocol_error')).toHaveLength(1)
    expect(second.kill).not.toHaveBeenCalled()
    client.stop()
  })
})
