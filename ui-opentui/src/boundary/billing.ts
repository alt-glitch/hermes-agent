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
  display?: string
  resolved_via?: null | string
}

export interface UsageBarData {
  kind: 'plan' | 'topup'
  remaining_display: string
  total_display: string
  spent_display: string
  pct_used: null | number
  fill_fraction: number
}

export interface UsageModelData {
  available: boolean
  status?: string
  has_topup?: boolean
  plan_name?: null | string
  renews_display?: null | string
  total_spendable_display?: null | string
  plan_bar?: null | UsageBarData
  topup_bar?: null | UsageBarData
}

export interface BillingMonthlyCap {
  is_default_ceiling: boolean
  limit_display: string
  limit_usd: string | null
  spent_display: string
  spent_this_month_usd: string | null
}

export interface BillingAutoReload {
  card?:
    | { kind: 'canonical' }
    | { kind: 'distinct'; payment_method_id: string; brand: null | string; last4: null | string }
    | { kind: 'none' }
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
  can_change_plan?: boolean
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
  usage?: UsageModelData
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
  actor?: string
  code?: string
  error?: string
  granted?: boolean
  message?: string
  ok: boolean
  payload?: BillingErrorPayload | Record<string, unknown>
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
  /** POST `billing.charge` then poll `billing.charge_status` to settlement. */
  charge: (amount: string, idempotencyKey?: string) => Promise<BillingChargeOutcome>
  /** POST `billing.auto_reload`; resolves true on success (false → error already surfaced). */
  applyAutoReload: (enabled: boolean, threshold?: number, topUp?: number) => Promise<boolean>
  requestRemoteSpending: () => Promise<boolean>
  refreshState: () => Promise<BillingStateResponse | null>
  /** Open the Nous portal in the browser + note it in the transcript. */
  openPortal: (url: string) => void
  /** Push a system/transcript line (charge progress, errors, confirmations). */
  sys: (text: string) => void
  /** Validate a custom amount against state bounds + 2dp (mirrors the server). */
  validate: (raw: string) => AmountValidation
}

/** The overlay's screens (a self-contained state machine). */
export type BillingScreen = 'overview' | 'buy' | 'confirm' | 'autoreload' | 'limit' | 'stepup'

export type BillingChargeOutcome = 'submitted' | 'needs_remote_spending' | 'error'

/** The open `/topup` overlay (undefined when closed). */
export interface BillingOverlayState {
  ctx: BillingCtx
  screen: BillingScreen
  state: BillingStateResponse
  /** The amount carried from Buy → Confirm; null when not confirming. */
  pendingCharge: { amount: string; idempotencyKey?: string } | null
}

export interface SubscriptionTierOption {
  tier_id: string
  name: string
  tier_order: number
  dollars_per_month_display: string
  monthly_credits: string | null
  is_current: boolean
  is_enabled: boolean
}

export interface SubscriptionStateResponse {
  ok: boolean
  logged_in: boolean
  is_admin: boolean
  can_change_plan: boolean
  org_name: string | null
  org_id: string | null
  role: string | null
  context: 'personal' | 'team'
  current: null | {
    tier_id: string | null
    tier_name: string | null
    monthly_credits: string | null
    credits_remaining: string | null
    cycle_ends_at: string | null
    pending_downgrade_tier_name: string | null
    pending_downgrade_at: string | null
    pending_downgrade_display: string | null
    cancel_at_period_end: boolean
    cancellation_effective_at: string | null
    cancellation_effective_display: string | null
  }
  tiers: SubscriptionTierOption[]
  portal_url: string | null
  error?: string | null
  usage?: UsageModelData
}

/** Build the browser hand-off URL without trusting the gateway's billing path.
 * org_id and an optional plan tier coexist as ordinary query parameters. */
export function buildManageSubscriptionUrl(state: SubscriptionStateResponse, tierId?: string): string | null {
  try {
    if (!state.portal_url) return null
    const url = new URL('/manage-subscription', new URL(state.portal_url).origin)
    if (state.org_id) url.searchParams.set('org_id', state.org_id)
    if (tierId) url.searchParams.set('plan', tierId)
    return url.toString()
  } catch {
    return null
  }
}

export interface SubscriptionPreviewResponse extends BillingMutationResponse {
  effect?: 'charge_now' | 'scheduled' | 'no_op' | 'blocked'
  reason?: string | null
  target_tier_id?: string | null
  target_tier_name?: string | null
  monthly_credits_delta?: string | null
  amount_due_now_cents?: number | null
  effective_at?: string | null
}

export interface SubscriptionUpgradeResponse extends BillingMutationResponse {
  status?: 'upgraded' | 'already_on_tier' | 'requires_action' | 'payment_failed'
  target_tier_name?: string | null
  recovery_url?: string | null
  reason?: string | null
  idempotency_key?: string
}

export type SubscriptionScreen = 'confirm' | 'overview' | 'picker' | 'result' | 'stepup'
export type SubscriptionStepUpRetry = { kind: 'apply' } | { kind: 'preview'; tierId: string } | { kind: 'resume' }
export interface SubscriptionPendingChange {
  targetTierId: string | null
  kind: 'cancellation' | 'tier_change' | 'upgrade'
  preview?: SubscriptionPreviewResponse | null
  idempotencyKey?: string
}
export interface SubscriptionResult {
  message: string
  ok: boolean
  pendingTierId?: string | null
  recoveryUrl?: string | null
}
export interface SubscriptionCtx {
  fetchCard: () => Promise<BillingCardInfo | null>
  openManageLink: (tierId?: string) => Promise<boolean>
  openPortal: (url: string) => void
  preview: (tierId: string) => Promise<SubscriptionPreviewResponse | null>
  refreshState: () => Promise<SubscriptionStateResponse | null>
  requestRemoteSpending: () => Promise<{ granted: boolean; error?: string; message?: string }>
  resume: () => Promise<BillingMutationResponse | null>
  scheduleCancellation: () => Promise<BillingMutationResponse | null>
  scheduleChange: (tierId: string) => Promise<BillingMutationResponse | null>
  sys: (text: string) => void
  upgrade: (tierId: string, idempotencyKey?: string) => Promise<SubscriptionUpgradeResponse | null>
}
export interface SubscriptionOverlayState {
  ctx: SubscriptionCtx
  pending?: SubscriptionPendingChange | null
  result?: SubscriptionResult | null
  screen: SubscriptionScreen
  state: SubscriptionStateResponse
  stepUpRetry?: SubscriptionStepUpRetry | null
}
