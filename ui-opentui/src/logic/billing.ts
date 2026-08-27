/**
 * Remote Spending / billing — the SOLID-side RPC + error-mapping logic (mirrors Ink
 * `app/slash/commands/billing.ts`). Plain functions; the slash opener injects a
 * Promise-returning `request` (the gateway RPC), `pushSystem` (transcript
 * lines), `confirm` (the step-up Y/N), and `sessionId`.
 *
 * ALL gateway calls + error copy live here so the overlay view only renders +
 * routes keys. The poll cadence (2s interval, 5-minute cap) and error→copy map
 * match the Ink TUI and the classic CLI for parity.
 */
import type {
  AmountValidation,
  BillingChargeResponse,
  BillingChargeStatusResponse,
  BillingCtx,
  BillingErrorPayload,
  BillingMutationResponse,
  BillingStateResponse
} from '../boundary/billing.ts'
import { openExternalUrl } from '../boundary/openExternalUrl.ts'
import type { ConfirmRequest } from './store.ts'

/** Poll cadence (frozen): 2s interval, 5-minute cap. */
const POLL_INTERVAL_MS = 2000
const POLL_CAP_MS = 5 * 60 * 1000

/** The host capabilities the billing flow needs (a subset of SlashContext). */
export interface BillingHost {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  pushSystem: (text: string) => void
  confirm: (request: ConfirmRequest, onConfirm: () => void) => void
  sessionId: () => string | undefined
}

interface BillingErrorEnvelope {
  actor?: string
  code?: string
  error?: string
  message?: string
  payload?: BillingErrorPayload
  portal_url?: string | null
  retry_after?: number | null
}

/** Map a typed billing error envelope to user-facing copy + portal funnel. */
function renderBillingError(host: BillingHost, env: BillingErrorEnvelope): void {
  const sys = host.pushSystem
  const portal = env.portal_url

  switch (env.error) {
    case 'insufficient_scope':
      sys('This needs Remote Spending allowed. Start a top-up to allow it, then retry.')
      break
    case 'remote_spending_revoked':
      sys(
        env.actor === 'admin'
          ? 'An admin stopped remote spending for this terminal. Reconnect with /portal to restore it.'
          : 'You stopped remote spending for this terminal. Reconnect with /portal to restore it.'
      )
      break
    case 'session_revoked':
      sys('Your session was logged out. Run /portal to log in again.')
      break
    case 'no_payment_method':
      sys(
        '💳 No saved card for terminal charges yet. Set one up on the portal (one-time credit buys don’t save a reusable card).'
      )
      break
    case 'cli_billing_disabled':
    case 'remote_spending_disabled':
      sys(
        "🔴 Remote spending is off for this account — a billing admin can turn it on from the portal's Hermes Agent page."
      )
      break
    case 'role_required':
      sys('Adding funds needs someone with billing permissions (owner, admin, or finance admin).')
      break
    case 'consent_required':
      sys('This action needs a one-time card confirmation and consent step on the portal before it can proceed.')
      break
    case 'org_access_denied':
      sys("This token isn't bound to an org you can manage. Sign in with the right org, or manage this on the portal.")
      break
    case 'upgrade_cap_exceeded':
      sys('🔴 Daily plan-change limit reached (5 per org) — try again tomorrow, or manage this on the portal.')
      break
    case 'auto_top_up_disabled_failures':
      sys(
        'Auto-reload was turned off after repeated charge failures. Fix the card issue, then re-enable it from /topup → Auto-reload.'
      )
      break
    case 'idempotency_conflict':
      sys('🔴 That charge key was already used for a different amount. Start a fresh top-up.')
      break
    case 'stripe_unavailable':
    case 'temporarily_unavailable':
      sys('🟡 Billing is temporarily unavailable — try again shortly. This isn’t a payment failure.')
      break
    case 'monthly_cap_exceeded': {
      const remaining = env.payload?.remainingUsd
      sys(
        remaining != null
          ? `🔴 Monthly spend cap reached — $${remaining} headroom left.`
          : '🔴 Monthly spend cap reached.'
      )
      break
    }
    case 'rate_limited': {
      const mins = env.retry_after ? ` (try again in ~${Math.max(1, Math.round(env.retry_after / 60))} min)` : ''
      sys(`🟡 Too many charges right now${mins}. This isn’t a payment failure.`)
      break
    }
    default:
      sys(`🔴 ${env.message || env.error || 'Billing request failed.'}`)
  }

  if (portal) sys(`Portal: ${portal}`)
}

function renderChargeFailed(host: BillingHost, reason?: string | null, portalUrl?: string | null): void {
  const sys = host.pushSystem
  switch ((reason || '').trim()) {
    case 'authentication_required':
      sys('🔴 Your bank requires verification (3DS). Complete it on the portal to finish this purchase.')
      break
    case 'payment_method_expired':
      sys('🔴 Your card has expired. Update it on the portal.')
      break
    case 'card_declined':
      sys('🔴 Your card was declined. Try another card on the portal.')
      break
    default:
      sys(`🔴 The charge didn’t go through (${reason || 'processing_error'}).`)
  }
  if (portalUrl) sys(`Portal: ${portalUrl}`)
}

/** Poll a charge to a terminal state (settled/failed/timeout). Non-blocking. */
function pollCharge(host: BillingHost, chargeId: string, portalUrl?: string | null): void {
  const sys = host.pushSystem
  const start = Date.now()

  const tick = (): void => {
    host
      .request('billing.charge_status', { charge_id: chargeId })
      .then(raw => {
        const r = raw as BillingChargeStatusResponse
        if (!r.ok) {
          // 429/503 while polling = retry-after, NOT a failure. Back off + continue.
          if (r.error === 'rate_limited') {
            const wait = (r.retry_after ?? 5) * 1000
            setTimeout(tick, Math.min(wait, 30000))
            return
          }
          sys(`🔴 Could not check the charge: ${r.message || r.error || 'error'}`)
          return
        }
        if (r.status === 'settled') {
          sys(`✅ ${r.amount_usd ? `$${r.amount_usd}` : 'Credits'} added.`)
          return
        }
        if (r.status === 'failed') {
          renderChargeFailed(host, r.reason, portalUrl)
          return
        }
        // pending → keep polling until the 5-min cap, then call it a timeout.
        if (Date.now() - start >= POLL_CAP_MS) {
          sys(
            '🟡 Still processing after 5 minutes — this is a timeout, not a failure. Check /topup or the portal shortly.'
          )
          if (portalUrl) sys(`Portal: ${portalUrl}`)
          return
        }
        setTimeout(tick, POLL_INTERVAL_MS)
      })
      .catch(() => sys('🟡 Your last charge’s outcome is unconfirmed — check your balance/history before retrying.'))
  }

  tick()
}

/** Validate a custom amount against state bounds + 2dp, mirroring the server. */
export function validateAmount(raw: string, s: BillingStateResponse): AmountValidation {
  const cleaned = raw.trim().replace(/^\$/, '').trim()
  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return { error: 'Enter a dollar amount, e.g. 100 (max 2 decimal places).' }
  }
  const value = Number(cleaned)
  if (!(value > 0)) return { error: 'Amount must be greater than $0.' }
  if (s.min_usd != null && value < Number(s.min_usd)) return { error: `Minimum is $${s.min_usd}.` }
  if (s.max_usd != null && value > Number(s.max_usd)) return { error: `Maximum is $${s.max_usd}.` }
  return { amount: cleaned }
}

/**
 * Build the closure bundle the BillingOverlay needs. Keeps ALL RPC + error
 * mapping here (single source of truth); the overlay only renders + routes keys.
 */
export function buildBillingCtx(host: BillingHost, s: BillingStateResponse): BillingCtx {
  return {
    applyAutoReload: (enabled, threshold, topUp) =>
      host
        .request('billing.auto_reload', {
          enabled,
          ...(threshold != null ? { threshold } : {}),
          ...(topUp != null ? { top_up_amount: topUp } : {})
        })
        .then(raw => {
          const r = raw as BillingMutationResponse | undefined
          if (r && r.ok) return true
          if (r) renderBillingError(host, r)
          return false
        })
        .catch(() => {
          host.pushSystem('🔴 Auto-reload update failed (request error).')
          return false
        }),
    charge: (amount: string, idempotencyKey?: string) => {
      host.pushSystem('💳 Charge submitted — confirming settlement…')
      return host
        .request('billing.charge', {
          amount_usd: amount,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
        })
        .then(raw => {
          const r = raw as BillingChargeResponse
          if (r.ok && r.charge_id) {
            pollCharge(host, r.charge_id, s.portal_url)
            return 'submitted' as const
          }
          if (r.error === 'insufficient_scope') return 'needs_remote_spending' as const
          renderBillingError(host, r)
          return 'error' as const
        })
        .catch(() => {
          host.pushSystem('🔴 Charge failed (request error).')
          return 'error' as const
        })
    },
    openPortal: (url: string) => {
      // Try the browser; whether or not the spawn lands, always print the URL so
      // a headless/remote terminal user can copy it (Ink parity).
      openExternalUrl(url)
      host.pushSystem(`Opening portal: ${url}`)
    },
    refreshState: () =>
      host
        .request('billing.state', {})
        .then(raw => raw as BillingStateResponse)
        .catch(() => null),
    requestRemoteSpending: () =>
      host
        .request('billing.step_up', { session_id: host.sessionId() })
        .then(raw => {
          const response = raw as BillingMutationResponse
          return Boolean(response.ok && response.granted)
        })
        .catch(() => false),
    sys: host.pushSystem,
    validate: (raw: string) => validateAmount(raw, s)
  }
}
