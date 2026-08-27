/**
 * Billing wall copy + recovery-action logic (port of Ink billingDialog.ts +
 * the confirm's onConfirm routing, upstream 9c274db89ff). Pure — no gateway,
 * no store: the wording and the one-recovery routing are pinned here; the
 * reducer/order behavior lives in store.test.ts.
 */
import { describe, expect, test, vi } from 'vitest'

import type { BillingBlockDecoded } from '../boundary/schema/GatewayEvent.ts'
import { billingWallAction, billingWallCopy, runBillingWallAction } from '../logic/billingWall.ts'

function makeBlock(overrides: Partial<BillingBlockDecoded> = {}): BillingBlockDecoded {
  return {
    billing_url: 'https://openrouter.ai/settings/credits',
    is_nous: false,
    message: 'out of credits',
    model: 'x',
    provider: 'openrouter',
    provider_label: 'OpenRouter',
    ...overrides
  }
}

describe('billingWallCopy', () => {
  test('routes Nous to the /topup flow', () => {
    const copy = billingWallCopy(makeBlock({ is_nous: true, provider: 'nous', provider_label: 'Nous Portal' }))
    expect(copy.title).toContain('Nous')
    expect(copy.confirmLabel).toBe('Top up')
    expect(copy.cancelLabel).toBe('Dismiss')
  })

  test('offers to open a third-party provider billing page', () => {
    const copy = billingWallCopy(makeBlock())
    expect(copy.title).toContain('OpenRouter')
    expect(copy.confirmLabel).toBe('Open billing page')
    expect(copy.detail).toBe('OpenRouter reports your credits or billing are exhausted.')
  })

  test('falls back to switching providers when there is no URL', () => {
    const copy = billingWallCopy(makeBlock({ billing_url: null, provider_label: 'DeepSeek' }))
    expect(copy.title).toContain('DeepSeek')
    expect(copy.confirmLabel).toBe('Switch provider')
  })

  test('degrades a missing provider label to readable copy', () => {
    const { provider_label: _omitted, ...bare } = makeBlock({ billing_url: null })
    const copy = billingWallCopy(bare)
    expect(copy.title).toBe('Out of credits · your provider')
    expect(copy.detail).toContain('your provider reports')
  })
})

describe('billingWallAction', () => {
  test('Nous wins over a present URL (the in-app flow is the managed route)', () => {
    expect(billingWallAction(makeBlock({ is_nous: true }))).toEqual({ command: '/topup', kind: 'slash' })
  })

  test('a safe third-party URL deep-links', () => {
    expect(billingWallAction(makeBlock())).toEqual({
      kind: 'url',
      url: 'https://openrouter.ai/settings/credits'
    })
  })

  test('no URL → /model recovery', () => {
    expect(billingWallAction(makeBlock({ billing_url: null }))).toEqual({ command: '/model', kind: 'slash' })
  })

  test('an unsafe URL is rejected by the safe-URL boundary and degrades to /model', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', '']) {
      expect(billingWallAction(makeBlock({ billing_url: url }))).toEqual({ command: '/model', kind: 'slash' })
    }
  })
})

describe('runBillingWallAction', () => {
  test('slash actions ride the registered slash ladder', () => {
    const submitSlash = vi.fn()
    const pushSystem = vi.fn()
    runBillingWallAction({ command: '/topup', kind: 'slash' }, { pushSystem, submitSlash })
    expect(submitSlash).toHaveBeenCalledWith('/topup')
    expect(pushSystem).not.toHaveBeenCalled()
  })

  test('slash actions degrade to an honest transcript hint without a host', () => {
    const pushSystem = vi.fn()
    runBillingWallAction({ command: '/model', kind: 'slash' }, { pushSystem })
    expect(pushSystem).toHaveBeenCalledWith('Run /model to continue.')
  })

  test('url actions open via the safe opener and stay silent on success', () => {
    const openUrl = vi.fn(() => true)
    const pushSystem = vi.fn()
    runBillingWallAction({ kind: 'url', url: 'https://openrouter.ai/settings/credits' }, { openUrl, pushSystem })
    expect(openUrl).toHaveBeenCalledWith('https://openrouter.ai/settings/credits')
    expect(pushSystem).not.toHaveBeenCalled()
  })

  test('url actions leave a copyable URL when the browser cannot open (headless)', () => {
    const openUrl = vi.fn(() => false)
    const pushSystem = vi.fn()
    runBillingWallAction({ kind: 'url', url: 'https://openrouter.ai/settings/credits' }, { openUrl, pushSystem })
    expect(pushSystem).toHaveBeenCalledWith('Could not open browser — visit https://openrouter.ai/settings/credits')
  })
})
