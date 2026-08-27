/**
 * Billing overlay (Port #1) — three layers:
 *   1. `validateAmount` — the pure amount validator (bounds + 2dp), mirroring
 *      the server + the Ink `completionApply`-style table tests.
 *   2. store wiring — openBilling / patchBilling / closeBilling drive the
 *      overlay state machine.
 *   3. render — captureFrame proves the overview screen actually PAINTS (balance,
 *      spend bar, menu) and that a screen patch swaps the rendered screen.
 */
import { describe, expect, test, vi } from 'vitest'

import type { BillingCtx, BillingStateResponse } from '../boundary/billing.ts'
import { buildBillingCtx, validateAmount } from '../logic/billing.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { BillingOverlay } from '../view/overlays/billing.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame, renderProbe } from './lib/render.ts'

function fakeState(over: Partial<BillingStateResponse> = {}): BillingStateResponse {
  return {
    auto_reload: {
      enabled: false,
      reload_to_display: '$50',
      reload_to_usd: '50',
      threshold_display: '$10',
      threshold_usd: '10'
    },
    balance_display: '$42.00',
    balance_usd: '42.00',
    can_charge: true,
    card: { brand: 'visa', last4: '4242', masked: 'Visa •••• 4242' },
    charge_presets: ['10', '25', '100'],
    charge_presets_display: ['$10', '$25', '$100'],
    cli_billing_enabled: true,
    is_admin: true,
    logged_in: true,
    max_usd: '1000',
    min_usd: '5',
    monthly_cap: {
      is_default_ceiling: false,
      limit_display: '$500',
      limit_usd: '500',
      spent_display: '$250',
      spent_this_month_usd: '250'
    },
    ok: true,
    org_name: 'Nous',
    portal_url: 'https://portal.example/billing',
    role: 'owner',
    ...over
  }
}

const noopCtx: BillingCtx = {
  charge: async () => 'submitted',
  applyAutoReload: async () => true,
  openPortal: () => {},
  refreshState: async () => fakeState(),
  requestRemoteSpending: async () => true,
  sys: () => {},
  validate: raw => validateAmount(raw, fakeState())
}

// ── 1. validateAmount ────────────────────────────────────────────────────

describe('validateAmount — bounds + 2dp (mirrors the server)', () => {
  const s = fakeState({ min_usd: '5', max_usd: '1000' })

  test('accepts a plain integer and strips a leading $', () => {
    expect(validateAmount('100', s).amount).toBe('100')
    expect(validateAmount('$100', s).amount).toBe('100')
    expect(validateAmount('  100  ', s).amount).toBe('100')
  })

  test('accepts up to 2 decimal places, rejects 3+', () => {
    expect(validateAmount('10.50', s).amount).toBe('10.50')
    expect(validateAmount('10.555', s).error).toBeTruthy()
  })

  test('rejects non-numeric / empty input', () => {
    expect(validateAmount('', s).error).toBeTruthy()
    expect(validateAmount('abc', s).error).toBeTruthy()
  })

  test('enforces the min and max bounds', () => {
    expect(validateAmount('1', s).error).toContain('Minimum')
    expect(validateAmount('5000', s).error).toContain('Maximum')
    expect(validateAmount('0', s).error).toBeTruthy()
  })

  test('passes through with no bounds set', () => {
    const open = fakeState({ min_usd: null, max_usd: null })
    expect(validateAmount('1', open).amount).toBe('1')
  })
})

describe('billing RPC behavior', () => {
  test('charge forwards its stable idempotency key and routes scope denial to step-up', async () => {
    const request = vi.fn(async () => ({ ok: false, error: 'insufficient_scope' }))
    const lines: string[] = []
    const billing = buildBillingCtx(
      { request, pushSystem: text => lines.push(text), confirm: () => {}, sessionId: () => 'sid-1' },
      fakeState()
    )
    await expect(billing.charge('25', 'charge-key-1')).resolves.toBe('needs_remote_spending')
    expect(request).toHaveBeenCalledWith('billing.charge', { amount_usd: '25', idempotency_key: 'charge-key-1' })
    expect(lines.join('\n')).not.toContain('billing:manage')
  })

  test.each([
    ['consent_required', 'one-time card confirmation'],
    ['org_access_denied', "isn't bound to an org"],
    ['upgrade_cap_exceeded', 'Daily plan-change limit reached'],
    ['auto_top_up_disabled_failures', 'Auto-reload was turned off'],
    ['idempotency_conflict', 'charge key was already used']
  ])('maps %s to actionable recovery copy', async (error, copy) => {
    const lines: string[] = []
    const billing = buildBillingCtx(
      {
        request: async () => ({ ok: false, error }),
        pushSystem: text => lines.push(text),
        confirm: () => {},
        sessionId: () => 'sid-1'
      },
      fakeState()
    )
    await billing.charge('25')
    expect(lines.join('\n')).toContain(copy)
  })

  // The capability is "Remote Spending" on the portal (consent CTA: "Allow
  // Remote Spending"; per-terminal states Granted/Stopped) — every scope/kill-
  // switch denial must speak that vocabulary, never the retired "terminal
  // billing" (upstream b0da653a rename).
  test.each([
    ['insufficient_scope', 'This needs Remote Spending allowed'],
    ['remote_spending_revoked', 'stopped remote spending for this terminal'],
    ['cli_billing_disabled', "a billing admin can turn it on from the portal's Hermes Agent page"],
    ['remote_spending_disabled', "a billing admin can turn it on from the portal's Hermes Agent page"]
  ])('%s speaks Remote Spending, never the retired feature name', async (error, copy) => {
    const lines: string[] = []
    const billing = buildBillingCtx(
      {
        request: async () => ({ ok: false, error }),
        pushSystem: text => lines.push(text),
        confirm: () => {},
        sessionId: () => 'sid-1'
      },
      fakeState()
    )
    await billing.applyAutoReload(true, 10, 50)
    expect(lines.join('\n')).toContain(copy)
    expect(lines.join('\n')).not.toMatch(/terminal billing/i)
  })

  test('a per-terminal revoke distinguishes the admin actor', async () => {
    const lines: string[] = []
    const billing = buildBillingCtx(
      {
        request: async () => ({ ok: false, error: 'remote_spending_revoked', actor: 'admin' }),
        pushSystem: text => lines.push(text),
        confirm: () => {},
        sessionId: () => 'sid-1'
      },
      fakeState()
    )
    await billing.applyAutoReload(true, 10, 50)
    expect(lines.join('\n')).toContain('An admin stopped remote spending for this terminal')
  })
})

// ── 2. store wiring ──────────────────────────────────────────────────────

describe('store — billing overlay lifecycle', () => {
  test('openBilling sets the overlay; patchBilling transitions screens; closeBilling clears', () => {
    const store = createSessionStore()
    expect(store.state.billing).toBeUndefined()
    const owner = store.openBilling({ ctx: noopCtx, pendingCharge: null, screen: 'overview', state: fakeState() })
    expect(store.state.billing?.screen).toBe('overview')
    store.patchBilling(owner, { screen: 'buy' })
    expect(store.state.billing?.screen).toBe('buy')
    store.patchBilling(owner, { pendingCharge: { amount: '25' }, screen: 'confirm' })
    expect(store.state.billing?.screen).toBe('confirm')
    expect(store.state.billing?.pendingCharge?.amount).toBe('25')
    store.closeBilling(owner)
    expect(store.state.billing).toBeUndefined()
  })

  test('patchBilling is a no-op when no overlay is open', () => {
    const store = createSessionStore()
    store.patchBilling(1, { screen: 'buy' })
    expect(store.state.billing).toBeUndefined()
  })

  test('an old session owner cannot patch or close a successor billing overlay', () => {
    const store = createSessionStore()
    const oldOwner = store.openBilling({ ctx: noopCtx, pendingCharge: null, screen: 'overview', state: fakeState() })
    store.adoptFreshSession('sid-2')
    const currentOwner = store.openBilling({
      ctx: noopCtx,
      pendingCharge: null,
      screen: 'overview',
      state: fakeState()
    })

    store.patchBilling(oldOwner, { screen: 'buy' })
    store.closeBilling(oldOwner)

    expect(currentOwner).not.toBe(oldOwner)
    expect(store.state.billing?.owner).toBe(currentOwner)
    expect(store.state.billing?.screen).toBe('overview')
  })
})

// ── 3. render ────────────────────────────────────────────────────────────

function mount(
  screen: 'overview' | 'buy' | 'autoreload' | 'stepup',
  state = fakeState(),
  pendingCharge: { amount: string; idempotencyKey?: string } | null = null
) {
  const store = createSessionStore()
  const owner = store.openBilling({ ctx: noopCtx, pendingCharge, screen, state })
  return () => (
    <ThemeProvider theme={() => store.state.theme}>
      <BillingOverlay
        overlay={store.state.billing!}
        onPatch={next => store.patchBilling(owner, next)}
        onClose={() => store.closeBilling(owner)}
      />
    </ThemeProvider>
  )
}

describe('billing overlay render (captureCharFrame)', () => {
  test('overview leads with dollar balance and the admin menu', async () => {
    const frame = await captureFrame(mount('overview'), { until: 'Top up · balance', width: 80, height: 30 })
    expect(frame).toContain('Top up · balance $42.00')
    expect(frame).toContain('Add funds') // full admin menu (admin + kill-switch on)
    expect(frame).toContain('Manage on portal')
  })

  test('the kill-switch-off note points at the actual portal control', async () => {
    const frame = await captureFrame(mount('overview', fakeState({ cli_billing_enabled: false })), {
      until: 'Top up · balance',
      width: 110,
      height: 30
    })
    expect(frame).toContain("a billing admin can turn it on from the portal's Hermes Agent page")
    expect(frame).not.toMatch(/terminal billing/i)
  })

  test('the step-up flow starts AND finishes in Remote Spending vocabulary', async () => {
    const prompt = await captureFrame(mount('stepup', fakeState(), { amount: '25' }), {
      until: 'One-time setup',
      width: 90,
      height: 30
    })
    expect(prompt).toContain('To charge from this terminal, allow Remote Spending once.')
    expect(prompt).toContain('Allow Remote Spending')
    expect(prompt).toContain('$25')
    expect(prompt).not.toMatch(/terminal billing/i)
  })

  test('a non-admin sees the collapsed menu + the gating note', async () => {
    const frame = await captureFrame(mount('overview', fakeState({ is_admin: false })), {
      until: 'Top up · balance',
      width: 80,
      height: 30
    })
    expect(frame).toContain('org admin/owner') // the note
    expect(frame).not.toContain('Add funds') // collapsed — no buy row
  })

  test('the buy screen paints the presets + payment line', async () => {
    const frame = await captureFrame(mount('buy'), { until: 'Add funds', width: 80, height: 30 })
    expect(frame).toContain('Add funds')
    expect(frame).toContain('$10')
    expect(frame).toContain('Custom amount')
    expect(frame).toContain('4242') // the masked card payment line
  })

  test('the auto-reload form PREFILLS the existing threshold + reload-to (regression: empty fields)', async () => {
    // Adversarial-review catch (round 1): the engine <input>'s `value` is an
    // init-only seed; without it the form mounted EMPTY even when an auto_reload
    // config exists, dropping the current values. Seed threshold=10, reload_to=50
    // and assert both paint in their fields.
    const frame = await captureFrame(
      mount(
        'autoreload',
        fakeState({
          auto_reload: {
            enabled: true,
            reload_to_display: '$50',
            reload_to_usd: '50',
            threshold_display: '$10',
            threshold_usd: '10'
          }
        })
      ),
      { until: 'Auto-reload', width: 80, height: 30 }
    )
    expect(frame).toContain('When balance falls below:')
    expect(frame).toContain('Reload balance to:')
    // both prefilled values must appear inside the $ fields (not blank inputs)
    expect(frame).toContain('10')
    expect(frame).toContain('50')
    expect(frame).toContain('Turn off') // enabled → the Turn-off action row shows
  })

  test('auto-reload discloses a distinct charge card and offers portal hand-off', async () => {
    const frame = await captureFrame(
      mount(
        'autoreload',
        fakeState({
          auto_reload: {
            card: { kind: 'distinct', payment_method_id: 'pm-1', brand: 'Mastercard', last4: '9999' },
            enabled: true,
            reload_to_display: '$50',
            reload_to_usd: '50',
            threshold_display: '$10',
            threshold_usd: '10'
          }
        })
      ),
      { width: 100, height: 32 }
    )
    expect(frame).toContain('Auto-refill is charging Mastercard ••9999')
    expect(frame).toContain('Use your card on file — manage on portal')
  })

  test('locks confirmation navigation while a charge is unresolved', async () => {
    const charge = vi.fn(() => new Promise<'submitted'>(() => {}))
    const store = createSessionStore()
    const owner = store.openBilling({
      ctx: { ...noopCtx, charge },
      pendingCharge: { amount: '25', idempotencyKey: 'stable-charge-key' },
      screen: 'confirm',
      state: fakeState()
    })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <BillingOverlay
            overlay={store.state.billing!}
            onPatch={next => store.patchBilling(owner, next)}
            onClose={() => store.closeBilling(owner)}
          />
        </ThemeProvider>
      ),
      { kittyKeyboard: true, width: 80, height: 30 }
    )
    try {
      probe.keys.pressEnter()
      await probe.settle()
      probe.keys.pressEscape()
      probe.keys.pressEnter()
      await probe.settle()
      expect(charge).toHaveBeenCalledTimes(1)
      expect(charge).toHaveBeenCalledWith('25', 'stable-charge-key')
      expect(store.state.billing?.screen).toBe('confirm')
      expect(store.state.billing?.pendingCharge?.idempotencyKey).toBe('stable-charge-key')
      expect(probe.frame()).toContain('Processing payment')
    } finally {
      probe.destroy()
    }
  })

  test('a deferred charge completion cannot close the next session billing overlay', async () => {
    let resolveCharge!: (value: 'submitted') => void
    const charge = vi.fn(() => new Promise<'submitted'>(resolve => (resolveCharge = resolve)))
    const store = createSessionStore()
    store.adoptFreshSession('sid-1')
    store.openBilling({
      ctx: { ...noopCtx, charge },
      pendingCharge: { amount: '25', idempotencyKey: 'session-a-charge' },
      screen: 'confirm',
      state: fakeState()
    })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { kittyKeyboard: true, width: 100, height: 34 }
    )
    try {
      probe.keys.pressEnter()
      await probe.settle()
      expect(charge).toHaveBeenCalledTimes(1)

      store.adoptFreshSession('sid-2')
      const currentOwner = store.openBilling({
        ctx: noopCtx,
        pendingCharge: null,
        screen: 'overview',
        state: fakeState()
      })
      resolveCharge('submitted')
      await new Promise<void>(done => setTimeout(done, 0))
      await probe.settle()

      expect(store.state.billing?.owner).toBe(currentOwner)
      expect(store.state.billing?.screen).toBe('overview')
    } finally {
      probe.destroy()
    }
  })

  test('turning auto-reload off preserves the required current amounts', async () => {
    const applyAutoReload = vi.fn(async () => true)
    const store = createSessionStore()
    const owner = store.openBilling({
      ctx: { ...noopCtx, applyAutoReload },
      pendingCharge: null,
      screen: 'autoreload',
      state: fakeState({
        auto_reload: {
          enabled: true,
          reload_to_display: '$50',
          reload_to_usd: '50',
          threshold_display: '$10',
          threshold_usd: '10'
        }
      })
    })
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <BillingOverlay
            overlay={store.state.billing!}
            onPatch={next => store.patchBilling(owner, next)}
            onClose={() => store.closeBilling(owner)}
          />
        </ThemeProvider>
      ),
      { kittyKeyboard: true, width: 80, height: 30 }
    )
    try {
      probe.keys.pressArrow('down')
      probe.keys.pressArrow('down')
      probe.keys.pressArrow('down')
      probe.keys.pressEnter()
      await probe.settle()
      expect(applyAutoReload).toHaveBeenCalledWith(false, 10, 50)
    } finally {
      probe.destroy()
    }
  })
})
