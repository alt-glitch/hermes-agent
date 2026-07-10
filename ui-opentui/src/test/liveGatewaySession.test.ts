import { describe, expect, test } from 'vitest'

import { trackedSessionIdAfterRequest } from '../boundary/gateway/liveGateway.ts'

describe('live gateway session tracking', () => {
  test('create/resume adopt the returned live id', () => {
    expect(trackedSessionIdAfterRequest(undefined, 'session.create', {}, { session_id: 'new-1' })).toBe('new-1')
    expect(trackedSessionIdAfterRequest('old-1', 'session.resume', {}, { session_id: 'live-2' })).toBe('live-2')
    expect(trackedSessionIdAfterRequest('old-1', 'session.resume', {}, { session_id: '  live-3  ' })).toBe('live-3')
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
    expect(trackedSessionIdAfterRequest('live-1', 'session.resume', {}, { session_id: '  ' })).toBe('live-1')
  })
})
