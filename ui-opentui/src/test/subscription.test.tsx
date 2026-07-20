import { describe, expect, test, vi } from 'vitest'

import type { SubscriptionCtx, SubscriptionOverlayState, SubscriptionStateResponse } from '../boundary/billing.ts'
import { createSessionStore } from '../logic/store.ts'
import { SubscriptionOverlay, subscriptionStatusLine } from '../view/overlays/subscription.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame, renderProbe } from './lib/render.ts'

const state = (over: Partial<SubscriptionStateResponse> = {}): SubscriptionStateResponse => ({
  ok: true,
  logged_in: true,
  is_admin: true,
  can_change_plan: true,
  org_name: 'Nous',
  org_id: 'org-1',
  role: 'OWNER',
  context: 'personal',
  current: {
    tier_id: 'plus',
    tier_name: 'Plus',
    monthly_credits: '2000',
    credits_remaining: '1400',
    cycle_ends_at: '2026-08-01T00:00:00Z',
    pending_downgrade_tier_name: null,
    pending_downgrade_at: null,
    pending_downgrade_display: null,
    cancel_at_period_end: false,
    cancellation_effective_at: null,
    cancellation_effective_display: null
  },
  tiers: [
    {
      tier_id: 'free',
      name: 'Free',
      tier_order: 0,
      dollars_per_month_display: '$0',
      monthly_credits: null,
      is_current: false,
      is_enabled: true
    },
    {
      tier_id: 'plus',
      name: 'Plus',
      tier_order: 1,
      dollars_per_month_display: '$20',
      monthly_credits: '2000',
      is_current: true,
      is_enabled: true
    },
    {
      tier_id: 'ultra',
      name: 'Ultra',
      tier_order: 2,
      dollars_per_month_display: '$40',
      monthly_credits: '5000',
      is_current: false,
      is_enabled: true
    }
  ],
  portal_url: 'https://portal.example/billing',
  usage: {
    available: true,
    status: 'healthy',
    plan_name: 'Plus',
    renews_display: 'Aug 1',
    total_spendable_display: '$14.00'
  },
  ...over
})

const ctx: SubscriptionCtx = {
  fetchCard: async () => null,
  openManageLink: async () => true,
  openPortal: () => {},
  preview: async () => null,
  refreshState: async () => null,
  requestRemoteSpending: async () => ({ granted: true }),
  resume: async () => ({ ok: true }),
  scheduleCancellation: async () => ({ ok: true }),
  scheduleChange: async () => ({ ok: true }),
  sys: () => {},
  upgrade: async () => ({ ok: true, status: 'upgraded' })
}

function mount(overlay: SubscriptionOverlayState) {
  const store = createSessionStore()
  store.openSubscription(overlay)
  return () => (
    <ThemeProvider theme={() => store.state.theme}>
      <SubscriptionOverlay
        overlay={store.state.subscription!}
        onPatch={next => store.patchSubscription(next)}
        onClose={() => store.closeSubscription()}
      />
    </ThemeProvider>
  )
}

describe('subscription native adaptation', () => {
  test('status names a pending plan transition', () => {
    expect(subscriptionStatusLine(state())).toContain('Plan: Plus')
    expect(
      subscriptionStatusLine(
        state({
          current: { ...state().current!, pending_downgrade_tier_name: 'Basic', pending_downgrade_at: '2026-08-01' }
        })
      )
    ).toContain('Plus → Basic')
  })

  test('store owns open, patch, and close lifecycle', () => {
    const store = createSessionStore()
    store.openSubscription({ ctx, screen: 'overview', state: state() })
    store.patchSubscription({ screen: 'picker' })
    expect(store.state.subscription?.screen).toBe('picker')
    store.closeSubscription()
    expect(store.state.subscription).toBeUndefined()
  })

  test('overview paints plan identity and native plan actions', async () => {
    const frame = await captureFrame(mount({ ctx, screen: 'overview', state: state() }), { width: 100, height: 30 })
    expect(frame).toContain('Plan: Plus')
    expect(frame).toContain('Change plan')
    expect(frame).toContain('Cancel subscription')
  })

  test('free, low-balance, and read-only states keep their recovery copy', async () => {
    const free = await captureFrame(
      mount({
        ctx,
        screen: 'overview',
        state: state({ current: null, usage: { available: true, status: 'free', plan_name: null } })
      }),
      { width: 100, height: 30 }
    )
    expect(free).toContain('Plan: Free · free models only')
    expect(free).toContain('Start a subscription')
    expect(free.toLowerCase()).not.toContain('credits')

    const low = await captureFrame(
      mount({
        ctx,
        screen: 'overview',
        state: state({ usage: { available: true, status: 'low', plan_name: 'Plus', total_spendable_display: '$3.00' } })
      }),
      { width: 100, height: 30 }
    )
    expect(low).toContain('Low balance · $3.00 left')

    const readOnly = await captureFrame(
      mount({ ctx, screen: 'overview', state: state({ can_change_plan: false, is_admin: false }) }),
      { width: 100, height: 30 }
    )
    expect(readOnly).toContain('view only')
    expect(readOnly).not.toContain('Change plan')
  })

  test('pending change leads with its transition and promotes undo', async () => {
    const frame = await captureFrame(
      mount({
        ctx,
        screen: 'overview',
        state: state({
          current: {
            ...state().current!,
            pending_downgrade_tier_name: 'Basic',
            pending_downgrade_at: '2026-08-01',
            pending_downgrade_display: 'Aug 1'
          }
        })
      }),
      { width: 100, height: 30 }
    )
    expect(frame).toContain('Scheduled change')
    expect(frame).toContain('Plus ──▶ Basic')
    expect(frame).toContain('Keep Plus (undo this change)')
  })

  test('picker excludes current and free plans and labels direction', async () => {
    const frame = await captureFrame(mount({ ctx, screen: 'picker', state: state() }), { width: 100, height: 30 })
    expect(frame).toContain('Ultra · $40/mo · upgrade')
    expect(frame).not.toContain('Plus · $20/mo')
    expect(frame).not.toContain('Free · $0/mo')
  })

  test('charge-now and scheduled confirmations state money timing explicitly', async () => {
    const charge = await captureFrame(
      mount({
        ctx,
        screen: 'confirm',
        state: state(),
        pending: {
          kind: 'upgrade',
          targetTierId: 'ultra',
          preview: { ok: true, effect: 'charge_now', target_tier_name: 'Ultra', amount_due_now_cents: 1234 }
        }
      }),
      { width: 100, height: 30 }
    )
    expect(charge).toContain('Pay $12.34 & upgrade now')
    expect(charge).toContain('charged $12.34 now')
    expect(charge).toContain('The card on your subscription will be charged')

    const scheduled = await captureFrame(
      mount({
        ctx,
        screen: 'confirm',
        state: state(),
        pending: {
          kind: 'tier_change',
          targetTierId: 'basic',
          preview: { ok: true, effect: 'scheduled', target_tier_name: 'Basic', effective_at: '2026-08-01' }
        }
      }),
      { width: 100, height: 30 }
    )
    expect(scheduled).toContain('No charge now')
    expect(scheduled).toContain('2026-08-01')
  })

  test('charge-now identifies the subscription-resolved card when available', async () => {
    const cardCtx: SubscriptionCtx = {
      ...ctx,
      fetchCard: async () => ({
        brand: 'Visa',
        display: 'Visa •••• 4242 (card on your subscription)',
        last4: '4242',
        masked: 'Visa •••• 4242',
        resolved_via: 'subPin'
      })
    }
    const frame = await captureFrame(
      mount({
        ctx: cardCtx,
        screen: 'confirm',
        state: state(),
        pending: {
          kind: 'upgrade',
          targetTierId: 'ultra',
          preview: { ok: true, effect: 'charge_now', target_tier_name: 'Ultra', amount_due_now_cents: 1234 }
        }
      }),
      { until: 'Visa •••• 4242', width: 110, height: 30 }
    )
    expect(frame).toContain('the card on your subscription — will be charged')
  })

  test('locks confirmation navigation while an upgrade is unresolved', async () => {
    const upgrade = vi.fn(() => new Promise<never>(() => {}))
    const store = createSessionStore()
    store.openSubscription({
      ctx: { ...ctx, upgrade },
      screen: 'confirm',
      state: state(),
      pending: {
        idempotencyKey: 'stable-upgrade-key',
        kind: 'upgrade',
        targetTierId: 'ultra',
        preview: { ok: true, effect: 'charge_now', target_tier_name: 'Ultra', amount_due_now_cents: 1234 }
      }
    })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <SubscriptionOverlay
            overlay={store.state.subscription!}
            onPatch={next => store.patchSubscription(next)}
            onClose={() => store.closeSubscription()}
          />
        </ThemeProvider>
      ),
      { kittyKeyboard: true, width: 100, height: 30 }
    )
    try {
      probe.keys.pressEnter()
      await probe.settle()
      probe.keys.pressEscape()
      probe.keys.pressEnter()
      await probe.settle()
      expect(upgrade).toHaveBeenCalledTimes(1)
      expect(upgrade).toHaveBeenCalledWith('ultra', 'stable-upgrade-key')
      expect(store.state.subscription?.screen).toBe('confirm')
      expect(store.state.subscription?.pending?.idempotencyKey).toBe('stable-upgrade-key')
      expect(probe.frame()).toContain('Working')
    } finally {
      probe.destroy()
    }
  })

  test('locks step-up replay navigation while an upgrade is unresolved', async () => {
    const upgrade = vi.fn(() => new Promise<never>(() => {}))
    const store = createSessionStore()
    store.openSubscription({
      ctx: { ...ctx, requestRemoteSpending: async () => ({ granted: true }), upgrade },
      screen: 'stepup',
      state: state(),
      stepUpRetry: { kind: 'apply' },
      pending: {
        idempotencyKey: 'stable-replay-key',
        kind: 'upgrade',
        targetTierId: 'ultra',
        preview: { ok: true, effect: 'charge_now', target_tier_name: 'Ultra', amount_due_now_cents: 1234 }
      }
    })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <SubscriptionOverlay
            overlay={store.state.subscription!}
            onPatch={next => store.patchSubscription(next)}
            onClose={() => store.closeSubscription()}
          />
        </ThemeProvider>
      ),
      { kittyKeyboard: true, width: 100, height: 30 }
    )
    try {
      probe.keys.pressEnter()
      await probe.settle()
      probe.keys.pressEnter()
      await probe.settle()
      probe.keys.pressEscape()
      probe.keys.pressEnter()
      await probe.settle()
      expect(upgrade).toHaveBeenCalledTimes(1)
      expect(upgrade).toHaveBeenCalledWith('ultra', 'stable-replay-key')
      expect(store.state.subscription?.screen).toBe('stepup')
      expect(store.state.subscription?.pending?.idempotencyKey).toBe('stable-replay-key')
      expect(probe.frame()).toContain('Resuming your plan change')
    } finally {
      probe.destroy()
    }
  })

  test('blocked and result screens preserve portal recovery and apply state', async () => {
    const blocked = await captureFrame(
      mount({
        ctx,
        screen: 'confirm',
        state: state(),
        pending: {
          kind: 'tier_change',
          targetTierId: 'ultra',
          preview: { ok: true, effect: 'blocked', reason: 'This change requires portal approval.' }
        }
      }),
      { width: 100, height: 30 }
    )
    expect(blocked).toContain('This change requires portal approval')
    expect(blocked).toContain('Manage on portal')

    const applying = await captureFrame(
      mount({
        ctx,
        screen: 'result',
        state: state(),
        result: { message: 'Upgraded to Ultra.', ok: true, pendingTierId: 'ultra' }
      }),
      { width: 100, height: 30 }
    )
    expect(applying).toContain('Applying')

    const recovery = await captureFrame(
      mount({
        ctx,
        screen: 'result',
        state: state(),
        result: { message: 'Your card was declined.', ok: false, recoveryUrl: 'https://portal.example/recover' }
      }),
      { width: 100, height: 30 }
    )
    expect(recovery).toContain('Your card was declined')
    expect(recovery).toContain('Open the portal to finish')
  })

  test('team context is a dead-end to shared balance and portal management', async () => {
    const frame = await captureFrame(mount({ ctx, screen: 'overview', state: state({ context: 'team' }) }), {
      width: 100,
      height: 30
    })
    expect(frame).toContain('Team billing')
    expect(frame).toContain('/topup')
    expect(frame).not.toContain('Change plan')
  })

  test('scope denial renders a resumable terminal-billing screen without raw scope names', async () => {
    const frame = await captureFrame(mount({ ctx, screen: 'stepup', state: state(), stepUpRetry: { kind: 'apply' } }), {
      width: 100,
      height: 30
    })
    expect(frame).toContain('Enable terminal billing')
    expect(frame).not.toContain('billing:manage')
  })
})
