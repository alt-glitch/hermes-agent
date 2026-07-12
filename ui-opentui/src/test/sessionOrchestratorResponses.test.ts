import { describe, expect, test } from 'vitest'

import {
  decodeSessionActivateResponse,
  decodeSessionActiveListResponse,
  decodeSessionBranchResponse,
  decodeSessionCloseResponse,
  decodeSessionDeleteResponse,
  decodeSessionListResponse,
  decodeSessionResumeResponse
} from '../boundary/schema/SessionOrchestratorResponses.ts'

describe('session-orchestrator RPC Effect boundaries', () => {
  test('decodes active sessions and accepts additive fields', () => {
    expect(
      decodeSessionActiveListResponse({
        revision: 2,
        sessions: [
          {
            current: true,
            id: 'live-1',
            message_count: 4,
            next_protocol_field: { safe: true },
            status: 'streaming',
            title: 'Parity work'
          }
        ]
      })
    ).toMatchObject({
      revision: 2,
      sessions: [
        {
          current: true,
          id: 'live-1',
          message_count: 4,
          next_protocol_field: { safe: true },
          status: 'streaming',
          title: 'Parity work'
        }
      ]
    })
  })

  test('rejects malformed active lists and blank live ids', () => {
    expect(decodeSessionActiveListResponse({ sessions: {} })).toBeUndefined()
    expect(decodeSessionActiveListResponse({ sessions: [{ id: 'live-1', status: 'paused' }] })).toBeUndefined()
    expect(decodeSessionActiveListResponse({ sessions: [{ id: '   ', status: 'idle' }] })).toBeUndefined()
    expect(decodeSessionActiveListResponse({ sessions: [{ id: 'live-1', status: 'idle', title: 4 }] })).toBeUndefined()
  })

  test('decodes activate and resume live snapshots', () => {
    const snapshot = {
      inflight: { assistant: 'partial', streaming: true, user: 'continue' },
      info: { cwd: '/tmp/project', model: 'test/model' },
      message_count: 3,
      messages: [{ role: 'user', text: 'hello' }, 'future-message-shape'],
      running: true,
      session_id: 'live-1',
      session_key: 'db-1',
      started_at: 123.5,
      status: 'working',
      transport_revision: 3
    }

    expect(decodeSessionActivateResponse(snapshot)).toMatchObject(snapshot)
    expect(decodeSessionResumeResponse({ ...snapshot, inflight: null, resumed: 'db-1' })).toMatchObject({
      ...snapshot,
      inflight: null,
      resumed: 'db-1'
    })
  })

  test('rejects malformed live snapshot arrays and field types', () => {
    expect(decodeSessionActivateResponse({ messages: {}, session_id: 'live-1' })).toBeUndefined()
    expect(decodeSessionActivateResponse({ messages: [], running: 'yes', session_id: 'live-1' })).toBeUndefined()
    expect(
      decodeSessionResumeResponse({ inflight: { streaming: 'yes' }, messages: [], session_id: 'live-1' })
    ).toBeUndefined()
    expect(decodeSessionResumeResponse({ info: [], messages: [], session_id: 'live-1' })).toBeUndefined()
    expect(decodeSessionResumeResponse({ messages: [], session_id: 1 })).toBeUndefined()
  })

  test('validates branch identity fields', () => {
    expect(
      decodeSessionBranchResponse({
        parent: 'parent-key',
        session_id: 'child-live',
        session_key: 'child-key',
        title: 'Fork'
      })
    ).toEqual({
      parent: 'parent-key',
      session_id: 'child-live',
      session_key: 'child-key',
      title: 'Fork'
    })
    expect(
      decodeSessionBranchResponse({ parent: 'parent-key', session_id: ' ', session_key: 'child-key', title: 'Fork' })
    ).toBeUndefined()
    expect(decodeSessionBranchResponse({ session_id: 'child-live', title: 'Fork' })).toEqual({
      session_id: 'child-live',
      title: 'Fork'
    })
  })

  test('decodes close, delete, and stored-session list responses', () => {
    expect(decodeSessionCloseResponse({ closed: true, reason: 'requested' })).toMatchObject({
      closed: true,
      reason: 'requested'
    })
    expect(decodeSessionCloseResponse({ ok: true })).toEqual({ ok: true })
    expect(decodeSessionDeleteResponse({ deleted: 'db-1', revision: 2 })).toMatchObject({
      deleted: 'db-1',
      revision: 2
    })
    expect(
      decodeSessionListResponse({
        sessions: [
          {
            id: 'db-1',
            message_count: 8,
            preview: 'last message',
            source: 'tui',
            started_at: 100,
            title: 'Stored session'
          }
        ]
      })
    ).toMatchObject({ sessions: [{ id: 'db-1', message_count: 8, title: 'Stored session' }] })
  })

  test('rejects malformed close, delete, and stored-session list fields', () => {
    expect(decodeSessionCloseResponse({})).toBeUndefined()
    expect(decodeSessionCloseResponse({ closed: 'yes' })).toBeUndefined()
    expect(decodeSessionDeleteResponse({ deleted: 1 })).toBeUndefined()
    expect(decodeSessionListResponse({ sessions: 'all' })).toBeUndefined()
    expect(
      decodeSessionListResponse({
        sessions: [{ id: 'db-1', message_count: '8', preview: '', started_at: 100, title: 'Stored session' }]
      })
    ).toBeUndefined()
  })
})
