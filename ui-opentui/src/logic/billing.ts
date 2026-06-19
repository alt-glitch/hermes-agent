/**
 * Terminal billing — the SOLID-side RPC + error-mapping logic (mirrors Ink
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

/** Poll cadence (frozen): 2s interval, 5-minute cap. */
const POLL_INTERVAL_MS = 2000
const POLL_CAP_MS = 5 * 60 * 1000

/** The host capabilities the billing flow needs (a subset of SlashContext). */
export interface BillingHost {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  pushSystem: (text: string) => void
  confirm: (message: string, onConfirm: () => void) => void
  sessionId: () => string | undefined
}

interface BillingErrorEnvelope {
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
      armStepUp(host)
      return
    case 'no_payment_method':
      sys(
        '💳 No saved card for terminal charges yet. Set one up on the portal (one-time credit buys don’t save a reusable card).'
      )
      break
    case 'cli_billing_disabled':
      sys('🔴 Terminal billing is turned off for this org — an admin must enable it on the portal.')
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

/** 403 insufficient_scope → arm a confirm that runs the lazy step-up device flow. */
function armStepUp(host: BillingHost): void {
  const sys = host.pushSystem
  sys('💳 Terminal billing needs an extra permission (billing:manage).')
  host.confirm('Grant terminal billing access? An org admin/owner must allow terminal billing in the portal.', () => {
    // session_id lets the gateway route the verification link back to this
    // session (the device flow runs headless in the gateway).
    host
      .request('billing.step_up', { session_id: host.sessionId() })
      .then(raw => {
        const r = raw as BillingMutationResponse
        if (r.ok && r.granted) {
          sys('✅ Billing permission granted.')
          // Step-up grants the TOKEN scope only; the ORG kill-switch is a
          // separate gate. Re-fetch /state so we don't over-promise "enabled".
          host
            .request('billing.state', {})
            .then(sraw => {
              const s = sraw as BillingStateResponse
              if (s.cli_billing_enabled) {
                sys('Run /billing again to continue.')
              } else {
                sys(
                  '🟡 Permission granted, but terminal billing is still turned off for this org. Enable it in the portal, then run /billing again.'
                )
                if (s.portal_url) sys(`Portal: ${s.portal_url}`)
              }
            })
            .catch(() => sys('Run /billing again to continue.'))
        } else {
          sys('🟡 Terminal billing was not granted (an admin must allow it).')
        }
      })
      .catch(() => {
        // The device flow can outlive the RPC timeout while the user authorizes
        // in the browser. A reject here is NOT a hard failure — the grant (if it
        // lands) is persisted gateway-side; tell the user to re-run.
        sys('🟡 Still waiting on approval — finish in the browser, then run /billing again.')
      })
  })
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
            '🟡 Still processing after 5 minutes — this is a timeout, not a failure. Check /billing or the portal shortly.'
          )
          if (portalUrl) sys(`Portal: ${portalUrl}`)
          return
        }
        setTimeout(tick, POLL_INTERVAL_MS)
      })
      .catch(() => sys('🔴 Could not check the charge (request failed).'))
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
    charge: (amount: string) => {
      host.pushSystem('💳 Charge submitted — confirming settlement…')
      host
        .request('billing.charge', { amount_usd: amount })
        .then(raw => {
          const r = raw as BillingChargeResponse
          if (r.ok && r.charge_id) pollCharge(host, r.charge_id, s.portal_url)
          else renderBillingError(host, r)
        })
        .catch(() => host.pushSystem('🔴 Charge failed (request error).'))
    },
    openPortal: (url: string) => {
      // Try the browser; whether or not the spawn lands, always print the URL so
      // a headless/remote terminal user can copy it (Ink parity).
      openExternalUrl(url)
      host.pushSystem(`Opening portal: ${url}`)
    },
    sys: host.pushSystem,
    validate: (raw: string) => validateAmount(raw, s)
  }
}
