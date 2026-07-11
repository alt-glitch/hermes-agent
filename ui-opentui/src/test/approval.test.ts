import { describe, expect, test } from 'vitest'

import { approvalChoices, secureApprovalChoice } from '../logic/approval.ts'
import { approvalOptions } from '../view/prompts/approvalPrompt.tsx'

describe('approval permanence guard', () => {
  test('removes always from the visible choices when permanence is forbidden', () => {
    expect(approvalChoices(false)).toEqual(['once', 'session', 'deny'])
    expect(approvalOptions(false).map(option => option.value)).toEqual(['once', 'session', 'deny'])
  })

  test('fails closed if always or an unknown choice reaches the response seam', () => {
    expect(secureApprovalChoice('always', false)).toBe('deny')
    expect(secureApprovalChoice('unexpected', true)).toBe('deny')
  })

  test('keeps all valid choices when the gateway allows permanence', () => {
    expect(approvalChoices(true)).toEqual(['once', 'session', 'always', 'deny'])
    expect(secureApprovalChoice('always', true)).toBe('always')
    expect(secureApprovalChoice('session', false)).toBe('session')
  })
})
