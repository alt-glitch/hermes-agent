import { describe, expect, test } from 'vitest'

import { decodeVoiceRecordResponse, decodeVoiceToggleResponse } from '../boundary/schema/VoiceResponses.ts'
import { createSessionStore } from '../logic/store.ts'

describe('voice Effect boundaries', () => {
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
