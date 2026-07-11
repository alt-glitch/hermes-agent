import { describe, expect, test } from 'vitest'

import {
  boundTransportLogLine,
  formatRpcErrorLog,
  notifyTransportExit,
  TRANSPORT_LOG_LINE_LIMIT,
  TRANSPORT_LOG_RING_LIMIT,
  TransportLogRing
} from '../boundary/gateway/client.ts'

describe('bounded gateway transport log', () => {
  test('oversized lines carry an explicit truncation marker at the hard ceiling', () => {
    const line = boundTransportLogLine('x'.repeat(TRANSPORT_LOG_LINE_LIMIT + 100))
    expect(line).toHaveLength(TRANSPORT_LOG_LINE_LIMIT)
    expect(line).toMatch(/… \[truncated\]$/)
  })

  test('retains only the newest 200 lines and returns defensive tail copies', () => {
    const ring = new TransportLogRing()
    for (let index = 0; index < TRANSPORT_LOG_RING_LIMIT + 5; index++) ring.push(`line-${index}`)

    const all = ring.tail(10_000)
    expect(all).toHaveLength(TRANSPORT_LOG_RING_LIMIT)
    expect(all[0]).toBe('line-5')
    expect(all.at(-1)).toBe(`line-${TRANSPORT_LOG_RING_LIMIT + 4}`)
    all.pop()
    expect(ring.tail(1)).toEqual([`line-${TRANSPORT_LOG_RING_LIMIT + 4}`])
  })

  test('drops blank lines and clamps non-positive tails to one useful line', () => {
    const ring = new TransportLogRing()
    ring.push('   ')
    ring.push('first')
    ring.push('second')
    expect(ring.tail(0)).toEqual(['second'])
  })

  test('formats JSON-RPC error responses with method and code', () => {
    expect(formatRpcErrorLog('session.resume', { code: 4006, message: 'session not found' })).toBe(
      '[rpc] session.resume failed (4006): session not found'
    )
    expect(formatRpcErrorLog('commands.catalog', {})).toBe('[rpc] commands.catalog failed: rpc error')
    expect(formatRpcErrorLog('commands.catalog', { code: 'bad', message: 42 })).toBe(
      '[rpc] commands.catalog failed: rpc error'
    )
  })

  test('publishes transport-down provenance before pending RPCs reject', () => {
    const order: string[] = []
    notifyTransportExit(
      'child exited',
      reason => order.push(`exit:${reason}`),
      reason => order.push(`reject:${reason}`)
    )
    expect(order).toEqual(['exit:child exited', 'reject:child exited'])
  })

  test('pending RPCs still reject when an exit observer throws', () => {
    const rejected: string[] = []
    expect(() =>
      notifyTransportExit(
        'child exited',
        () => {
          throw new Error('observer failed')
        },
        reason => rejected.push(reason)
      )
    ).toThrow('observer failed')
    expect(rejected).toEqual(['child exited'])
  })
})
