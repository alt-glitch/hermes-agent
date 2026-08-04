/**
 * Wake word ("Hey Hermes") — the TUI surface of the gateway's shared listener.
 * Native port of upstream Ink's wakeState.ts + slash/commands/wake.ts + the
 * createGatewayEventHandler wake wiring (86d5b8b90f, 71a2feeade), reproduced
 * for the OpenTUI engine: transport-free logic here, the entry injects the
 * RPC/session/store capabilities through {@link WakeHost}.
 */
import type {
  WakeStartResponse,
  WakeStatusResponse,
  WakeStopResponse
} from '../boundary/schema/SessionCommandResponses.ts'

// Process-scoped memory of an explicit `/wake off`.
//
// The entry auto-arms the listener on every `gateway.ready`. When the user
// explicitly disables it with `/wake off`, a reconnect must NOT silently
// re-arm — this module-level flag records that intent for the lifetime of the
// process; `/wake on` clears it. Deliberately not persisted here: config
// (`wake_word.*`) remains the durable switch (the gateway persists it on the
// explicit-gesture `persist: true` paths); this is only per-process steering.
let wakeUserDisabled = false

export const isWakeUserDisabled = (): boolean => wakeUserDisabled

export const setWakeUserDisabled = (disabled: boolean): void => {
  wakeUserDisabled = disabled
}

export const WAKE_USAGE = 'usage: /wake [on|off|status]'

const WAKE_SUBCOMMANDS = ['on', 'off', 'status'] as const
export type WakeSub = (typeof WAKE_SUBCOMMANDS)[number]

export const isWakeSub = (value: string): value is WakeSub => (WAKE_SUBCOMMANDS as readonly string[]).includes(value)

// Friendly text for the gateway's wake.start refusal codes. Unknown codes
// fall through to the raw reason so new server-side codes stay visible.
const START_REASON_TEXT: Record<string, string> = {
  disabled: 'disabled (config wake_word.enabled)',
  disabled_for_surface: 'scoped to another surface (config wake_word.surface)',
  not_owner: 'another surface owns the listener',
  owned: 'another surface owns the listener',
  unavailable: 'unavailable'
}

const startFailureLine = (r: WakeStartResponse): string => {
  const reason = r.reason ?? 'unknown'
  const base = START_REASON_TEXT[reason] ?? reason
  const owner = r.owner_surface ? ` (owned by ${r.owner_surface})` : ''
  const hint = r.hint?.trim() ? ` — ${r.hint.trim()}` : ''

  return `wake: not started — ${base}${owner}${hint}`
}

/** One transcript line for a wake.start response (started or refused). */
export function wakeStartLine(r: WakeStartResponse): string {
  if (!r.started) return startFailureLine(r)
  const phrase = r.phrase ? ` for “${r.phrase}”` : ''
  const provider = r.provider ? ` · ${r.provider}` : ''
  const saved = r.enabled_persisted ? ' · enabled in config' : ''
  return `wake: listening${phrase}${provider}${saved}`
}

/** One transcript line for a wake.stop response. */
export function wakeStopLine(r: WakeStopResponse): string {
  const saved = r.disabled_persisted ? ' · disabled in config' : ''
  if (r.stopped) return `wake: listener off${saved}`
  const reason = r.reason === 'not_owner' ? 'this surface doesn’t own the listener' : (r.reason ?? 'not running')
  return `wake: nothing to stop — ${reason}${saved}`
}

/** One transcript line for a wake.status response. */
export function wakeStatusLine(r: WakeStatusResponse): string {
  const phrase = r.phrase ? ` for “${r.phrase}”` : ''
  const provider = r.provider ? ` · ${r.provider}` : ''
  if (r.listening) {
    if (r.audio_silent) {
      const hint = r.hint?.trim() ? ` — ${r.hint.trim()}` : ''
      return `wake: listening${phrase}${provider} · ⚠ mic delivers only silence${hint}`
    }
    return `wake: listening${phrase}${provider}`
  }
  if (r.owner_surface && !r.owned_by_caller) {
    return `wake: off here · listener owned by ${r.owner_surface}${phrase}${provider}`
  }
  if (r.available === false) {
    const hint = r.hint?.trim() ? ` — ${r.hint.trim()}` : ''
    return `wake: unavailable${hint}`
  }
  return `wake: off${phrase}${provider} · /wake on to arm`
}

export interface WakeDetectedPayload {
  readonly phrase?: string
  readonly profile?: string | null
  readonly start_new_session?: boolean
}

export type WakeDetectedPlan = { kind: 'foreign-profile'; notice: string } | { kind: 'arm'; newSession: boolean }

/** Decide how a wake.detected event is handled. Multi-profile routing: this
 * TUI is a single-profile process, so a phrase enrolled by ANOTHER profile
 * can't be routed here — surface the switch command instead of starting voice
 * on the wrong profile (upstream createGatewayEventHandler parity). */
export function planWakeDetected(
  payload: WakeDetectedPayload | undefined,
  ownProfile: string | undefined
): WakeDetectedPlan {
  const wakeProfile = payload?.profile?.trim()
  const own = ownProfile?.trim() || 'default'
  if (wakeProfile && wakeProfile !== own) {
    return {
      kind: 'foreign-profile',
      notice: `wake phrase for profile '${wakeProfile}' — run: hermes -p ${wakeProfile} --tui`
    }
  }
  return { kind: 'arm', newSession: payload?.start_new_session !== false }
}

/** The entry-injected capabilities the wake.detected flow needs. */
export interface WakeHost {
  readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  readonly sessionId: () => string | undefined
  readonly ownProfile: () => string | undefined
  /** Close the live session and adopt a fresh one; resolves false on refusal/failure. */
  readonly newSession: () => Promise<boolean>
  /** Optimistic voice-mode paint; the voice.toggle response is authoritative. */
  readonly setVoiceEnabled: () => void
  readonly pushSystem: (text: string) => void
}

/** "Hey Hermes" fired: open a fresh session (unless start_new_session:false),
 * then arm voice capture so the user can speak hands-free. Every bail-out path
 * resumes the gateway's paused detector so the listener never goes deaf. */
export async function handleWakeDetected(host: WakeHost, payload: WakeDetectedPayload | undefined): Promise<void> {
  const resume = () => host.request('wake.resume', {}).catch(() => undefined)
  // `/wake off` is authoritative. A detector event may already be queued or
  // an earlier handler may still be crossing an async boundary when the user
  // opts out, so check both before and after every awaited activation step.
  if (isWakeUserDisabled()) return
  try {
    const plan = planWakeDetected(payload, host.ownProfile())
    if (plan.kind === 'foreign-profile') {
      host.pushSystem(plan.notice)
      await resume()
      return
    }
    if (plan.newSession) {
      if (!(await host.newSession())) {
        await resume()
        return
      }
      if (isWakeUserDisabled()) return
    }
    const sid = host.sessionId()
    if (!sid) {
      await resume()
      return
    }
    host.setVoiceEnabled()
    await host.request('voice.toggle', { action: 'on' })
    if (isWakeUserDisabled()) return
    await host.request('voice.record', { action: 'start', session_id: sid })
  } catch (error) {
    host.pushSystem(`wake: ${error instanceof Error ? error.message : String(error)}`)
    await resume()
  }
}
