import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import { decodeVoiceRecordResponse, decodeVoiceToggleResponse } from '../boundary/schema/VoiceResponses.ts'
import { createSessionStore } from '../logic/store.ts'

const decodeEvent = Schema.decodeUnknownOption(GatewayEventSchema)

describe('voice Effect boundaries', () => {
  test('decodes the stop-phrase transcript variants (spoken text / typed marker) at the wire boundary', () => {
    const spoken = decodeEvent({ type: 'voice.transcript', payload: { stop_phrase: true, text: 'stop' } })
    expect(spoken._tag).toBe('Some')
    if (spoken._tag === 'Some' && spoken.value.type === 'voice.transcript') {
      expect(spoken.value.payload).toEqual({ stop_phrase: true, text: 'stop' })
    }
    const typed = decodeEvent({ type: 'voice.transcript', payload: { stop_phrase: true, typed: true } })
    expect(typed._tag).toBe('Some')
    if (typed._tag === 'Some' && typed.value.type === 'voice.transcript') {
      expect(typed.value.payload).toEqual({ stop_phrase: true, typed: true })
    }
  })

  test('decodes exact-f7 toggle and record response shapes while preserving additive fields', () => {
    expect(
      decodeVoiceToggleResponse({
        available: true,
        audio_available: true,
        stt_available: false,
        details: 'STT provider: MISSING',
        enabled: true,
        record_key: 'ctrl+space',
        tts: true,
        future: 1
      })
    ).toMatchObject({ enabled: true, record_key: 'ctrl+space', tts: true })
    expect(decodeVoiceRecordResponse({ status: 'recording' })).toMatchObject({ status: 'recording' })
    expect(decodeVoiceRecordResponse({ status: 'invalid' })).toBeUndefined()
  })
})

describe('voice store reducer', () => {
  test('tracks toggle state without clobbering an omitted custom record key', () => {
    const store = createSessionStore()
    store.setVoiceMode({ enabled: true, tts: true, recordKey: 'alt+r' })
    store.setVoiceMode({ tts: false })
    expect(store.state.voice).toMatchObject({ enabled: true, tts: false, recordKey: 'alt+r' })
  })

  test('reduces listening, transcribing and idle as mutually exclusive activity', () => {
    const store = createSessionStore()
    store.apply({ type: 'voice.status', payload: { state: 'listening' } })
    expect(store.state.voice).toMatchObject({ recording: true, processing: false })
    store.apply({ type: 'voice.status', payload: { state: 'transcribing' } })
    expect(store.state.voice).toMatchObject({ recording: false, processing: true })
    store.apply({ type: 'voice.status', payload: { state: 'idle' } })
    expect(store.state.voice).toMatchObject({ recording: false, processing: false })
  })

  test('no-speech cutoff disables the mode, clears activity and explains why', () => {
    const store = createSessionStore()
    store.setVoiceMode({ enabled: true, tts: true })
    store.setVoiceActivity(true)
    store.apply({ type: 'voice.transcript', payload: { no_speech_limit: true } })
    expect(store.state.voice).toMatchObject({ enabled: false, tts: true, recording: false, processing: false })
    expect(store.state.messages.at(-1)?.text).toContain('no speech detected 3 times')
  })

  test('ordinary transcripts remain side-effect free for entry to submit exactly once', () => {
    const store = createSessionStore()
    store.apply({ type: 'voice.transcript', payload: { text: 'send this' } })
    expect(store.state.messages).toHaveLength(0)
  })

  test('a spoken stop phrase ends voice mode with the intent notice, distinct from the no-speech cutoff (ba13132298)', () => {
    const store = createSessionStore()
    store.setVoiceMode({ enabled: true, tts: true })
    store.setVoiceActivity(true)
    store.apply({ type: 'voice.transcript', payload: { stop_phrase: true, text: 'stop' } })
    expect(store.state.voice).toMatchObject({ enabled: false, tts: true, recording: false, processing: false })
    // The stop phrase is user intent to END the chat — the transcript records
    // only the notice; the text must never appear as a user turn.
    expect(store.state.messages).toHaveLength(1)
    expect(store.state.messages.at(-1)).toMatchObject({ role: 'system', text: 'voice: stop phrase — voice chat ended' })
  })

  test('a typed stop phrase consumed server-side ({typed:true}) ends voice mode the same way', () => {
    const store = createSessionStore()
    store.setVoiceMode({ enabled: true })
    store.apply({ type: 'voice.transcript', payload: { stop_phrase: true, typed: true } })
    expect(store.state.voice).toMatchObject({ enabled: false })
    expect(store.state.messages.at(-1)?.text).toBe('voice: stop phrase — voice chat ended')
  })

  test('gateway exit resets runtime resources but retains the configured voice binding', () => {
    const store = createSessionStore()
    store.setVoiceMode({ enabled: true, tts: true, recordKey: 'ctrl+space' })
    store.setVoiceActivity(true)
    store.setBrowserState({ connected: true, url: 'https://example.test' })
    store.apply({ type: 'gateway.exited' })
    expect(store.state.voice).toEqual({
      enabled: false,
      tts: false,
      recording: false,
      processing: false,
      recordKey: 'ctrl+space'
    })
    expect(store.state.browser).toEqual({ connected: false })
  })
})

describe('browser store reducer', () => {
  test('stores bounded progress and keeps the existing transcript line', () => {
    const store = createSessionStore()
    store.setBrowserState({ connected: true, url: 'https://example.test' })
    store.apply({ type: 'browser.progress', payload: { message: 'Opening the page', level: 'info' } })
    expect(store.state.browser).toMatchObject({
      connected: true,
      url: 'https://example.test',
      lastProgress: 'Opening the page'
    })
    expect(store.state.messages.at(-1)?.text).toBe('Opening the page')
  })
})
