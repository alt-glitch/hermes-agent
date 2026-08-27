/**
 * Wake-word ("Hey Hermes") TUI surface — native port of upstream 86d5b8b90f +
 * 71a2feeade. Covers the wire schemas (wake.detected event, wake.* RPC
 * responses), the transcript one-liners, the explicit `/wake off` opt-out that
 * survives gateway reconnects, and the wake.detected orchestration (fresh
 * session + voice arm, foreign-profile routing, resume-on-bailout).
 */
import { Schema } from 'effect'
import { beforeEach, describe, expect, test } from 'vitest'

import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import {
  decodeWakeStartResponse,
  decodeWakeStatusResponse,
  decodeWakeStopResponse
} from '../boundary/schema/SessionCommandResponses.ts'
import {
  handleWakeDetected,
  isWakeUserDisabled,
  planWakeDetected,
  setWakeUserDisabled,
  type WakeHost,
  wakeStartLine,
  wakeStatusLine,
  wakeStopLine
} from '../logic/wake.ts'

const decode = Schema.decodeUnknownOption(GatewayEventSchema)

beforeEach(() => setWakeUserDisabled(false))

describe('wake wire schemas', () => {
  test('decodes wake.detected with phrase/profile/start_new_session (and a blank global session id)', () => {
    const ev = decode({
      type: 'wake.detected',
      session_id: '',
      payload: { phrase: 'hey hermes', profile: null, start_new_session: true }
    })
    expect(ev._tag).toBe('Some')
    if (ev._tag === 'Some' && ev.value.type === 'wake.detected') {
      expect(ev.value.payload).toEqual({ phrase: 'hey hermes', profile: null, start_new_session: true })
    }
  })

  test('decodes a payload-less wake.detected (older gateway)', () => {
    expect(decode({ type: 'wake.detected' })._tag).toBe('Some')
  })

  test('decodes the wake.start success and refusal shapes', () => {
    expect(
      decodeWakeStartResponse({
        started: true,
        phrase: 'hey hermes',
        provider: 'openwakeword',
        owner_surface: 'tui',
        enabled_persisted: true
      })
    ).toMatchObject({ started: true, phrase: 'hey hermes', enabled_persisted: true })
    expect(decodeWakeStartResponse({ started: false, reason: 'owned', owner_surface: 'gui' })).toMatchObject({
      reason: 'owned',
      owner_surface: 'gui'
    })
    expect(decodeWakeStartResponse('nope')).toBeUndefined()
  })

  test('decodes wake.stop and wake.status shapes (null owner/reason allowed)', () => {
    expect(decodeWakeStopResponse({ stopped: true, reason: null, disabled_persisted: false })).toMatchObject({
      stopped: true
    })
    expect(
      decodeWakeStatusResponse({
        listening: true,
        owned_by_caller: true,
        owner_surface: 'tui',
        phrase: 'hey hermes',
        provider: 'openwakeword',
        available: true,
        enabled: true,
        audio_silent: false,
        hint: ''
      })
    ).toMatchObject({ listening: true, owned_by_caller: true })
    expect(decodeWakeStatusResponse(42)).toBeUndefined()
  })
})

describe('wake transcript lines (upstream wording)', () => {
  test('start: listening line with phrase/provider/persist note', () => {
    expect(wakeStartLine({ started: true, phrase: 'hey hermes', provider: 'openwakeword' })).toBe(
      'wake: listening for “hey hermes” · openwakeword'
    )
    expect(wakeStartLine({ started: true, phrase: 'hey hermes', enabled_persisted: true })).toBe(
      'wake: listening for “hey hermes” · enabled in config'
    )
  })

  test('start refusals: known codes get friendly text; unknown codes stay visible', () => {
    expect(wakeStartLine({ started: false, reason: 'disabled' })).toBe(
      'wake: not started — disabled (config wake_word.enabled)'
    )
    expect(wakeStartLine({ started: false, reason: 'owned', owner_surface: 'gui' })).toBe(
      'wake: not started — another surface owns the listener (owned by gui)'
    )
    expect(wakeStartLine({ started: false, reason: 'unavailable', hint: 'no microphone' })).toBe(
      'wake: not started — unavailable — no microphone'
    )
    expect(wakeStartLine({ started: false, reason: 'flux_capacitor' })).toBe('wake: not started — flux_capacitor')
  })

  test('stop: stopped/not-owner/persisted variants', () => {
    expect(wakeStopLine({ stopped: true })).toBe('wake: listener off')
    expect(wakeStopLine({ stopped: true, disabled_persisted: true })).toBe('wake: listener off · disabled in config')
    expect(wakeStopLine({ stopped: false, reason: 'not_owner' })).toBe(
      'wake: nothing to stop — this surface doesn’t own the listener'
    )
    expect(wakeStopLine({ stopped: false, reason: null })).toBe('wake: nothing to stop — not running')
  })

  test('status: listening / silent-mic / foreign owner / unavailable / off', () => {
    expect(wakeStatusLine({ listening: true, phrase: 'hey hermes', provider: 'openwakeword' })).toBe(
      'wake: listening for “hey hermes” · openwakeword'
    )
    expect(wakeStatusLine({ listening: true, phrase: 'hey hermes', audio_silent: true, hint: 'check input' })).toBe(
      'wake: listening for “hey hermes” · ⚠ mic delivers only silence — check input'
    )
    expect(wakeStatusLine({ listening: false, owner_surface: 'gui', owned_by_caller: false })).toBe(
      'wake: off here · listener owned by gui'
    )
    expect(wakeStatusLine({ listening: false, available: false, hint: 'pip install openwakeword' })).toBe(
      'wake: unavailable — pip install openwakeword'
    )
    expect(wakeStatusLine({ listening: false, phrase: 'hey hermes' })).toBe(
      'wake: off for “hey hermes” · /wake on to arm'
    )
  })
})

describe('wake user opt-out flag', () => {
  test('records an explicit /wake off for the process lifetime; /wake on clears it', () => {
    expect(isWakeUserDisabled()).toBe(false)
    setWakeUserDisabled(true)
    expect(isWakeUserDisabled()).toBe(true)
    setWakeUserDisabled(false)
    expect(isWakeUserDisabled()).toBe(false)
  })
})

describe('planWakeDetected', () => {
  test('default: fresh session + arm', () => {
    expect(planWakeDetected({ phrase: 'hey hermes' }, undefined)).toEqual({ kind: 'arm', newSession: true })
    expect(planWakeDetected(undefined, 'default')).toEqual({ kind: 'arm', newSession: true })
  })

  test('start_new_session:false arms in the CURRENT session', () => {
    expect(planWakeDetected({ start_new_session: false }, 'default')).toEqual({ kind: 'arm', newSession: false })
  })

  test('a phrase enrolled by another profile routes to a switch hint, never voice', () => {
    expect(planWakeDetected({ profile: 'work' }, 'default')).toEqual({
      kind: 'foreign-profile',
      notice: "wake phrase for profile 'work' — run: hermes -p work --tui"
    })
    // own profile (or null/empty) proceeds
    expect(planWakeDetected({ profile: 'work' }, 'work')).toEqual({ kind: 'arm', newSession: true })
    expect(planWakeDetected({ profile: null }, 'default')).toEqual({ kind: 'arm', newSession: true })
  })
})

interface HostProbe {
  readonly host: WakeHost
  readonly calls: Array<{ method: string; params: Record<string, unknown> }>
  readonly system: string[]
  readonly newSessions: { count: number }
  readonly voiceEnabled: { count: number }
}

function makeHost(overrides?: {
  newSessionResult?: boolean
  sessionId?: string | undefined
  ownProfile?: string
  failMethod?: string
}): HostProbe {
  const calls: HostProbe['calls'] = []
  const system: string[] = []
  const newSessions = { count: 0 }
  const voiceEnabled = { count: 0 }
  const host: WakeHost = {
    request: (method, params) => {
      calls.push({ method, params })
      if (method === overrides?.failMethod) return Promise.reject(new Error(`${method} exploded`))
      return Promise.resolve({})
    },
    sessionId: () => ('sessionId' in (overrides ?? {}) ? overrides?.sessionId : 'wake-sid'),
    ownProfile: () => overrides?.ownProfile,
    newSession: () => {
      newSessions.count += 1
      return Promise.resolve(overrides?.newSessionResult ?? true)
    },
    setVoiceEnabled: () => {
      voiceEnabled.count += 1
    },
    pushSystem: text => system.push(text)
  }
  return { host, calls, system, newSessions, voiceEnabled }
}

describe('handleWakeDetected', () => {
  test('an explicit opt-out ignores an already queued detector event', async () => {
    const p = makeHost()
    setWakeUserDisabled(true)
    await handleWakeDetected(p.host, { phrase: 'hey hermes' })
    expect(p.newSessions.count).toBe(0)
    expect(p.voiceEnabled.count).toBe(0)
    expect(p.calls).toEqual([])
  })

  test('an opt-out while a fresh session opens stops before voice activation', async () => {
    let release!: (value: boolean) => void
    const opened = new Promise<boolean>(resolve => {
      release = resolve
    })
    const p = makeHost()
    const host: WakeHost = { ...p.host, newSession: () => opened }

    const handling = handleWakeDetected(host, {})
    setWakeUserDisabled(true)
    release(true)
    await handling

    expect(p.voiceEnabled.count).toBe(0)
    expect(p.calls).toEqual([])
  })

  test('opens a fresh session, then arms voice capture on the new sid', async () => {
    const p = makeHost()
    await handleWakeDetected(p.host, { phrase: 'hey hermes' })
    expect(p.newSessions.count).toBe(1)
    expect(p.voiceEnabled.count).toBe(1)
    expect(p.calls).toEqual([
      { method: 'voice.toggle', params: { action: 'on' } },
      { method: 'voice.record', params: { action: 'start', session_id: 'wake-sid' } }
    ])
    expect(p.system).toEqual([])
  })

  test('start_new_session:false arms voice in the current session without replacing it', async () => {
    const p = makeHost()
    await handleWakeDetected(p.host, { start_new_session: false })
    expect(p.newSessions.count).toBe(0)
    expect(p.calls.map(call => call.method)).toEqual(['voice.toggle', 'voice.record'])
  })

  test('a foreign-profile phrase surfaces the switch command and resumes the detector', async () => {
    const p = makeHost({ ownProfile: 'default' })
    await handleWakeDetected(p.host, { profile: 'work' })
    expect(p.system).toEqual(["wake phrase for profile 'work' — run: hermes -p work --tui"])
    expect(p.newSessions.count).toBe(0)
    expect(p.calls.map(call => call.method)).toEqual(['wake.resume'])
  })

  test('a refused fresh session resumes the detector instead of arming voice', async () => {
    const p = makeHost({ newSessionResult: false })
    await handleWakeDetected(p.host, {})
    expect(p.calls.map(call => call.method)).toEqual(['wake.resume'])
    expect(p.voiceEnabled.count).toBe(0)
  })

  test('a missing live sid after the swap resumes the detector', async () => {
    const p = makeHost({ sessionId: undefined })
    await handleWakeDetected(p.host, {})
    expect(p.calls.map(call => call.method)).toEqual(['wake.resume'])
    expect(p.voiceEnabled.count).toBe(0)
  })

  test('a voice-arm failure reports and resumes the detector so the listener never goes deaf', async () => {
    const p = makeHost({ failMethod: 'voice.record' })
    await handleWakeDetected(p.host, {})
    expect(p.system).toEqual(['wake: voice.record exploded'])
    expect(p.calls.map(call => call.method)).toEqual(['voice.toggle', 'voice.record', 'wake.resume'])
  })
})
