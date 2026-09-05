import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { decodeSessionInfoPatch } from '../boundary/schema/SessionInfo.ts'

describe('session telemetry decoding', () => {
  test.each([undefined, null, '42', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, {}, []])(
    'omits malformed telemetry without dropping valid session fields: %j',
    value => {
      const decoded = decodeSessionInfoPatch({
        model: 'model',
        avg_tps: value,
        usage: { cache_hit_pct: value, avg_latency_s: 2, context_used: 100 }
      })
      expect(Option.getOrUndefined(decoded)).toEqual({
        model: 'model',
        usage: { avg_latency_s: 2, context_used: 100 }
      })
    }
  )

  test.each([0, -2, 1.25])('preserves finite telemetry without changing its value: %s', value => {
    const decoded = decodeSessionInfoPatch({
      avg_tps: value,
      usage: { avg_latency_s: value, cache_hit_pct: value }
    })
    expect(Option.getOrUndefined(decoded)).toEqual({
      avg_tps: value,
      usage: { avg_latency_s: value, cache_hit_pct: value }
    })
  })

  test('does not fabricate telemetry for an ordinary partial update', () => {
    expect(Option.getOrUndefined(decodeSessionInfoPatch({ model: 'model', usage: {} }))).toEqual({
      model: 'model',
      usage: {}
    })
  })
})
