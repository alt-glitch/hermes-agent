/**
 * Present the out-of-band billing device-flow verification event. The gateway
 * is headless, so the renderer process is the only place that can both show the
 * URL/code and ask the desktop to open it.
 */
import { openExternalUrl, parseSafeUrl } from '../boundary/openExternalUrl.ts'

export interface BillingVerificationPayload {
  readonly verification_url: string
  readonly user_code?: string
}

export interface BillingVerificationHost {
  readonly pushSystem: (text: string) => void
  readonly openUrl?: (url: string) => boolean
}

/** Returns false for an empty, malformed, or non-http(s) URL. */
export function presentBillingVerification(
  payload: BillingVerificationPayload,
  host: BillingVerificationHost
): boolean {
  const parsed = parseSafeUrl(payload.verification_url)
  if (!parsed) return false

  const url = parsed.toString()
  host.pushSystem('💳 Open this link to allow Remote Spending:')
  host.pushSystem(url)
  if (payload.user_code) host.pushSystem(`If prompted, enter code: ${payload.user_code}`)
  const openUrl = host.openUrl ?? openExternalUrl
  openUrl(url)
  return true
}
