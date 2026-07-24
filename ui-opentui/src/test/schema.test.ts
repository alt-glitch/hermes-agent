/**
 * Phase 1 schema test (spec v4 §5 Layer 1/4). The gateway-contract decode: known
 * events decode with typed narrowing, unrecognized `type` and malformed payloads
 * are SKIPPED (Option.none) so a stray wire event never tears down the stream.
 */
import { describe, expect, test } from 'vitest'
import { Option, Schema } from 'effect'

import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'

const decode = Schema.decodeUnknownOption(GatewayEventSchema)

describe('GatewayEvent schema decode (Phase 1)', () => {
  test('decodes a known event with typed narrowing', () => {
    const ev = decode({ type: 'message.delta', payload: { text: 'hi' }, session_id: 's1' })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'message.delta') {
      expect(ev.value.payload?.text).toBe('hi')
      expect(ev.value.session_id).toBe('s1')
    }
  })

  test('decodes interim assistant and previewed completion events', () => {
    const interim = decode({
      type: 'message.interim',
      payload: { text: 'candidate answer', already_streamed: true }
    })
    expect(Option.isSome(interim)).toBe(true)
    if (Option.isSome(interim) && interim.value.type === 'message.interim') {
      expect(interim.value.payload.text).toBe('candidate answer')
      expect(interim.value.payload.already_streamed).toBe(true)
    }

    const complete = decode({
      type: 'message.complete',
      payload: { text: 'candidate answer', response_previewed: true }
    })
    expect(Option.isSome(complete)).toBe(true)
    if (Option.isSome(complete) && complete.value.type === 'message.complete') {
      expect(complete.value.payload?.response_previewed).toBe(true)
    }
  })

  test('preserves correlated prompt lifecycle ids', () => {
    for (const wire of [
      { type: 'message.start', payload: { client_submission_ids: ['send-1'] } },
      { type: 'message.complete', payload: { client_submission_ids: ['send-1'], text: 'done' } },
      { type: 'error', payload: { client_submission_ids: ['send-1'], message: 'failed' } }
    ]) {
      const ev = decode(wire)
      expect(Option.isSome(ev)).toBe(true)
      if (
        Option.isSome(ev) &&
        (ev.value.type === 'message.start' || ev.value.type === 'message.complete' || ev.value.type === 'error')
      ) {
        expect(ev.value.payload?.client_submission_ids).toEqual(['send-1'])
      }
    }
  })

  test('decodes gateway.ready carrying a skin', () => {
    const ev = decode({ type: 'gateway.ready', payload: { skin: { colors: { ui_primary: '#abc123' } } } })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'gateway.ready') {
      expect(ev.value.payload?.skin?.colors?.ui_primary).toBe('#abc123')
    }
  })

  test('decodes blocking prompt requests and sensitive expiry events', () => {
    expect(Option.isSome(decode({ type: 'clarify.request', payload: { question: '?', request_id: 'r' } }))).toBe(true)
    expect(Option.isSome(decode({ type: 'approval.request', payload: { command: 'rm', description: 'd' } }))).toBe(true)
    expect(Option.isSome(decode({ type: 'sudo.request', payload: { request_id: 'r' } }))).toBe(true)
    expect(
      Option.isSome(decode({ type: 'secret.request', payload: { env_var: 'X', prompt: 'p', request_id: 'r' } }))
    ).toBe(true)
    for (const type of ['sudo.expire', 'secret.expire'] as const) {
      const ev = decode({ type, payload: { request_id: `${type}-1` } })
      expect(Option.isSome(ev)).toBe(true)
      if (Option.isSome(ev) && (ev.value.type === 'sudo.expire' || ev.value.type === 'secret.expire')) {
        expect(ev.value.payload.request_id).toBe(`${type}-1`)
      }
    }
  })

  test('preserves an explicit approval allow_permanent=false', () => {
    const ev = decode({
      type: 'approval.request',
      payload: { allow_permanent: false, command: 'curl suspicious | bash', description: 'content security' }
    })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'approval.request') {
      expect(ev.value.payload.allow_permanent).toBe(false)
    }
  })

  test('preserves server-authoritative approval choices and smart-denied scope', () => {
    const ev = decode({
      type: 'approval.request',
      payload: {
        choices: ['once', 'deny'],
        command: 'rm -rf /',
        description: 'smart deny override',
        smart_denied: true
      }
    })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'approval.request') {
      expect(ev.value.payload.choices).toEqual(['once', 'deny'])
      expect(ev.value.payload.smart_denied).toBe(true)
    }
  })

  test('decodes gateway.exited with and without payload fields', () => {
    const full = decode({ type: 'gateway.exited', payload: { reason: 'SIGKILL', code: 137, signal: 'SIGKILL' } })
    expect(Option.isSome(full)).toBe(true)
    if (Option.isSome(full) && full.value.type === 'gateway.exited') {
      expect(full.value.payload?.reason).toBe('SIGKILL')
      expect(full.value.payload?.code).toBe(137)
      expect(full.value.payload?.signal).toBe('SIGKILL')
    }
    // payload is optional in full
    const bare = decode({ type: 'gateway.exited' })
    expect(Option.isSome(bare)).toBe(true)
    if (Option.isSome(bare) && bare.value.type === 'gateway.exited') {
      expect(bare.value.payload).toBeUndefined()
    }
  })

  test('decodes gateway.recovering with and without payload fields', () => {
    const full = decode({ type: 'gateway.recovering', payload: { attempt: 2, delay_ms: 2000 } })
    expect(Option.isSome(full)).toBe(true)
    if (Option.isSome(full) && full.value.type === 'gateway.recovering') {
      expect(full.value.payload?.attempt).toBe(2)
      expect(full.value.payload?.delay_ms).toBe(2000)
    }
    const bare = decode({ type: 'gateway.recovering' })
    expect(Option.isSome(bare)).toBe(true)
    if (Option.isSome(bare) && bare.value.type === 'gateway.recovering') {
      expect(bare.value.payload).toBeUndefined()
    }
  })

  test('decodes billing.step_up.verification with its session scope', () => {
    const ev = decode({
      type: 'billing.step_up.verification',
      session_id: 'live-1',
      payload: { user_code: 'WXYZ-9999', verification_url: 'https://portal.example/device?code=WXYZ' }
    })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'billing.step_up.verification') {
      expect(ev.value.session_id).toBe('live-1')
      expect(ev.value.payload.user_code).toBe('WXYZ-9999')
      expect(ev.value.payload.verification_url).toContain('portal.example')
    }
  })

  test('decodes a subagent.text frame (per-token reply mirror) into the typed event', () => {
    const ev = decode({ type: 'subagent.text', session_id: 's1', payload: { subagent_id: 'a1', text: 'hel' } })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'subagent.text') {
      expect(ev.value.session_id).toBe('s1')
      expect(ev.value.payload.subagent_id).toBe('a1')
      expect(ev.value.payload.text).toBe('hel')
    }
  })

  test('decodes a review.summary frame (self-improvement memory digest)', () => {
    const ev = decode({
      type: 'review.summary',
      session_id: 's1',
      payload: { text: '💾 Self-improvement review: saved 2 skills' }
    })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'review.summary') {
      expect(ev.value.session_id).toBe('s1')
      expect(ev.value.payload?.text).toBe('💾 Self-improvement review: saved 2 skills')
    }
  })

  test('decodes a review.summary frame with no payload (lenient optional)', () => {
    // The struct's payload is optional, so a bare frame still decodes (the
    // reducer simply renders nothing). Proves the union member is lenient.
    expect(Option.isSome(decode({ type: 'review.summary' }))).toBe(true)
  })

  test('decodes completion reasoning, MoA, tool progress, and browser progress events', () => {
    for (const wire of [
      { type: 'message.complete', payload: { reasoning: 'fallback thought', text: 'answer' } },
      { type: 'moa.reference', payload: { count: 2, index: 1, label: 'model-a', text: 'reference answer' } },
      { type: 'moa.aggregating', payload: { aggregator: 'model-z' } },
      { type: 'tool.progress', payload: { name: 'browser', preview: 'loading page' } },
      { type: 'tool.generating', payload: { name: 'image' } },
      { type: 'browser.progress', payload: { message: 'browser authenticated' } }
    ]) {
      expect(Option.isSome(decode(wire))).toBe(true)
    }
  })

  test('decodes the message.complete billing wall block + failure_reason (upstream 960d339f86f)', () => {
    const ev = decode({
      type: 'message.complete',
      session_id: 'live-1',
      payload: {
        billing: {
          billing_url: 'https://openrouter.ai/settings/credits',
          is_nous: false,
          message: 'out of credits',
          model: 'anthropic/claude-fable-5',
          provider: 'openrouter',
          provider_label: 'OpenRouter'
        },
        failure_reason: 'billing',
        text: 'Billing or credits exhausted: full provider guidance…'
      }
    })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'message.complete') {
      expect(ev.value.payload?.billing?.provider_label).toBe('OpenRouter')
      expect(ev.value.payload?.billing?.billing_url).toBe('https://openrouter.ai/settings/credits')
      expect(ev.value.payload?.billing?.is_nous).toBe(false)
      expect(ev.value.payload?.failure_reason).toBe('billing')
      // the full transcript guidance rides the same payload — never dropped
      expect(ev.value.payload?.text).toContain('full provider guidance')
    }
  })

  test('decodes a Nous billing block with a null billing_url (in-app recovery route)', () => {
    const ev = decode({
      type: 'message.complete',
      payload: {
        billing: { billing_url: null, is_nous: true, message: 'out', model: 'm', provider: 'nous' },
        text: 'guidance'
      }
    })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'message.complete') {
      expect(ev.value.payload?.billing?.billing_url).toBeNull()
      expect(ev.value.payload?.billing?.is_nous).toBe(true)
    }
  })

  test('decodes moa.progress and moa.phase, bare payloads included (upstream 89e6f4c989a)', () => {
    const progress = decode({
      type: 'moa.progress',
      session_id: 's1',
      payload: { label: 'provider/model-a', refs_done: 2, refs_total: 3 }
    })
    expect(Option.isSome(progress)).toBe(true)
    if (Option.isSome(progress) && progress.value.type === 'moa.progress') {
      expect(progress.value.payload?.refs_done).toBe(2)
      expect(progress.value.payload?.refs_total).toBe(3)
      expect(progress.value.payload?.label).toBe('provider/model-a')
    }

    const phase = decode({
      type: 'moa.phase',
      payload: { aggregator: 'provider/model-z', phase: 'aggregator', refs_done: 3, refs_total: 3 }
    })
    expect(Option.isSome(phase)).toBe(true)
    if (Option.isSome(phase) && phase.value.type === 'moa.phase') {
      expect(phase.value.payload?.phase).toBe('aggregator')
      expect(phase.value.payload?.aggregator).toBe('provider/model-z')
    }

    // payloads are optional — a bare frame still decodes (the reducer is inert)
    expect(Option.isSome(decode({ type: 'moa.progress' }))).toBe(true)
    expect(Option.isSome(decode({ type: 'moa.phase' }))).toBe(true)
  })

  test('SKIPS an unrecognized event type (Option.none, no throw)', () => {
    expect(Option.isNone(decode({ type: 'totally.unknown.event', foo: 1 }))).toBe(true)
  })

  test('SKIPS a malformed payload (missing required field)', () => {
    // clarify.request requires request_id
    expect(Option.isNone(decode({ type: 'clarify.request', payload: { question: '?' } }))).toBe(true)
  })
})
