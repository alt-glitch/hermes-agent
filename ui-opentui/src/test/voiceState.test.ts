import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import { decodeVoiceRecordResponse, decodeVoiceToggleResponse } from '../boundary/schema/VoiceResponses.ts'
import { createSessionStore } from '../logic/store.ts'
import { deliverVoiceTranscript, voiceSubmitModeFromConfig } from '../logic/voiceSubmit.ts'

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
    store.setVoiceMode({ enabled: true, tts: true, recordKey: 'ctrl+space', submitMode: 'draft' })
    store.setVoiceActivity(true)
    store.setBrowserState({ connected: true, url: 'https://example.test' })
    store.apply({ type: 'gateway.exited' })
    expect(store.state.voice).toEqual({
      enabled: false,
      tts: false,
      recording: false,
      processing: false,
      recordKey: 'ctrl+space',
      submitMode: 'draft'
    })
    expect(store.state.browser).toEqual({ connected: false })
  })
})

describe('voice.submit_mode (upstream f1c45f5727 + 0ca78e5f32)', () => {
  test('normalizes only an exact trimmed case-insensitive "draft"; malformed or missing values fall back to direct', () => {
    expect(voiceSubmitModeFromConfig({ voice: { submit_mode: 'draft' } })).toBe('draft')
    expect(voiceSubmitModeFromConfig({ voice: { submit_mode: '  DrAfT ' } })).toBe('draft')
    expect(voiceSubmitModeFromConfig({ voice: { submit_mode: 'direct' } })).toBe('direct')
    expect(voiceSubmitModeFromConfig(undefined)).toBe('direct')
    expect(voiceSubmitModeFromConfig({})).toBe('direct')
    expect(voiceSubmitModeFromConfig({ voice: 'draft' })).toBe('direct')
    expect(voiceSubmitModeFromConfig({ voice: {} })).toBe('direct')
    expect(voiceSubmitModeFromConfig({ voice: { submit_mode: 42 } })).toBe('direct')
    expect(voiceSubmitModeFromConfig({ voice: { submit_mode: 'drafty' } })).toBe('direct')
    expect(voiceSubmitModeFromConfig({ voice: { submit_mode: null } })).toBe('direct')
  })

  test('direct mode (the un-hydrated default) clears the composer, then submits the trimmed transcript exactly once', async () => {
    const store = createSessionStore()
    store.setComposerDraft('half-typed')
    const submitted: string[] = []
    deliverVoiceTranscript(store, { text: '  send this  ' }, text => submitted.push(text))
    // The clear lands synchronously; the single submit is deferred behind it.
    expect(store.state.composerDraft).toBe('')
    expect(submitted).toEqual([])
    await Promise.resolve()
    expect(submitted).toEqual(['send this'])
  })

  test('draft mode inserts the transcript editable via the replace signal and never submits', async () => {
    const store = createSessionStore()
    store.setVoiceMode({ submitMode: 'draft' })
    const replaceVersionBefore = store.state.composerReplaceVersion
    const submitted: string[] = []
    deliverVoiceTranscript(store, { text: '  edit this first  ' }, text => submitted.push(text))
    await Promise.resolve()
    expect(store.state.composerDraft).toBe('edit this first')
    // The mounted textarea is uncontrolled — adoption rides composerReplaceVersion.
    expect(store.state.composerReplaceVersion).toBe(replaceVersionBefore + 1)
    expect(submitted).toEqual([])
  })

  test('draft mode preserves an existing draft: trim-end plus one space before the transcript (0ca78e5f32)', () => {
    const store = createSessionStore()
    store.setVoiceMode({ submitMode: 'draft' })
    store.setComposerDraft('existing draft  ')
    deliverVoiceTranscript(store, { text: 'editable voice draft' }, () => {
      throw new Error('draft mode must not submit')
    })
    expect(store.state.composerDraft).toBe('existing draft editable voice draft')
  })

  test('draft mode replaces a whitespace-only draft outright (no leading space)', () => {
    const store = createSessionStore()
    store.setVoiceMode({ submitMode: 'draft' })
    store.setComposerDraft('   ')
    deliverVoiceTranscript(store, { text: 'clean start' }, () => {
      throw new Error('draft mode must not submit')
    })
    expect(store.state.composerDraft).toBe('clean start')
  })

  test('stop-phrase, no-speech and empty transcripts neither submit nor touch the draft in either mode', async () => {
    for (const submitMode of ['direct', 'draft'] as const) {
      const store = createSessionStore()
      store.setVoiceMode({ submitMode })
      store.setComposerDraft('keep me')
      const submitted: string[] = []
      deliverVoiceTranscript(store, { stop_phrase: true, text: 'stop' }, text => submitted.push(text))
      deliverVoiceTranscript(store, { no_speech_limit: true }, text => submitted.push(text))
      deliverVoiceTranscript(store, { text: '   ' }, text => submitted.push(text))
      deliverVoiceTranscript(store, undefined, text => submitted.push(text))
      await Promise.resolve()
      expect(submitted).toEqual([])
      expect(store.state.composerDraft).toBe('keep me')
    }
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
