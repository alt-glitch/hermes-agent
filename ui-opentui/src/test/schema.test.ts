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

  test('decodes gateway.ready carrying a skin', () => {
    const ev = decode({ type: 'gateway.ready', payload: { skin: { colors: { ui_primary: '#abc123' } } } })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'gateway.ready') {
      expect(ev.value.payload?.skin?.colors?.ui_primary).toBe('#abc123')
    }
  })

  test('decodes the 4 blocking prompt requests', () => {
    expect(Option.isSome(decode({ type: 'clarify.request', payload: { question: '?', request_id: 'r' } }))).toBe(true)
    expect(Option.isSome(decode({ type: 'approval.request', payload: { command: 'rm', description: 'd' } }))).toBe(true)
    expect(Option.isSome(decode({ type: 'sudo.request', payload: { request_id: 'r' } }))).toBe(true)
    expect(
      Option.isSome(decode({ type: 'secret.request', payload: { env_var: 'X', prompt: 'p', request_id: 'r' } }))
    ).toBe(true)
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

  test('decodes a subagent.text frame (per-token reply mirror) into the typed event', () => {
    const ev = decode({ type: 'subagent.text', session_id: 's1', payload: { subagent_id: 'a1', text: 'hel' } })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'subagent.text') {
      expect(ev.value.session_id).toBe('s1')
      expect(ev.value.payload.subagent_id).toBe('a1')
      expect(ev.value.payload.text).toBe('hel')
    }
  })

  test('SKIPS an unrecognized event type (Option.none, no throw)', () => {
    expect(Option.isNone(decode({ type: 'totally.unknown.event', foo: 1 }))).toBe(true)
  })

  test('SKIPS a malformed payload (missing required field)', () => {
    // clarify.request requires request_id
    expect(Option.isNone(decode({ type: 'clarify.request', payload: { question: '?' } }))).toBe(true)
  })
})
