/**
 * Billing overlay (Port #1) — three layers:
 *   1. `validateAmount` — the pure amount validator (bounds + 2dp), mirroring
 *      the server + the Ink `completionApply`-style table tests.
 *   2. store wiring — openBilling / patchBilling / closeBilling drive the
 *      overlay state machine.
 *   3. render — captureFrame proves the overview screen actually PAINTS (balance,
 *      spend bar, menu) and that a screen patch swaps the rendered screen.
 */
import { describe, expect, test } from 'vitest'

import type { BillingCtx, BillingStateResponse } from '../boundary/billing.ts'
import { validateAmount } from '../logic/billing.ts'
import { createSessionStore } from '../logic/store.ts'
import { BillingOverlay } from '../view/overlays/billing.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame } from './lib/render.ts'

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
  charge: () => {},
  applyAutoReload: async () => true,
  openPortal: () => {},
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

// ── 2. store wiring ──────────────────────────────────────────────────────

describe('store — billing overlay lifecycle', () => {
  test('openBilling sets the overlay; patchBilling transitions screens; closeBilling clears', () => {
    const store = createSessionStore()
    expect(store.state.billing).toBeUndefined()
    store.openBilling({ ctx: noopCtx, pendingCharge: null, screen: 'overview', state: fakeState() })
    expect(store.state.billing?.screen).toBe('overview')
    store.patchBilling({ screen: 'buy' })
    expect(store.state.billing?.screen).toBe('buy')
    store.patchBilling({ pendingCharge: { amount: '25' }, screen: 'confirm' })
    expect(store.state.billing?.screen).toBe('confirm')
    expect(store.state.billing?.pendingCharge?.amount).toBe('25')
    store.closeBilling()
    expect(store.state.billing).toBeUndefined()
  })

  test('patchBilling is a no-op when no overlay is open', () => {
    const store = createSessionStore()
    store.patchBilling({ screen: 'buy' })
    expect(store.state.billing).toBeUndefined()
  })
})

// ── 3. render ────────────────────────────────────────────────────────────

function mount(screen: 'overview' | 'buy' | 'autoreload', state = fakeState()) {
  const store = createSessionStore()
  store.openBilling({ ctx: noopCtx, pendingCharge: null, screen, state })
  return () => (
    <ThemeProvider theme={() => store.state.theme}>
      <BillingOverlay
        overlay={store.state.billing!}
        onPatch={next => store.patchBilling(next)}
        onClose={() => store.closeBilling()}
      />
    </ThemeProvider>
  )
}

describe('billing overlay render (captureCharFrame)', () => {
  test('overview paints the balance, spend bar, and the admin menu', async () => {
    const frame = await captureFrame(mount('overview'), { until: 'Usage credits', width: 80, height: 30 })
    expect(frame).toContain('Usage credits')
    expect(frame).toContain('Balance: $42.00')
    expect(frame).toContain('█') // the spend bar painted
    expect(frame).toContain('Buy credits') // full admin menu (admin + kill-switch on)
    expect(frame).toContain('Manage on portal')
  })

  test('a non-admin sees the collapsed menu + the gating note', async () => {
    const frame = await captureFrame(mount('overview', fakeState({ is_admin: false })), {
      until: 'Usage credits',
      width: 80,
      height: 30
    })
    expect(frame).toContain('org admin/owner') // the note
    expect(frame).not.toContain('Buy credits') // collapsed — no buy row
  })

  test('the buy screen paints the presets + payment line', async () => {
    const frame = await captureFrame(mount('buy'), { until: 'Buy usage credits', width: 80, height: 30 })
    expect(frame).toContain('Buy usage credits')
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
})
