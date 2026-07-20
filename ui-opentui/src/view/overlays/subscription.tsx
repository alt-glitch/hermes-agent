import { randomUUID } from 'node:crypto'

import type { BoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createSignal, For, type JSXElement, onCleanup, onMount, Show } from 'solid-js'

import type {
  BillingMutationResponse,
  SubscriptionOverlayState,
  SubscriptionPendingChange,
  SubscriptionPreviewResponse,
  SubscriptionResult,
  SubscriptionStateResponse,
  SubscriptionTierOption,
  SubscriptionUpgradeResponse
} from '../../boundary/billing.ts'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'
import { UsageBars } from './usageBars.tsx'

const UPGRADE_POLL_MS = 2000
const UPGRADE_POLL_ATTEMPTS = 15

function Row(props: { active: boolean; index?: number; label: string; color?: string }): JSXElement {
  const c = () => useTheme()().color
  return (
    <text bg={props.active ? c().selectionBg : 'transparent'} selectable={false}>
      <span style={{ fg: props.active ? c().accent : c().muted }}>{props.active ? '▸ ' : '  '}</span>
      <span style={{ fg: props.active ? (props.color ?? c().text) : c().muted }}>
        {props.index ? `${String(props.index)}. ` : ''}
        {props.label}
      </span>
    </text>
  )
}

function Footer(props: { text: string }): JSXElement {
  const c = () => useTheme()().color
  return <text fg={c().muted}>{props.text}</text>
}

function shortDate(value?: null | string): string {
  return value && value.length >= 10 ? value.slice(0, 10) : 'the end of the billing period'
}

function pendingTransition(current: SubscriptionStateResponse['current']): null | { to: string; when: string } {
  if (!current) return null
  if (current.cancel_at_period_end) {
    return {
      to: 'cancels',
      when: current.cancellation_effective_display ?? shortDate(current.cancellation_effective_at)
    }
  }
  if (current.pending_downgrade_tier_name) {
    return {
      to: current.pending_downgrade_tier_name,
      when: current.pending_downgrade_display ?? shortDate(current.pending_downgrade_at)
    }
  }
  return null
}

export function subscriptionStatusLine(state: SubscriptionStateResponse): string {
  const plan = state.current?.tier_name ?? state.usage?.plan_name ?? null
  const transition = pendingTransition(state.current)
  if (!plan) return 'Plan: Free · free models only'
  const flip = transition ? ` → ${transition.to}` : ''
  const left = state.usage?.total_spendable_display ? ` · ${state.usage.total_spendable_display} left` : ''
  const renews = state.usage?.renews_display ? ` · renews ${state.usage.renews_display}` : ''
  return `Plan: ${plan}${flip}${left}${state.can_change_plan ? renews : ' · view only'}`
}

function isScopeDenied(value: null | { error?: string; ok?: boolean }): boolean {
  return Boolean(value && !value.ok && value.error === 'insufficient_scope')
}

function failed(value: null | { error?: string; message?: string; portal_url?: null | string }): SubscriptionResult {
  return {
    message: value?.message || value?.error || 'Something went wrong. Try again, or manage on the portal.',
    ok: false,
    recoveryUrl: value?.portal_url ?? null
  }
}

function mutationResult(value: BillingMutationResponse | null, success: string): SubscriptionResult {
  return value?.ok ? { message: value.message || success, ok: true } : failed(value)
}

function upgradeResult(value: SubscriptionUpgradeResponse | null, tierId: string): SubscriptionResult {
  if (!value) {
    return {
      message:
        'Couldn’t confirm the upgrade — your card may or may not have been charged. Re-run /subscription before retrying.',
      ok: false
    }
  }
  if (value.reason === 'authentication_required' || value.reason === 'subscription_payment_intent_requires_action') {
    return {
      message: 'Please verify your card in the portal to finish this upgrade.',
      ok: false,
      recoveryUrl: value.recovery_url ?? null
    }
  }
  if (value.reason === 'card_declined') {
    return {
      message: 'Your card was declined — try a different card on the portal.',
      ok: false,
      recoveryUrl: value.recovery_url ?? null
    }
  }
  if (value.ok && value.status === 'already_on_tier') {
    return { message: `You are already on ${value.target_tier_name ?? 'this plan'}.`, ok: true }
  }
  if (value.ok && value.status === 'upgraded') {
    return {
      message: `Upgraded to ${value.target_tier_name ?? 'your new plan'}. Your new monthly credits land in a moment.`,
      ok: true,
      pendingTierId: tierId
    }
  }
  if (value.status === 'requires_action') {
    return {
      message: 'This upgrade needs extra verification (3DS). Finish it on the portal.',
      ok: false,
      recoveryUrl: value.recovery_url ?? null
    }
  }
  if (value.status === 'payment_failed') {
    return {
      message: 'Your card was declined. Update it on the portal and try again.',
      ok: false,
      recoveryUrl: value.recovery_url ?? null
    }
  }
  return failed(value)
}

export function SubscriptionOverlay(props: {
  overlay: SubscriptionOverlayState
  onPatch: (next: Partial<SubscriptionOverlayState>) => void
  onClose: () => void
}): JSXElement {
  const theme = useTheme()
  let root: BoxRenderable | undefined
  useCloseLayer(() => root, props.onClose)
  onMount(() => root?.focus())
  return (
    <box
      ref={el => (root = el)}
      focusable
      border
      style={{
        borderColor: theme().color.accent,
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <Show when={props.overlay.state.context === 'team'}>
        <TeamScreen overlay={props.overlay} onClose={props.onClose} />
      </Show>
      <Show when={props.overlay.state.context !== 'team' && props.overlay.screen === 'overview'}>
        <Overview overlay={props.overlay} onPatch={props.onPatch} onClose={props.onClose} />
      </Show>
      <Show when={props.overlay.state.context !== 'team' && props.overlay.screen === 'picker'}>
        <Picker overlay={props.overlay} onPatch={props.onPatch} />
      </Show>
      <Show when={props.overlay.state.context !== 'team' && props.overlay.screen === 'confirm'}>
        <Confirm overlay={props.overlay} onPatch={props.onPatch} onClose={props.onClose} />
      </Show>
      <Show when={props.overlay.state.context !== 'team' && props.overlay.screen === 'result'}>
        <Result overlay={props.overlay} onClose={props.onClose} />
      </Show>
      <Show when={props.overlay.state.context !== 'team' && props.overlay.screen === 'stepup'}>
        <StepUp overlay={props.overlay} onPatch={props.onPatch} />
      </Show>
    </box>
  )
}

function useRows(count: () => number, choose: (index: number) => void, back: () => void) {
  const [selected, setSelected] = createSignal(0)
  useKeyboard(key => {
    if (key.name === 'escape') return back()
    if (key.name === 'up') return setSelected(v => Math.max(0, v - 1))
    if (key.name === 'down') return setSelected(v => Math.min(count() - 1, v + 1))
    if (key.name === 'return') return choose(selected())
    const n = Number.parseInt(key.name, 10)
    if (n >= 1 && n <= count()) choose(n - 1)
  })
  return selected
}

function TeamScreen(props: { overlay: SubscriptionOverlayState; onClose: () => void }): JSXElement {
  const c = () => useTheme()().color
  const rows = ['Manage team billing on portal', 'Close']
  const choose = (i: number) => {
    if (i === 0) void props.overlay.ctx.openManageLink()
    props.onClose()
  }
  const selected = useRows(() => rows.length, choose, props.onClose)
  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={c().accent}>
        <b>Team billing</b>
      </text>
      <text fg={c().text}>This terminal uses team billing, not a personal subscription.</text>
      <text fg={c().muted}>Use /topup to view the shared balance or manage the plan on the portal.</text>
      <For each={rows}>{(label, i) => <Row active={selected() === i()} index={i() + 1} label={label} />}</For>
      <Footer text="↑/↓ select · Enter · Esc close" />
    </box>
  )
}

function Overview(props: {
  overlay: SubscriptionOverlayState
  onPatch: (next: Partial<SubscriptionOverlayState>) => void
  onClose: () => void
}): JSXElement {
  const c = () => useTheme()().color
  const state = () => props.overlay.state
  const current = () => state().current
  const transition = () => pendingTransition(current())
  const isFree = () => !current()?.tier_id
  const rows = () => {
    const values: Array<{ label: string; run: () => void }> = []
    if (state().can_change_plan && !isFree()) {
      if (transition()) {
        values.push({ label: `Keep ${current()?.tier_name ?? 'current plan'} (undo this change)`, run: resume })
        values.push({ label: 'Change plan', run: () => props.onPatch({ pending: null, screen: 'picker' }) })
      } else {
        values.push({ label: 'Change plan', run: () => props.onPatch({ pending: null, screen: 'picker' }) })
        values.push({
          label: 'Cancel subscription',
          run: () => props.onPatch({ pending: { kind: 'cancellation', targetTierId: null }, screen: 'confirm' })
        })
      }
    }
    values.push({ label: isFree() ? 'Start a subscription' : 'Manage on portal', run: manage })
    values.push({ label: 'Close', run: props.onClose })
    return values
  }
  let busy = false
  const manage = () => {
    void props.overlay.ctx.openManageLink()
    props.onClose()
  }
  const resume = () => {
    if (busy) return
    busy = true
    void props.overlay.ctx.resume().then(value => {
      if (isScopeDenied(value)) return props.onPatch({ screen: 'stepup', stepUpRetry: { kind: 'resume' } })
      props.onPatch({ result: mutationResult(value, 'Your pending change was undone.'), screen: 'result' })
    })
  }
  const selected = useRows(
    () => rows().length,
    i => rows()[i]?.run(),
    props.onClose
  )
  return (
    <box style={{ flexDirection: 'column' }}>
      <Show when={transition()}>
        {value => (
          <>
            <text fg={c().warn}>
              <b>⏳ Scheduled change</b>
            </text>
            <text fg={c().text}>{`${current()?.tier_name ?? 'Plan'} ──▶ ${value().to} · ${value().when}`}</text>
          </>
        )}
      </Show>
      <text fg={c().accent}>
        <b>{subscriptionStatusLine(state())}</b>
      </text>
      <UsageBars model={state().usage} />
      <Show when={isFree()}>
        <text fg={c().warn}>&gt; Paid models need a subscription.</text>
      </Show>
      <Show when={state().usage?.status === 'low'}>
        <text
          fg={c().warn}
        >{`! Low balance · ${state().usage?.total_spendable_display ?? 'under $5'} left. Top up or upgrade.`}</text>
      </Show>
      <Show when={state().org_name}>
        <text fg={c().muted}>{`Org: ${state().org_name}${state().role ? ` · ${state().role}` : ''}`}</text>
      </Show>
      <text> </text>
      <For each={rows()}>{(row, i) => <Row active={selected() === i()} index={i() + 1} label={row.label} />}</For>
      <Footer text="↑/↓ select · Enter confirm · Esc close" />
    </box>
  )
}

function Picker(props: {
  overlay: SubscriptionOverlayState
  onPatch: (next: Partial<SubscriptionOverlayState>) => void
}): JSXElement {
  const c = () => useTheme()().color
  const state = () => props.overlay.state
  const currentOrder = () => state().tiers.find(tier => tier.is_current)?.tier_order ?? 0
  const choices = () =>
    state()
      .tiers.filter(t => t.is_enabled && !t.is_current && t.tier_order > 0)
      .sort((a, b) => a.tier_order - b.tier_order)
  const rows = () => [...choices(), null]
  let busy = false
  const pick = (tier: SubscriptionTierOption) => {
    if (busy) return
    busy = true
    void props.overlay.ctx.preview(tier.tier_id).then(preview => {
      if (!preview)
        return props.onPatch({ result: { message: 'Could not preview that change.', ok: false }, screen: 'result' })
      if (!preview.ok) {
        if (isScopeDenied(preview))
          return props.onPatch({ screen: 'stepup', stepUpRetry: { kind: 'preview', tierId: tier.tier_id } })
        return props.onPatch({ result: failed(preview), screen: 'result' })
      }
      props.onPatch({
        pending: {
          ...(preview.effect === 'charge_now' ? { idempotencyKey: randomUUID() } : {}),
          kind: preview.effect === 'charge_now' ? 'upgrade' : 'tier_change',
          preview,
          targetTierId: tier.tier_id
        },
        screen: 'confirm'
      })
    })
  }
  const back = () => props.onPatch({ screen: 'overview' })
  const selected = useRows(
    () => rows().length,
    i => {
      const tier = rows()[i]
      if (tier) pick(tier)
      else back()
    },
    back
  )
  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={c().accent}>
        <b>Change plan</b>
      </text>
      <text fg={c().muted}>{`Current: ${state().current?.tier_name ?? 'Free'}. Pick a plan to preview it.`}</text>
      <For each={rows()}>
        {(tier, i) => (
          <Row
            active={selected() === i()}
            index={i() + 1}
            label={
              tier
                ? `${tier.name} · ${tier.dollars_per_month_display}/mo · ${tier.tier_order > currentOrder() ? 'upgrade' : 'downgrade'}`
                : 'Back'
            }
          />
        )}
      </For>
      <Footer text="↑/↓ select · Enter preview · Esc back" />
    </box>
  )
}

function applyPending(
  overlay: SubscriptionOverlayState,
  pending: SubscriptionPendingChange,
  patch: (next: Partial<SubscriptionOverlayState>) => void,
  allowStepUp = true
): void {
  const step = () =>
    allowStepUp
      ? patch({ screen: 'stepup', stepUpRetry: { kind: 'apply' } })
      : patch({
          result: { message: 'Terminal billing still isn’t enabled for this org.', ok: false },
          screen: 'result'
        })
  if (pending.kind === 'upgrade') {
    void overlay.ctx.upgrade(pending.targetTierId ?? '', pending.idempotencyKey).then(value => {
      if (isScopeDenied(value)) step()
      else patch({ result: upgradeResult(value, pending.targetTierId ?? ''), screen: 'result' })
    })
    return
  }
  const request =
    pending.kind === 'cancellation'
      ? overlay.ctx.scheduleCancellation()
      : overlay.ctx.scheduleChange(pending.targetTierId ?? '')
  void request.then(value => {
    if (isScopeDenied(value)) step()
    else patch({ result: mutationResult(value, 'Scheduled — nothing changes today.'), screen: 'result' })
  })
}

function Confirm(props: {
  overlay: SubscriptionOverlayState
  onPatch: (next: Partial<SubscriptionOverlayState>) => void
  onClose: () => void
}): JSXElement {
  const c = () => useTheme()().color
  const pending = () => props.overlay.pending ?? null
  const preview = () => pending()?.preview ?? null
  const cancellation = () => pending()?.kind === 'cancellation'
  const effect = () => (cancellation() ? 'scheduled' : (preview()?.effect ?? 'blocked'))
  const amount = () => {
    const cents = preview()?.amount_due_now_cents
    return typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : null
  }
  const [chargeCard, setChargeCard] = createSignal<null | string>(null)
  let cardRequest = 0
  createEffect(() => {
    if (cancellation() || effect() !== 'charge_now') return
    const request = ++cardRequest
    void props.overlay.ctx.fetchCard().then(card => {
      if (
        request === cardRequest &&
        card &&
        (card.resolved_via === 'subPin' || card.resolved_via === 'customerDefault')
      ) {
        setChargeCard(card.display ?? card.masked)
      }
    })
  })
  onCleanup(() => {
    cardRequest += 1
  })
  const back = () => props.onPatch({ pending: null, screen: cancellation() ? 'overview' : 'picker' })
  let submitting = false
  const apply = () => {
    const value = pending()
    if (!value || submitting) return
    submitting = true
    applyPending(props.overlay, value, props.onPatch)
  }
  const manage = () => {
    void props.overlay.ctx.openManageLink()
    props.onClose()
  }
  const rows = () => [
    effect() === 'blocked'
      ? 'Manage on portal'
      : cancellation()
        ? 'Cancel subscription'
        : effect() === 'charge_now'
          ? `Pay ${amount() ?? 'prorated amount'} & upgrade now`
          : `Schedule change to ${preview()?.target_tier_name ?? 'selected plan'}`,
    'Back'
  ]
  const selected = useRows(
    () => rows().length,
    i => (i === 1 ? back() : effect() === 'blocked' ? manage() : apply()),
    back
  )
  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={c().accent}>
        <b>{cancellation() ? 'Confirm cancellation' : 'Confirm plan change'}</b>
      </text>
      <Show when={submitting}>
        <text fg={c().muted}>Working…</text>
      </Show>
      <Show when={cancellation()}>
        <text
          fg={c().text}
        >{`Cancel ${props.overlay.state.current?.tier_name ?? 'your plan'} — it stays active until ${shortDate(props.overlay.state.current?.cycle_ends_at)}, then will not renew.`}</text>
      </Show>
      <Show when={!cancellation() && effect() === 'charge_now'}>
        <text
          fg={c().text}
        >{`Upgrade to ${preview()?.target_tier_name ?? 'the selected plan'}. You will be charged ${amount() ?? 'the prorated amount'} now.`}</text>
      </Show>
      <Show when={!cancellation() && effect() === 'charge_now'}>
        <text fg={c().muted}>
          {chargeCard()
            ? `${chargeCard()} — the card on your subscription — will be charged.`
            : 'The card on your subscription will be charged.'}
        </text>
      </Show>
      <Show when={!cancellation() && effect() === 'scheduled'}>
        <text
          fg={c().text}
        >{`Change to ${preview()?.target_tier_name ?? 'the selected plan'} — takes effect ${shortDate(preview()?.effective_at)}. No charge now.`}</text>
      </Show>
      <Show when={!cancellation() && effect() === 'no_op'}>
        <text fg={c().muted}>You are already on this plan — nothing to change.</text>
      </Show>
      <Show when={!cancellation() && effect() === 'blocked'}>
        <text fg={c().warn}>{preview()?.reason ?? 'Manage this change on the portal.'}</text>
      </Show>
      <For each={rows()}>{(label, i) => <Row active={selected() === i()} label={label} />}</For>
      <Footer text="↑/↓ select · Enter confirm · Esc back" />
    </box>
  )
}

function Result(props: { overlay: SubscriptionOverlayState; onClose: () => void }): JSXElement {
  const c = () => useTheme()().color
  const result = () => props.overlay.result
  const [applyState, setApplyState] = createSignal<'applying' | 'confirmed' | 'timed_out'>(
    result()?.pendingTierId ? 'applying' : 'confirmed'
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  const tick = () => {
    attempts += 1
    void props.overlay.ctx.refreshState().then(fresh => {
      if (fresh?.current?.tier_id === result()?.pendingTierId) setApplyState('confirmed')
      else if (attempts >= UPGRADE_POLL_ATTEMPTS) setApplyState('timed_out')
      else timer = setTimeout(tick, UPGRADE_POLL_MS)
    })
  }
  if (result()?.pendingTierId) timer = setTimeout(tick, UPGRADE_POLL_MS)
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  const rows = () => (result()?.recoveryUrl ? ['Open the portal to finish', 'Close'] : ['Close'])
  const choose = (i: number) => {
    const recoveryUrl = result()?.recoveryUrl
    if (i === 0 && recoveryUrl) props.overlay.ctx.openPortal(recoveryUrl)
    props.onClose()
  }
  const selected = useRows(() => rows().length, choose, props.onClose)
  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={result()?.ok ? c().ok : c().warn}>
        <b>
          {applyState() === 'applying'
            ? 'Applying…'
            : applyState() === 'timed_out'
              ? 'Still applying'
              : result()?.ok
                ? 'Done'
                : 'Could not complete'}
        </b>
      </text>
      <text fg={c().text}>
        {applyState() === 'timed_out'
          ? 'Your upgrade succeeded and is still applying — refresh in a moment.'
          : (result()?.message ?? '')}
      </text>
      <For each={rows()}>{(label, i) => <Row active={selected() === i()} label={label} />}</For>
      <Footer text="↑/↓ select · Enter · Esc close" />
    </box>
  )
}

function StepUp(props: {
  overlay: SubscriptionOverlayState
  onPatch: (next: Partial<SubscriptionOverlayState>) => void
}): JSXElement {
  const c = () => useTheme()().color
  const [phase, setPhase] = createSignal<'granted' | 'prompt' | 'resuming' | 'waiting'>('prompt')
  let started = false
  let aborted = false
  let resuming = false
  const denial = (value: { error?: string; message?: string }): SubscriptionResult => ({
    message:
      value.error === 'session_revoked'
        ? 'Your session expired — run /portal to log in again.'
        : value.error === 'rate_limited'
          ? 'Too many attempts — wait a moment, then try again.'
          : value.message || 'Someone with billing permissions must approve terminal billing.',
    ok: false
  })
  const enable = () => {
    if (started) return
    started = true
    setPhase('waiting')
    void props.overlay.ctx.requestRemoteSpending().then(value => {
      if (aborted) return
      if (value.granted) setPhase('granted')
      else props.onPatch({ result: denial(value), screen: 'result', stepUpRetry: null })
    })
  }
  const replay = () => {
    if (resuming || phase() !== 'granted') return
    resuming = true
    setPhase('resuming')
    const retry = props.overlay.stepUpRetry
    props.onPatch({ stepUpRetry: null })
    if (!retry) return props.onPatch({ screen: 'overview' })
    if (retry.kind === 'apply') {
      if (props.overlay.pending) applyPending(props.overlay, props.overlay.pending, props.onPatch, false)
      else props.onPatch({ screen: 'overview' })
      return
    }
    if (retry.kind === 'resume') {
      void props.overlay.ctx
        .resume()
        .then(value =>
          props.onPatch({ result: mutationResult(value, 'Your pending change was undone.'), screen: 'result' })
        )
      return
    }
    void props.overlay.ctx.preview(retry.tierId).then((preview: SubscriptionPreviewResponse | null) => {
      if (!preview?.ok) return props.onPatch({ result: failed(preview), screen: 'result' })
      props.onPatch({
        pending: {
          ...(preview.effect === 'charge_now' ? { idempotencyKey: randomUUID() } : {}),
          kind: preview.effect === 'charge_now' ? 'upgrade' : 'tier_change',
          preview,
          targetTierId: retry.tierId
        },
        screen: 'confirm'
      })
    })
  }
  useKeyboard(key => {
    if (key.name === 'escape') {
      aborted = true
      props.onPatch({ screen: 'overview', stepUpRetry: null })
      return
    }
    if (phase() === 'prompt' && (key.name === 'return' || key.name === 'y')) enable()
    else if (phase() === 'granted' && key.name === 'return') replay()
  })
  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={phase() === 'granted' ? c().ok : c().accent}>
        <b>{phase() === 'granted' ? 'Terminal billing enabled' : 'Enable terminal billing'}</b>
      </text>
      <text fg={c().text}>
        {phase() === 'prompt'
          ? 'Approve terminal billing once in your browser; the held plan change stays here.'
          : phase() === 'waiting'
            ? 'Waiting for your browser…'
            : phase() === 'granted'
              ? 'Press Enter to continue the held change.'
              : 'Resuming your plan change…'}
      </text>
      <Footer text={phase() === 'granted' ? 'Enter continue · Esc cancel' : 'Enter enable · Esc cancel'} />
    </box>
  )
}
