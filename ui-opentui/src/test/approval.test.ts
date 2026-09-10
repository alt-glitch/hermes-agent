import { describe, expect, test } from 'vitest'

import { approvalChoices, approvalPolicy, secureApprovalChoice } from '../logic/approval.ts'
import {
  classifyPromptResponse,
  decodeApprovalPendingResponse,
  reconcilePendingApprovalSnapshot
} from '../boundary/promptResponses.ts'
import { approvalOptions } from '../view/prompts/approvalPrompt.tsx'
import { createSessionStore } from '../logic/store.ts'

describe('blocking prompt response boundary', () => {
  test('distinguishes accepted, terminal, and transport-uncertain payloads', () => {
    expect(classifyPromptResponse('clarify.respond', { status: 'ok' })).toEqual({ kind: 'accepted' })
    expect(classifyPromptResponse('sudo.respond', { status: 'ok' })).toEqual({ kind: 'accepted' })
    expect(classifyPromptResponse('secret.respond', { status: 'ok' })).toEqual({ kind: 'accepted' })
    expect(classifyPromptResponse('vault.unlock.respond', { status: 'ok' })).toEqual({ kind: 'accepted' })
    expect(classifyPromptResponse('approval.respond', { resolved: 1 })).toEqual({ kind: 'accepted' })
    expect(classifyPromptResponse('approval.respond', { resolved: 0 })).toEqual({
      kind: 'terminal',
      reason: 'obsolete'
    })
    expect(classifyPromptResponse('approval.respond', { resolved: true }).kind).toBe('uncertain')
    expect(classifyPromptResponse('approval.respond', { resolved: -1 }).kind).toBe('uncertain')
    expect(classifyPromptResponse('clarify.respond', { ok: true }).kind).toBe('uncertain')
    expect(classifyPromptResponse('secret.respond', {}).kind).toBe('uncertain')
  })

  test('treats every exact late expiry response as terminal without accepting it', () => {
    for (const method of ['clarify.respond', 'sudo.respond', 'secret.respond', 'vault.unlock.respond'] as const) {
      expect(classifyPromptResponse(method, { status: 'expired' })).toEqual({ kind: 'terminal', reason: 'expired' })
    }
  })

  test('decodes request-specific pending approval snapshots and rejects malformed entries', () => {
    const approval = {
      command: 'rm -rf /tmp/x',
      description: 'delete temp',
      request_id: 'approval-1'
    }
    expect(decodeApprovalPendingResponse({ approvals: [approval] })).toEqual([approval])
    expect(decodeApprovalPendingResponse({ approvals: [{ ...approval, request_id: '' }] })).toBeUndefined()
    expect(decodeApprovalPendingResponse({ approvals: [{ command: 'rm', description: 'missing id' }] })).toBeUndefined()
    expect(decodeApprovalPendingResponse({ resolved: 1 })).toBeUndefined()
  })

  test('ignores a delayed reconnect snapshot after a replacement prompt arrives', async () => {
    const store = createSessionStore()
    store.adoptFreshSession('live-1')
    let resolveSnapshot!: (value: unknown) => void
    const snapshot = new Promise<unknown>(resolve => (resolveSnapshot = resolve))
    const reconciliation = reconcilePendingApprovalSnapshot(() => snapshot, store, 'live-1')

    store.apply({ type: 'clarify.request', payload: { question: 'new prompt', request_id: 'clarify-new' } })
    resolveSnapshot({ approvals: [] })

    await expect(reconciliation).resolves.toBe('ignored')
    expect(store.state.prompt).toMatchObject({ kind: 'clarify', requestId: 'clarify-new' })
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
