import { describe, expect, test } from 'vitest'

import { decodeSessionCompressResponse } from '../boundary/compression.ts'

describe('session.compress response decoder', () => {
  test('decodes the exact lock-held feedback envelope', () => {
    const response = {
      compressed: false,
      lock_held: true,
      message: 'Compression already in progress for this session. Please wait for it to finish.'
    }

    expect(decodeSessionCompressResponse(response)).toEqual(response)
  })

  test.each([
    { compressed: 'false', lock_held: true, message: 'wait' },
    { compressed: false, lock_held: 1, message: 'wait' },
    { compressed: false, lock_held: true, message: false }
  ])('rejects malformed lock-held fields: %o', response => {
    expect(decodeSessionCompressResponse(response)).toBeUndefined()
  })

  test('preserves the existing successful snapshot envelope', () => {
    const response = {
      messages: [{ role: 'assistant', text: 'compressed summary' }],
      removed: 5,
      status: 'compressed',
      usage: { total: 100 }
    }

    expect(decodeSessionCompressResponse(response)).toEqual(response)
  })
})
