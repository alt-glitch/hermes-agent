import { describe, expect, test, vi } from 'vitest'

import { presentBillingVerification } from '../logic/billingVerification.ts'

describe('billing step-up verification event', () => {
  test('prints the safe URL/code and best-effort opens it', () => {
    const lines: string[] = []
    const openUrl = vi.fn(() => true)
    expect(
      presentBillingVerification(
        { user_code: 'WXYZ-9999', verification_url: 'https://portal.example/device?code=WXYZ' },
        { openUrl, pushSystem: line => lines.push(line) }
      )
    ).toBe(true)
    expect(lines.join('\n')).toContain('https://portal.example/device?code=WXYZ')
    expect(lines.join('\n')).toContain('WXYZ-9999')
    expect(openUrl).toHaveBeenCalledWith('https://portal.example/device?code=WXYZ')
  })

  test.each(['', 'not a url', 'javascript:alert(1)', 'file:///tmp/secret'])('rejects unsafe URL %j', url => {
    const lines: string[] = []
    const openUrl = vi.fn(() => true)
    expect(
      presentBillingVerification({ verification_url: url }, { openUrl, pushSystem: line => lines.push(line) })
    ).toBe(false)
    expect(lines).toEqual([])
    expect(openUrl).not.toHaveBeenCalled()
  })
})
