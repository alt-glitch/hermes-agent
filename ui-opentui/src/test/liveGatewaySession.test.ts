import { describe, expect, test } from 'vitest'

import { RawGatewayRequestError } from '../boundary/gateway/client.ts'
import {
  gatewayErrorFromRawFailure,
  gatewayEventRequiresImmediateFlush,
  planGatewayEventFlush,
  trackedSessionIdAfterRequest
} from '../boundary/gateway/liveGateway.ts'

describe('live gateway session tracking', () => {
  test('create/resume adopt the returned live id', () => {
    expect(trackedSessionIdAfterRequest(undefined, 'session.create', {}, { session_id: 'new-1' })).toBe('new-1')
    expect(trackedSessionIdAfterRequest('old-1', 'session.resume', {}, { messages: [], session_id: 'live-2' })).toBe(
      'live-2'
    )
    expect(
      trackedSessionIdAfterRequest('old-1', 'session.resume', {}, { messages: [], session_id: '  live-3  ' })
    ).toBe('live-3')
    expect(trackedSessionIdAfterRequest('old-1', 'session.activate', {}, { messages: [], session_id: 'live-4' })).toBe(
      'live-4'
    )
    expect(trackedSessionIdAfterRequest('live-4', 'session.branch', {}, { session_id: 'live-5' })).toBe('live-5')
  })

  test('a successful matching close clears the routing id, including closed:false', () => {
    expect(
      trackedSessionIdAfterRequest('live-1', 'session.close', { session_id: 'live-1' }, { closed: false })
    ).toBeUndefined()
  })

  test('closing another live session does not disturb the active routing id', () => {
    expect(trackedSessionIdAfterRequest('live-2', 'session.close', { session_id: 'live-1' }, { closed: true })).toBe(
      'live-2'
    )
  })

  test('malformed create/resume responses never replace a valid id', () => {
    expect(trackedSessionIdAfterRequest('live-1', 'session.create', {}, {})).toBe('live-1')
    expect(trackedSessionIdAfterRequest('live-1', 'session.create', {}, { info: [], session_id: 'poison' })).toBe(
      'live-1'
    )
    expect(trackedSessionIdAfterRequest('live-1', 'session.resume', {}, { messages: [], session_id: '  ' })).toBe(
      'live-1'
    )
    expect(trackedSessionIdAfterRequest('live-1', 'session.activate', {}, { session_id: 'poison' })).toBe('live-1')
  })

  test('raw failure provenance maps without string heuristics', () => {
    expect(
      gatewayErrorFromRawFailure('session.steer', new RawGatewayRequestError('rpc-error', 'server busy')).reason
    ).toBe('rpc-error')
    expect(gatewayErrorFromRawFailure('session.steer', new RawGatewayRequestError('timeout', 'anything')).reason).toBe(
      'timeout'
    )
    expect(
      gatewayErrorFromRawFailure('session.steer', new RawGatewayRequestError('transport-down', 'gateway closed')).reason
    ).toBe('transport-down')
    expect(gatewayErrorFromRawFailure('session.steer', new Error('unclassified boundary failure')).reason).toBe(
      'transport-down'
    )
  })

  test('delivery lifecycle boundaries cannot remain behind the repaint debounce', () => {
    expect(gatewayEventRequiresImmediateFlush({ type: 'message.start' })).toBe(true)
    expect(gatewayEventRequiresImmediateFlush({ type: 'message.complete' })).toBe(true)
    expect(gatewayEventRequiresImmediateFlush({ type: 'error' })).toBe(true)
    expect(gatewayEventRequiresImmediateFlush({ type: 'session.info', payload: { running: true } })).toBe(true)
    expect(gatewayEventRequiresImmediateFlush({ type: 'gateway.ready' })).toBe(true)
    expect(gatewayEventRequiresImmediateFlush({ type: 'gateway.exited' })).toBe(true)
    expect(gatewayEventRequiresImmediateFlush({ type: 'message.delta', payload: { text: 'coalesce me' } })).toBe(false)

    // A prior flush at t=100 would normally hold repaint traffic until t=116.
    // Start must flush the already queued traffic synchronously so a later
    // interrupt response continuation observes turnInFlight=true.
    expect(planGatewayEventFlush({ type: 'message.start' }, 105, 100, true)).toBe('flush-now')
    expect(planGatewayEventFlush({ type: 'message.delta', payload: { text: 'later' } }, 105, 100, true)).toBe('wait')
  })
})
