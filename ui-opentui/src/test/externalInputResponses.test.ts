import { describe, expect, test } from 'vitest'

import { openInEditor } from '../boundary/externalInput.ts'
import {
  attachedImageNotice,
  decodeImageAttachResponse,
  decodeSetupStatusResponse
} from '../boundary/schema/ExternalInputResponses.ts'

describe('external input RPC boundaries', () => {
  test('decodes image metadata and formats the exact Ink notice', () => {
    const response = decodeImageAttachResponse({
      attached: true,
      height: 1080,
      name: 'screen.png',
      remainder: 'describe this',
      token_estimate: 1275,
      width: 1920
    })

    expect(response?.remainder).toBe('describe this')
    expect(attachedImageNotice(response)).toBe('📎 Attached image: screen.png · 1920x1080 · ~1.3k tok')
    expect(attachedImageNotice({})).toBe('📎 Attached image')
  })

  test('rejects malformed image/setup responses without trusting partial values', () => {
    expect(decodeImageAttachResponse({ remainder: 42 })).toBeUndefined()
    expect(decodeSetupStatusResponse({ provider_configured: 'yes' })).toBeUndefined()
    expect(decodeSetupStatusResponse({ provider_configured: false })).toEqual({ provider_configured: false })
  })

  test('surfaces editor spawn failures after restoring the renderer', async () => {
    let suspended = false
    const suspend = (run: () => void): void => {
      suspended = true
      try {
        run()
      } finally {
        suspended = false
      }
    }

    await expect(openInEditor('draft', suspend, '.md', ['/definitely/missing/hermes-editor'])).rejects.toThrow()
    expect(suspended).toBe(false)
  })
})
