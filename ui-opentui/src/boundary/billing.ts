/**
 * Terminal billing — the gateway RPC contract + the overlay's host-capability
 * bundle. Ported from the Ink TUI (`gatewayTypes.ts` billing block +
 * `app/slash/commands/billing.ts`) onto the OpenTUI engine.
 *
 * The gateway is the source of truth for these shapes (Python
 * `tui_gateway/server.py` `billing.*` RPCs); these interfaces mirror what it
 * returns so the Solid overlay can render + route keys without re-deriving
 * anything. ALL RPC + error-mapping logic lives in the slash opener
 * (`logic/billing.ts`) and is reached through `BillingCtx` — the view only
 * renders + routes keys (Ink parity).
 */

export interface BillingCardInfo {
  brand: string
  last4: string
  masked: string
}

export interface BillingMonthlyCap {
  is_default_ceiling: boolean
  limit_display: string
  limit_usd: string | null
  spent_display: string
  spent_this_month_usd: string | null
}

export interface BillingAutoReload {
  enabled: boolean
  reload_to_display: string
  reload_to_usd: string | null
  threshold_display: string
  threshold_usd: string | null
}

/** `billing.state` — the full snapshot the overview/buy/auto-reload screens read. */
export interface BillingStateResponse {
  auto_reload: BillingAutoReload | null
  balance_display: string
  balance_usd: string | null
  can_charge: boolean
  card: BillingCardInfo | null
  charge_presets: string[]
  charge_presets_display: string[]
  cli_billing_enabled: boolean
  error?: string | null
  is_admin: boolean
  logged_in: boolean
  max_usd: string | null
  min_usd: string | null
  monthly_cap: BillingMonthlyCap | null
  ok: boolean
  org_name: string | null
  portal_url: string | null
  role: string | null
}

/** Extra fields a few error codes attach (`_serialize_billing_error`). */
export interface BillingErrorPayload {
  isDefaultCeiling?: boolean
  remainingUsd?: string
}

export interface BillingChargeResponse {
  charge_id?: string
  error?: string
  idempotency_key?: string
  message?: string
  ok: boolean
  payload?: BillingErrorPayload
  portal_url?: string | null
  retry_after?: number | null
}

export interface BillingChargeStatusResponse {
  amount_usd?: string | null
  error?: string
  message?: string
  ok: boolean
  payload?: BillingErrorPayload
  portal_url?: string | null
  reason?: string | null
  retry_after?: number | null
  settled_at?: string | null
  status?: string
}

export interface BillingMutationResponse {
  error?: string
  granted?: boolean
  message?: string
  ok: boolean
  payload?: BillingErrorPayload
  portal_url?: string | null
  retry_after?: number | null
}

/** Result of validating a typed dollar amount against the state bounds. */
export interface AmountValidation {
  amount?: string
  error?: string
}

/**
 * The closure bundle the BillingOverlay needs to talk to the gateway and emit
 * transcript lines. Built once by the slash opener (single source of truth for
 * RPC + error mapping); the overlay only renders + routes keys.
 */
export interface BillingCtx {
  /** POST `billing.charge` then poll `billing.charge_status` to settlement (non-blocking). */
  charge: (amount: string) => void
  /** POST `billing.auto_reload`; resolves true on success (false → error already surfaced). */
  applyAutoReload: (enabled: boolean, threshold?: number, topUp?: number) => Promise<boolean>
  /** Open the Nous portal in the browser + note it in the transcript. */
  openPortal: (url: string) => void
  /** Push a system/transcript line (charge progress, errors, confirmations). */
  sys: (text: string) => void
  /** Validate a custom amount against state bounds + 2dp (mirrors the server). */
  validate: (raw: string) => AmountValidation
}

/** The overlay's screens (a self-contained state machine). */
export type BillingScreen = 'overview' | 'buy' | 'confirm' | 'autoreload' | 'limit'

/** The open `/billing` overlay (undefined when closed). */
export interface BillingOverlayState {
  ctx: BillingCtx
  screen: BillingScreen
  state: BillingStateResponse
  /** The amount carried from Buy → Confirm; null when not confirming. */
  pendingCharge: { amount: string } | null
}
