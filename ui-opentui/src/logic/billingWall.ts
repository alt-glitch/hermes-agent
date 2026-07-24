/**
 * Billing wall (out of credits / payment required) — pure copy + recovery-action
 * logic for the confirm dialog the store opens on a `message.complete` carrying
 * `payload.billing` (port of Ink `ui-tui/src/lib/billingDialog.ts` +
 * `createGatewayEventHandler`'s onConfirm routing, upstream 9c274db89ff).
 *
 * The dialog is the actionable layer — the full provider guidance already lands
 * in the transcript via the completion text — so `detail` stays to one concise,
 * non-truncating line and the confirm carries the ONE recovery: Nous → `/topup`
 * (the native billing overlay), other providers → their billing page through
 * the safe external-URL boundary, or `/model` to switch when there's no URL.
 * Pure + exported so wording and routing are unit-tested without a gateway.
 */
import { openExternalUrl, parseSafeUrl } from '../boundary/openExternalUrl.ts'
import type { BillingBlockDecoded } from '../boundary/schema/GatewayEvent.ts'
import type { ConfirmSpec } from './store.ts'

/** Concise dialog copy for the out-of-credits confirm (Ink billingDialogCopy). */
export function billingWallCopy(block: BillingBlockDecoded): ConfirmSpec {
  if (block.is_nous) {
    return {
      cancelLabel: 'Dismiss',
      confirmLabel: 'Top up',
      detail: 'Your Nous credit balance is exhausted — top up to keep going.',
      title: 'Out of Nous credits'
    }
  }

  const label = block.provider_label || 'your provider'

  return {
    cancelLabel: 'Dismiss',
    confirmLabel: billingWallUrl(block) ? 'Open billing page' : 'Switch provider',
    detail: `${label} reports your credits or billing are exhausted.`,
    title: `Out of credits · ${label}`
  }
}

/** The one recovery the confirm's Yes performs. */
export type BillingWallAction = { kind: 'slash'; command: string } | { kind: 'url'; url: string }

/** The block's billing URL, but ONLY when it passes the safe-URL boundary
 *  (http(s), well-formed, real hostname) — a hostile/garbled URL degrades to
 *  the `/model` recovery instead of reaching a browser. */
function billingWallUrl(block: BillingBlockDecoded): string | undefined {
  if (!block.billing_url) return undefined
  return parseSafeUrl(block.billing_url)?.toString()
}

/** Route the recovery: Nous → `/topup` (opens the native billing overlay via the
 *  slash ladder), a safe third-party URL → open it, anything else → `/model`. */
export function billingWallAction(block: BillingBlockDecoded): BillingWallAction {
  if (block.is_nous) return { command: '/topup', kind: 'slash' }
  const url = billingWallUrl(block)
  if (url) return { kind: 'url', url }
  return { command: '/model', kind: 'slash' }
}

/** Host capabilities the action executor needs. `submitSlash` is the composer's
 *  slash ladder (entry-owned, registered on the store at boot); `openUrl`
 *  defaults to the safe external-URL boundary. Missing capabilities degrade to
 *  an honest transcript line instead of a silent no-op. */
export interface BillingWallHost {
  readonly pushSystem: (text: string) => void
  readonly submitSlash?: (command: string) => void
  readonly openUrl?: (url: string) => boolean
}

/** Execute a billing-wall recovery action against the host. */
export function runBillingWallAction(action: BillingWallAction, host: BillingWallHost): void {
  if (action.kind === 'url') {
    const opened = (host.openUrl ?? openExternalUrl)(action.url)
    // Headless/remote terminals can't spawn a browser — always leave the URL
    // where the user can copy it (Ink /subscription openPortal parity).
    if (!opened) host.pushSystem(`Could not open browser — visit ${action.url}`)
    return
  }
  if (host.submitSlash) host.submitSlash(action.command)
  else host.pushSystem(`Run ${action.command} to continue.`)
}
