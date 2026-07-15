import { describe, expect, test } from 'vitest'

import { approvalChoices, approvalPolicy, secureApprovalChoice } from '../logic/approval.ts'
import { promptResponseAcknowledged } from '../boundary/promptResponses.ts'
import { approvalOptions } from '../view/prompts/approvalPrompt.tsx'

describe('blocking prompt acknowledgement boundary', () => {
  test('accepts only exact f7 success payloads', () => {
    expect(promptResponseAcknowledged('clarify.respond', { status: 'ok' })).toBe(true)
    expect(promptResponseAcknowledged('sudo.respond', { status: 'ok' })).toBe(true)
    expect(promptResponseAcknowledged('secret.respond', { status: 'ok' })).toBe(true)
    expect(promptResponseAcknowledged('approval.respond', { resolved: 1 })).toBe(true)
    expect(promptResponseAcknowledged('approval.respond', { resolved: 0 })).toBe(false)
    expect(promptResponseAcknowledged('approval.respond', { resolved: true })).toBe(false)
    expect(promptResponseAcknowledged('clarify.respond', { ok: true })).toBe(false)
    expect(promptResponseAcknowledged('secret.respond', {})).toBe(false)
  })

  test('treats late sensitive-prompt expiry responses as terminal acknowledgements', () => {
    expect(promptResponseAcknowledged('sudo.respond', { status: 'expired' })).toBe(true)
    expect(promptResponseAcknowledged('secret.respond', { status: 'expired' })).toBe(true)
    expect(promptResponseAcknowledged('clarify.respond', { status: 'expired' })).toBe(false)
  })
})

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

  test('smart-denied requests offer exactly once and deny', () => {
    const policy = approvalPolicy({ allowPermanent: true, smartDenied: true })
    expect(approvalChoices(policy)).toEqual(['once', 'deny'])
    expect(approvalOptions(policy).map(option => option.value)).toEqual(['once', 'deny'])

    const stalePolicy = approvalPolicy({
      choices: ['once', 'session', 'always', 'deny'],
      smartDenied: true
    })
    expect(approvalChoices(stalePolicy)).toEqual(['once', 'deny'])
  })

  test('explicit gateway choices are authoritative and invalid selections fail closed', () => {
    const policy = approvalPolicy({ choices: ['once', 'bogus', 'deny'] })
    expect(approvalChoices(policy)).toEqual(['once', 'deny'])
    expect(approvalOptions(policy).map(option => option.value)).toEqual(['once', 'deny'])
    expect(secureApprovalChoice('session', policy)).toBe('deny')
    expect(secureApprovalChoice('always', policy)).toBe('deny')
    expect(secureApprovalChoice('once', policy)).toBe('once')
  })
})
