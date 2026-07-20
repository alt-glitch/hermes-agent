/**
 * BillingOverlay — the `/topup` modal, ported from the Ink TUI
 * (`components/billingOverlay.tsx`) onto OpenTUI Solid. A self-contained state
 * machine: overview → buy → confirm, plus autoreload + limit. Esc from a
 * sub-screen returns to overview; Esc from overview closes.
 *
 * ALL RPCs + error mapping live in `logic/billing.ts` and are reached through
 * `overlay.ctx`; this view only renders + routes keys (Ink parity). Screen
 * transitions go through the store (`patchBilling`/`closeBilling`) so the open
 * overlay survives the composer unmounting.
 *
 * Engine idioms (vs. Ink): `useState`→`createSignal` (call the getter),
 * `useInput`→`useKeyboard` (key.name), `<Box>`→`<box style>`, `<Text>`→`<text>`,
 * `<Show>/<Switch>` for conditionals. The two auto-reload fields use native
 * `<input>`s with the picker's global-key-handler `preventDefault` pattern so
 * navigation keys never double as cursor edits.
 */
import { randomUUID } from 'node:crypto'

import type { BoxRenderable, InputRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createMemo, createSignal, For, type JSXElement, onMount, Show } from 'solid-js'

import type { BillingOverlayState, BillingStateResponse } from '../../boundary/billing.ts'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'
import { UsageBars } from './usageBars.tsx'

/** A numbered menu row with the ▸ cursor. */
function MenuRow(props: { active: boolean; index: number; label: string }): JSXElement {
  const c = () => useTheme()().color
  return (
    <text bg={props.active ? c().selectionBg : 'transparent'} selectable={false}>
      <span style={{ fg: props.active ? c().label : c().muted }}>
        {props.active ? '▸ ' : '  '}
        {`${props.index}. ${props.label}`}
      </span>
    </text>
  )
}

/** Plain (non-numbered) action row with the ▸ cursor (confirm screens). */
function ActionRow(props: { active: boolean; label: string; color?: string }): JSXElement {
  const c = () => useTheme()().color
  return (
    <text selectable={false}>
      <span style={{ fg: props.active ? c().accent : c().muted }}>{props.active ? '▸ ' : '  '}</span>
      <span style={{ fg: props.active ? (props.color ?? c().text) : c().muted }}>{props.label}</span>
    </text>
  )
}

function autoReloadLine(s: BillingStateResponse): null | string {
  if (!s.auto_reload) return null
  return s.auto_reload.enabled
    ? `Auto-reload: on (below ${s.auto_reload.threshold_display} → ${s.auto_reload.reload_to_display})`
    : 'Auto-reload: off'
}

export function BillingOverlay(props: {
  overlay: BillingOverlayState
  onPatch: (next: Partial<BillingOverlayState>) => void
  onClose: () => void
}): JSXElement {
  const theme = useTheme()
  let rootRef: BoxRenderable | undefined
  const screen = () => props.overlay.screen
  // Esc/Ctrl+C close via the native keymap, scoped focus-within to the root box.
  useCloseLayer(
    () => rootRef,
    () => {
      if (screen() === 'overview') props.onClose()
    }
  )
  onMount(() => rootRef?.focus())

  return (
    <box
      ref={el => (rootRef = el)}
      focusable
      style={{
        borderColor: theme().color.accent,
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
        paddingLeft: 1,
        paddingRight: 1
      }}
      border
    >
      <Show when={screen() === 'overview'}>
        <OverviewScreen overlay={props.overlay} onPatch={props.onPatch} onClose={props.onClose} />
      </Show>
      <Show when={screen() === 'buy'}>
        <BuyScreen overlay={props.overlay} onPatch={props.onPatch} onClose={props.onClose} />
      </Show>
      <Show when={screen() === 'confirm'}>
        <ConfirmScreen
          amount={props.overlay.pendingCharge?.amount ?? ''}
          overlay={props.overlay}
          onBack={() => props.onPatch({ pendingCharge: null, screen: 'buy' })}
          onClose={props.onClose}
          onPatch={props.onPatch}
        />
      </Show>
      <Show when={screen() === 'autoreload'}>
        <AutoReloadScreen overlay={props.overlay} onPatch={props.onPatch} onClose={props.onClose} />
      </Show>
      <Show when={screen() === 'limit'}>
        <LimitScreen overlay={props.overlay} onPatch={props.onPatch} onClose={props.onClose} />
      </Show>
      <Show when={screen() === 'stepup'}>
        <StepUpScreen overlay={props.overlay} onClose={props.onClose} />
      </Show>
    </box>
  )
}

interface ScreenProps {
  overlay: BillingOverlayState
  onPatch: (next: Partial<BillingOverlayState>) => void
  onClose: () => void
}

function Footer(props: { text: string }): JSXElement {
  const c = () => useTheme()().color
  return (
    <text fg={c().muted} selectable={false}>
      {props.text}
    </text>
  )
}

// ── Screen 1: Overview ──────────────────────────────────────────────────

function OverviewScreen(props: ScreenProps): JSXElement {
  const c = () => useTheme()().color
  // Read state/ctx reactively via getters (Solid idiom — same as picker.tsx
  // reading `props.items` live). The overlay state is fixed per `/billing` open,
  // but reading through a getter keeps reactivity correct if it ever isn't.
  const state = () => props.overlay.state
  const ctx = () => props.overlay.ctx

  // Full menu only for an admin with the kill-switch on; otherwise it collapses.
  const full = () => state().is_admin && state().cli_billing_enabled
  const note = () =>
    !state().is_admin
      ? 'Billing actions need an org admin/owner.'
      : !state().cli_billing_enabled
        ? 'Terminal billing is off for this org — enable it on the portal.'
        : null
  const items = createMemo(() =>
    full() ? ['Add funds', 'Auto-reload', 'Monthly limit', 'Manage on portal', 'Close'] : ['Manage on portal', 'Cancel']
  )

  const [sel, setSel] = createSignal(0)

  const choose = (i: number) => {
    const s = state()
    if (full()) {
      if (i === 0) props.onPatch({ screen: 'buy' })
      else if (i === 1) props.onPatch({ screen: 'autoreload' })
      else if (i === 2) props.onPatch({ screen: 'limit' })
      else if (i === 3) {
        if (s.portal_url) ctx().openPortal(s.portal_url)
        props.onClose()
      } else props.onClose()
    } else {
      if (i === 0 && s.portal_url) ctx().openPortal(s.portal_url)
      props.onClose()
    }
  }

  useKeyboard(key => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return props.onClose()
    if (key.name === 'up' && sel() > 0) return setSel(v => v - 1)
    if (key.name === 'down' && sel() < items().length - 1) return setSel(v => v + 1)
    if (key.name === 'return') return choose(sel())
    const n = Number.parseInt(key.name, 10)
    if (n >= 1 && n <= items().length) return choose(n - 1)
  })

  const auto = createMemo(() => autoReloadLine(state()))

  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={c().accent} selectable={false}>
        <b>{`Top up · balance ${state().balance_display}`}</b>
      </text>
      <UsageBars model={state().usage} />
      <Show when={auto()}>
        <text fg={c().muted} selectable={false}>
          {auto()}
        </text>
      </Show>
      <Show when={state().org_name}>
        <text
          fg={c().muted}
          selectable={false}
        >{`Org: ${state().org_name}${state().role ? ` · ${state().role}` : ''}`}</text>
      </Show>
      <Show when={note()}>
        <text fg={c().warn} selectable={false}>
          {note()}
        </text>
      </Show>
      <Show when={full()}>
        <text fg={c().muted} selectable={false}>
          {state().card
            ? `Card: ${state().card?.display ?? state().card?.masked}`
            : 'No saved card on file — “Add funds” walks you through adding one.'}
        </text>
      </Show>
      <text> </text>
      <For each={items()}>{(label, i) => <MenuRow active={sel() === i()} index={i() + 1} label={label} />}</For>
      <text> </text>
      <Footer text={`↑/↓ select · 1-${items().length} quick pick · Enter confirm · Esc close`} />
    </box>
  )
}

// ── Screen 2: Buy credits ───────────────────────────────────────────────

function BuyScreen(props: ScreenProps): JSXElement {
  const c = () => useTheme()().color
  const state = () => props.overlay.state
  const ctx = () => props.overlay.ctx
  const presets = () => state().charge_presets_display
  const rawPresets = () => state().charge_presets
  const noCard = () => !state().card
  const rows = createMemo(() =>
    noCard()
      ? ['Add a card on the portal', 'I’ve added it — check again', 'Back']
      : [...presets(), 'Custom amount…', 'Cancel']
  )
  const customIdx = () => presets().length

  const [sel, setSel] = createSignal(0)
  const [typing, setTyping] = createSignal(false)
  const [custom, setCustom] = createSignal('')
  const [error, setError] = createSignal<null | string>(null)
  const [checking, setChecking] = createSignal(false)
  let inputRef: InputRenderable | undefined

  const toConfirm = (amount: string) =>
    props.onPatch({ pendingCharge: { amount, idempotencyKey: randomUUID() }, screen: 'confirm' })

  const pickPreset = (i: number) => {
    const raw = (rawPresets()[i] ?? presets()[i] ?? '').replace(/^\$/, '').trim()
    const v = ctx().validate(raw)
    if (v.error || !v.amount) {
      setError(v.error ?? 'Invalid preset.')
      return
    }
    toConfirm(v.amount)
  }

  const submitCustom = (raw: string) => {
    const v = ctx().validate(raw)
    if (v.error || !v.amount) {
      setError(v.error ?? 'Invalid amount.')
      return
    }
    toConfirm(v.amount)
  }

  const choose = (i: number) => {
    if (noCard()) {
      if (i === 0) {
        const portalUrl = state().portal_url
        if (portalUrl) {
          ctx().openPortal(portalUrl)
          ctx().sys('Add a card on the billing page, then come back and pick “check again”.')
        } else setError('Could not build the portal link — is your portal configured?')
        return
      }
      if (i === 1) {
        if (checking()) return
        setChecking(true)
        void ctx()
          .refreshState()
          .then(fresh => {
            setChecking(false)
            if (!fresh) {
              setError('Could not refresh billing state — try again in a moment.')
              return
            }
            props.onPatch({ state: fresh })
            ctx().sys(
              fresh.card
                ? `✓ Card found: ${fresh.card.display ?? fresh.card.masked} — pick an amount.`
                : 'Still no card on file — finish adding it on the portal, then check again.'
            )
          })
        return
      }
      props.onPatch({ screen: 'overview' })
      return
    }
    if (i < presets().length) pickPreset(i)
    else if (i === customIdx()) {
      setError(null)
      setTyping(true)
      queueMicrotask(() => inputRef?.focus())
    } else props.onPatch({ screen: 'overview' })
  }

  useKeyboard(key => {
    if (key.name === 'escape') {
      if (typing()) {
        setTyping(false)
        setError(null)
        return
      }
      return props.onPatch({ screen: 'overview' })
    }
    if (typing()) {
      // The focused <input> owns text editing; Enter submits the custom amount.
      if (key.name === 'return') {
        key.preventDefault()
        return submitCustom(custom())
      }
      return
    }
    if (key.name === 'up' && sel() > 0) return setSel(v => v - 1)
    if (key.name === 'down' && sel() < rows().length - 1) return setSel(v => v + 1)
    if (key.name === 'return') return choose(sel())
    const n = Number.parseInt(key.name, 10)
    if (n >= 1 && n <= rows().length) return choose(n - 1)
  })

  const payLine = () => {
    const card = state().card
    return card ? `Payment: ${card.masked}` : 'No saved card on file'
  }

  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={c().accent} selectable={false}>
        <b>Add funds</b>
      </text>
      <text fg={c().muted} selectable={false}>
        {payLine()}
      </text>
      <Show when={noCard()}>
        <text fg={c().muted}>Add a card once on the portal; after that you can top up here.</text>
      </Show>
      <text> </text>
      <Show
        when={typing()}
        fallback={
          <>
            <For each={rows()}>{(label, i) => <MenuRow active={sel() === i()} index={i() + 1} label={label} />}</For>
            <Show when={error()}>
              <text fg={c().error} selectable={false}>
                {error()}
              </text>
            </Show>
            <text> </text>
            <Footer
              text={
                checking()
                  ? 'Checking for a card…'
                  : `↑/↓ select · 1-${rows().length} quick pick · Enter confirm · Esc back`
              }
            />
          </>
        }
      >
        <text fg={c().label} selectable={false}>
          Enter a custom amount:
        </text>
        <box style={{ flexDirection: 'row' }}>
          <text fg={c().label}>{'$ '}</text>
          <input
            ref={el => (inputRef = el)}
            focused
            onInput={setCustom}
            placeholder="100"
            placeholderColor={c().muted}
            textColor={c().text}
            cursorColor={c().accent}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            style={{ flexGrow: 1, minWidth: 0 }}
          />
        </box>
        <Show when={error()}>
          <text fg={c().error} selectable={false}>
            {error()}
          </text>
        </Show>
        <text> </text>
        <Footer text="Enter confirm · Esc back" />
      </Show>
    </box>
  )
}

// ── Screen 3: Confirm purchase ──────────────────────────────────────────

function ConfirmScreen(props: {
  amount: string
  overlay: BillingOverlayState
  onBack: () => void
  onClose: () => void
  onPatch: (next: Partial<BillingOverlayState>) => void
}): JSXElement {
  const c = () => useTheme()().color
  const state = () => props.overlay.state
  const ctx = () => props.overlay.ctx
  const [sel, setSel] = createSignal(0)
  // Re-entrancy guard: charge() is non-blocking and onClose() is deferred a tick
  // by the App, so a rapid second Enter/Y (or Enter+Y) could fire a SECOND charge
  // before the overlay unmounts. Guard so a double-press can't double-charge.
  // (The Ink reference lacks this; hardened here because it's a money path.)
  const [paying, setPaying] = createSignal(false)

  const pay = () => {
    if (paying()) return
    setPaying(true)
    void ctx()
      .charge(props.amount, props.overlay.pendingCharge?.idempotencyKey)
      .then(outcome => {
        if (outcome === 'needs_remote_spending') props.onPatch({ screen: 'stepup' })
        else props.onClose()
      })
  }

  useKeyboard(key => {
    if (paying()) return
    if (key.name === 'escape') return props.onBack()
    if (key.name === 'y') return pay()
    if (key.name === 'n') return props.onBack()
    if (key.name === 'up') return setSel(0)
    if (key.name === 'down') return setSel(1)
    if (key.name === 'return') return sel() === 0 ? pay() : props.onBack()
  })

  const payLine = () => {
    const card = state().card
    return card ? `Payment: ${card.masked}` : 'No saved card on file'
  }

  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={c().accent} selectable={false}>
        <b>Confirm purchase</b>
      </text>
      <text fg={c().text} selectable={false}>{`Total: $${props.amount}`}</text>
      <text fg={c().muted} selectable={false}>
        {payLine()}
      </text>
      <text fg={c().muted} selectable={false}>
        By confirming, you allow Nous Research to charge your card.
      </text>
      <text> </text>
      <ActionRow active={sel() === 0} color={c().ok} label={`Pay $${props.amount} now`} />
      <ActionRow active={sel() === 1} label="Cancel" />
      <text> </text>
      <Footer text={paying() ? 'Processing payment…' : '↑/↓ select · Enter confirm · Y/N quick · Esc back'} />
    </box>
  )
}

// ── Screen 4: Auto-reload (the 2-field form) ────────────────────────────

function StepUpScreen(props: { overlay: BillingOverlayState; onClose: () => void }): JSXElement {
  const c = () => useTheme()().color
  const ctx = () => props.overlay.ctx
  const amount = () => props.overlay.pendingCharge?.amount ?? ''
  const [phase, setPhase] = createSignal<'granted' | 'prompt' | 'resuming' | 'waiting'>('prompt')
  const [sel, setSel] = createSignal(0)
  let aborted = false

  const close = (message?: string) => {
    aborted = true
    if (message) ctx().sys(message)
    props.onClose()
  }
  const allow = () => {
    if (phase() !== 'prompt') return
    setPhase('waiting')
    ctx().sys('Opening your browser to enable terminal billing…')
    void ctx()
      .requestRemoteSpending()
      .then(granted => {
        if (aborted) return
        if (granted) setPhase('granted')
        else
          close(
            "! Couldn't enable terminal billing — someone with billing permissions must approve it. Your card was not charged."
          )
      })
  }
  const resume = () => {
    if (phase() !== 'granted') return
    setPhase('resuming')
    ctx().sys('✓ Terminal billing enabled — resuming your purchase.')
    void ctx()
      .charge(amount(), props.overlay.pendingCharge?.idempotencyKey)
      .then(outcome => {
        if (aborted) return
        if (outcome === 'needs_remote_spending') {
          ctx().sys('! Terminal billing still needs approval — run /topup to try again. Your card was not charged.')
        }
        props.onClose()
      })
  }

  useKeyboard(key => {
    if (phase() === 'resuming') return
    if (phase() === 'waiting') {
      if (key.name === 'escape') close()
      return
    }
    if (phase() === 'granted') {
      if (key.name === 'escape') close('No charge made. Run /topup when you want to continue.')
      else if (key.name === 'return') resume()
      return
    }
    if (key.name === 'escape' || key.name === 'n') {
      close('No charge made. Run /topup when you want to enable terminal billing.')
      return
    }
    if (key.name === 'y') return allow()
    if (key.name === 'up') return setSel(0)
    if (key.name === 'down') return setSel(1)
    if (key.name === 'return') return sel() === 0 ? allow() : close('No charge made.')
  })

  return (
    <box style={{ flexDirection: 'column' }}>
      <Show when={phase() === 'prompt'}>
        <text fg={c().warn}>
          <b>One-time setup</b>
        </text>
        <text fg={c().text}>To charge this terminal, enable terminal billing once.</text>
        <text fg={c().muted}>{`It opens your browser to authorize, then your $${amount()} top-up resumes here.`}</text>
        <text> </text>
        <ActionRow active={sel() === 0} color={c().ok} label="Enable terminal billing" />
        <ActionRow active={sel() === 1} label="Not now" />
        <Footer text="↑/↓ select · Enter confirm · Y/N quick · Esc cancel" />
      </Show>
      <Show when={phase() === 'waiting'}>
        <text fg={c().accent}>
          <b>Enable terminal billing</b>
        </text>
        <text fg={c().warn}>Waiting for your browser…</text>
        <text fg={c().muted}>{`Your $${amount()} top-up is held here and resumes when you’re done.`}</text>
        <Footer text="Esc cancel" />
      </Show>
      <Show when={phase() === 'granted'}>
        <text fg={c().ok}>
          <b>Terminal billing enabled</b>
        </text>
        <text fg={c().text}>{`Your $${amount()} top-up is ready to finish.`}</text>
        <ActionRow active color={c().ok} label="Press Enter to resume" />
        <Footer text="Enter resume · Esc cancel" />
      </Show>
      <Show when={phase() === 'resuming'}>
        <text fg={c().accent}>
          <b>Enable terminal billing</b>
        </text>
        <text fg={c().muted}>{`Resuming your $${amount()} top-up…`}</text>
      </Show>
    </box>
  )
}

function AutoReloadScreen(props: ScreenProps): JSXElement {
  const c = () => useTheme()().color
  const state = () => props.overlay.state
  const ctx = () => props.overlay.ctx
  const ar = () => state().auto_reload
  const enabled = () => Boolean(ar()?.enabled)
  const noCard = () => !state().card
  const distinctCard = () => {
    const card = ar()?.card
    return card?.kind === 'distinct' ? card : null
  }
  const distinctCardName = () => {
    const card = distinctCard()
    if (!card) return null
    return [card.brand, card.last4 ? `••${card.last4}` : null].filter(Boolean).join(' ') || 'a different card'
  }
  const manageCardLabel = 'Use your card on file — manage on portal'

  const prefill = (raw?: null | string) => (raw == null ? '' : String(raw).replace(/^\$/, '').trim())
  // Seed the field signals from the existing config ONCE at construction (the
  // signals are the source of truth thereafter; the <input> `value` is init-only).
  const [threshold, setThreshold] = createSignal(prefill(ar()?.threshold_usd))
  const [reloadTo, setReloadTo] = createSignal(prefill(ar()?.reload_to_usd))
  const [error, setError] = createSignal<null | string>(null)
  const FIELD_ROWS = 2
  const actionRows = createMemo(() => {
    const manage = distinctCard() && state().portal_url ? [manageCardLabel] : []
    return enabled()
      ? ['Agree and turn on', 'Turn off', ...manage, 'Cancel']
      : ['Agree and turn on', ...manage, 'Cancel']
  })
  // row: 0=threshold field, 1=reloadTo field, 2..=action rows
  const [row, setRow] = createSignal(0)
  let thresholdRef: InputRenderable | undefined
  let reloadRef: InputRenderable | undefined

  const editingField = () => row() < FIELD_ROWS

  const focusRow = (r: number) => {
    if (r === 0) thresholdRef?.focus()
    else if (r === 1) reloadRef?.focus()
    else {
      thresholdRef?.blur()
      reloadRef?.blur()
    }
  }

  const validatePair = (): null | { reloadTo: string; threshold: string } => {
    const tv = ctx().validate(threshold())
    if (tv.error || !tv.amount) {
      setError(`Threshold: ${tv.error ?? 'invalid'}`)
      return null
    }
    const rv = ctx().validate(reloadTo())
    if (rv.error || !rv.amount) {
      setError(`Reload-to: ${rv.error ?? 'invalid'}`)
      return null
    }
    if (Number(rv.amount) <= Number(tv.amount)) {
      setError('Reload-to amount must be greater than the threshold.')
      return null
    }
    setError(null)
    return { reloadTo: rv.amount, threshold: tv.amount }
  }

  const turnOn = () => {
    const billingCtx = ctx()
    if (noCard()) {
      billingCtx.sys('🔴 No saved card — set one up on the portal first.')
      const url = state().portal_url
      if (url) billingCtx.openPortal(url)
      props.onClose()
      return
    }
    const pair = validatePair()
    if (!pair) return
    void billingCtx.applyAutoReload(true, Number(pair.threshold), Number(pair.reloadTo)).then(ok => {
      if (ok) billingCtx.sys(`✅ Auto-reload on: below $${pair.threshold} → reload to $${pair.reloadTo}.`)
    })
    props.onClose()
  }

  const turnOff = () => {
    const billingCtx = ctx()
    const currentThreshold = Number(prefill(ar()?.threshold_usd)) || 0
    const currentReloadTo = Number(prefill(ar()?.reload_to_usd)) || 0
    void billingCtx.applyAutoReload(false, currentThreshold, currentReloadTo).then(ok => {
      if (ok) billingCtx.sys('✅ Auto-reload turned off.')
    })
    props.onClose()
  }

  const onAction = (label: string) => {
    if (label === 'Agree and turn on') turnOn()
    else if (label === 'Turn off') turnOff()
    else if (label === manageCardLabel) {
      const url = state().portal_url
      if (url) ctx().openPortal(url)
      props.onClose()
    } else props.onPatch({ screen: 'overview' })
  }

  onMount(() => focusRow(0))

  useKeyboard(key => {
    if (key.name === 'escape') return props.onPatch({ screen: 'overview' })
    // Up/Down move between fields and action rows; preventDefault keeps the move
    // from also nudging the focused input's cursor (picker pattern).
    if (key.name === 'up' && row() > 0) {
      key.preventDefault()
      const r = row() - 1
      setRow(r)
      focusRow(r)
      return
    }
    if (key.name === 'down' && row() < FIELD_ROWS + actionRows().length - 1) {
      key.preventDefault()
      const r = row() + 1
      setRow(r)
      focusRow(r)
      return
    }
    // Tab cycles between the two fields while editing.
    if (key.name === 'tab' && editingField()) {
      key.preventDefault()
      const r = row() === 0 ? 1 : 0
      setRow(r)
      focusRow(r)
      return
    }
    if (key.name === 'return') {
      if (editingField()) {
        // Enter in threshold → reload-to; in reload-to → the Agree action row.
        key.preventDefault()
        const r = row() === 0 ? 1 : FIELD_ROWS
        setRow(r)
        focusRow(r)
        return
      }
      key.preventDefault()
      return onAction(actionRows()[row() - FIELD_ROWS] ?? 'Cancel')
    }
    if (!editingField()) {
      const n = Number.parseInt(key.name, 10)
      const action = n >= 1 && n <= actionRows().length ? actionRows()[n - 1] : undefined
      if (action) return onAction(action)
    }
  })

  const cardLine = () => {
    const card = state().card
    return card ? `Card on file: ${card.display ?? card.masked}` : 'No saved card on file'
  }

  const chargeTarget = () => distinctCardName() ?? state().card?.display ?? state().card?.masked ?? 'your card'

  const fieldBox = (
    label: string,
    value: () => string,
    onChange: (v: string) => void,
    focused: () => boolean,
    bind: (el: InputRenderable) => void
  ) => (
    <box style={{ flexDirection: 'column' }}>
      <text fg={focused() ? c().label : c().muted} selectable={false}>
        {label}
      </text>
      <box
        style={{
          borderColor: focused() ? c().accent : c().border,
          flexDirection: 'row',
          paddingLeft: 1,
          paddingRight: 1
        }}
        border
      >
        <text fg={c().label}>{'$ '}</text>
        <input
          ref={el => bind(el)}
          value={value()}
          onInput={onChange}
          textColor={c().text}
          cursorColor={c().accent}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          style={{ flexGrow: 1, minWidth: 0 }}
        />
      </box>
    </box>
  )

  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={c().accent} selectable={false}>
        <b>Auto-reload</b>
      </text>
      <text fg={c().muted} selectable={false}>
        Automatically buy more credits when your balance is low.
      </text>
      <text fg={c().muted} selectable={false}>
        {cardLine()}
      </text>
      <Show when={distinctCardName()}>
        {name => <text fg={c().warn}>{`⚠ Auto-refill is charging ${name()} — not your card on file.`}</text>}
      </Show>
      <text> </text>
      {fieldBox(
        'When balance falls below:',
        threshold,
        setThreshold,
        () => row() === 0,
        el => (thresholdRef = el)
      )}
      {fieldBox(
        'Reload balance to:',
        reloadTo,
        setReloadTo,
        () => row() === 1,
        el => (reloadRef = el)
      )}
      <text> </text>
      <text fg={c().muted} selectable={false}>
        {`By confirming, you authorize Nous Research to charge ${chargeTarget()} whenever your balance falls below the threshold. Turn off any time here or on the portal.`}
      </text>
      <Show when={error()}>
        <text fg={c().error} selectable={false}>
          {error()}
        </text>
      </Show>
      <text> </text>
      <For each={actionRows()}>
        {(label, i) => (
          <ActionRow
            active={!editingField() && row() - FIELD_ROWS === i()}
            color={label === 'Turn off' ? c().warn : label === 'Agree and turn on' ? c().ok : c().text}
            label={label}
          />
        )}
      </For>
      <text> </text>
      <Footer text="↑/↓ move · Tab switch field · Enter next/confirm · Esc back" />
    </box>
  )
}

// ── Screen 5: Monthly spend limit (read-only) ───────────────────────────

function LimitScreen(props: ScreenProps): JSXElement {
  const c = () => useTheme()().color
  const state = () => props.overlay.state
  const ctx = () => props.overlay.ctx
  const rows = ['Manage on portal', 'Cancel']
  const [sel, setSel] = createSignal(0)

  const choose = (i: number) => {
    const url = state().portal_url
    if (i === 0 && url) {
      ctx().openPortal(url)
      return props.onClose()
    }
    props.onPatch({ screen: 'overview' })
  }

  useKeyboard(key => {
    if (key.name === 'escape') return props.onPatch({ screen: 'overview' })
    if (key.name === 'up' && sel() > 0) return setSel(v => v - 1)
    if (key.name === 'down' && sel() < rows.length - 1) return setSel(v => v + 1)
    if (key.name === 'return') return choose(sel())
    const n = Number.parseInt(key.name, 10)
    if (n >= 1 && n <= rows.length) return choose(n - 1)
  })

  const usageLine = () => {
    const cap = state().monthly_cap
    return cap && cap.limit_usd != null
      ? `${cap.spent_display} of ${cap.limit_display} used this month${cap.is_default_ceiling ? ' (default ceiling)' : ''}`
      : 'No monthly cap visible (managed on the portal).'
  }

  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={c().accent} selectable={false}>
        <b>Monthly spend limit</b>
      </text>
      <text fg={c().text} selectable={false}>
        {usageLine()}
      </text>
      <text fg={c().muted} selectable={false}>
        The monthly limit is set on the portal — shown here read-only.
      </text>
      <text> </text>
      <For each={rows}>{(label, i) => <MenuRow active={sel() === i()} index={i() + 1} label={label} />}</For>
      <text> </text>
      <Footer text={`↑/↓ select · 1-${rows.length} quick pick · Enter confirm · Esc back`} />
    </box>
  )
}
