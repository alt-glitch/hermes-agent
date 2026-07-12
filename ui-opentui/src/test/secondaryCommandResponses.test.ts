import { describe, expect, test } from 'vitest'
import {
  decodeCreditsViewResponse,
  decodePersonalityResponse,
  decodeRollbackDiffResponse,
  decodeRollbackListResponse,
  decodeRollbackRestoreResponse,
  decodeSessionUsageResponse
} from '../boundary/schema/SecondaryCommandResponses.ts'

describe('secondary command Effect boundaries', () => {
  test('decodes authoritative account, personality, and rollback payloads', () => {
    expect(decodeSessionUsageResponse({ calls: 1, input: 2, output: 3, total: 5 })).toMatchObject({
      calls: 1,
      total: 5
    })
    expect(
      decodeCreditsViewResponse({
        logged_in: true,
        balance_lines: ['$4'],
        identity_line: null,
        topup_url: null,
        depleted: false
      })?.logged_in
    ).toBe(true)
    expect(
      decodePersonalityResponse({ value: 'friendly', history_reset: true, info: { model: 'm' } })?.history_reset
    ).toBe(true)
    expect(
      decodeRollbackListResponse({ enabled: true, checkpoints: [{ hash: 'abc', timestamp: 'now', message: 'turn' }] })
        ?.checkpoints
    ).toHaveLength(1)
    expect(decodeRollbackDiffResponse({ stat: '1 file', diff: '+x' })?.diff).toBe('+x')
    expect(decodeRollbackRestoreResponse({ success: true, history_removed: 2 })?.success).toBe(true)
  })

  test('rejects malformed contract fields', () => {
    expect(decodeSessionUsageResponse({ calls: '1' })).toBeUndefined()
    expect(decodeCreditsViewResponse({ logged_in: 'yes', balance_lines: [] })).toBeUndefined()
    expect(decodePersonalityResponse({ value: 2 })).toBeUndefined()
    expect(decodeRollbackListResponse({ enabled: true, checkpoints: [{ hash: 1 }] })).toBeUndefined()
    expect(decodeRollbackDiffResponse({ diff: 1 })).toBeUndefined()
    expect(decodeRollbackRestoreResponse({ success: 'yes' })).toBeUndefined()
  })
})
