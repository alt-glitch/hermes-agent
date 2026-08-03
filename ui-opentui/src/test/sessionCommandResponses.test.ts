import { describe, expect, test } from 'vitest'

import {
  classifySessionSteerResponse,
  decodeConfigValueResponse,
  decodeConfigFullResponse,
  decodeConfigMtimeResponse,
  decodeModelSwitchResponse,
  decodeCommandsCatalogResponse,
  decodePromptSubmitAck,
  decodeReloadEnvResponse,
  decodeReloadMcpResponse,
  decodeSessionSaveResponse,
  decodeSessionSteerResponse,
  decodeSessionStatusResponse,
  decodeSessionTitleResponse,
  decodeSessionUndoResponse,
  decodeSkillsReloadResponse
} from '../boundary/schema/SessionCommandResponses.ts'

describe('session-maintenance RPC Effect boundaries', () => {
  test('decode each authoritative gateway response', () => {
    expect(decodeSessionStatusResponse({ output: 'Hermes TUI Status' })).toEqual({ output: 'Hermes TUI Status' })
    expect(decodeSessionTitleResponse({ pending: true, session_key: 'db-1', title: 'Release' })).toEqual({
      pending: true,
      session_key: 'db-1',
      title: 'Release'
    })
    expect(decodeSessionSaveResponse({ file: '/tmp/session.json' })).toEqual({ file: '/tmp/session.json' })
    expect(decodeReloadEnvResponse({ updated: 2 })).toEqual({ updated: 2 })
    expect(decodeReloadMcpResponse({ status: 'confirm_required', message: 'confirm' })).toEqual({
      status: 'confirm_required',
      message: 'confirm'
    })
    expect(decodeConfigValueResponse({ value: 'queue' })).toEqual({ value: 'queue' })
    expect(
      decodeModelSwitchResponse({
        confirm_message: 'premium pricing',
        confirm_required: true,
        warning: 'high cost'
      })
    ).toEqual({ confirm_message: 'premium pricing', confirm_required: true, warning: 'high cost' })
    expect(decodeModelSwitchResponse({ value: 'anthropic/claude-opus' })).toEqual({
      value: 'anthropic/claude-opus'
    })
    // Mid-turn switch: the gateway queues the pick and answers deferred:true
    // (upstream f27d45e288) — decoded so the handler can say "applies next turn".
    expect(decodeModelSwitchResponse({ deferred: true, scope: 'session', value: 'claude-opus', warning: '' })).toEqual({
      deferred: true,
      scope: 'session',
      value: 'claude-opus',
      warning: ''
    })
    expect(decodeConfigFullResponse({ config: { display: { busy_input_mode: 'steer' } } })).toEqual({
      config: { display: { busy_input_mode: 'steer' } }
    })
    expect(decodeConfigMtimeResponse({ mtime: 123.5 })).toEqual({ mtime: 123.5 })
    expect(decodeSessionSteerResponse({ status: 'queued', text: 'next' })).toEqual({
      status: 'queued',
      text: 'next'
    })
    expect(decodeSessionUndoResponse({ removed: 2, target_text: 'retry me' })).toEqual({
      removed: 2,
      target_text: 'retry me'
    })
    expect(
      decodeSkillsReloadResponse({
        output: 'skills reloaded',
        result: {
          added: [{ description: 'New', name: 'new-skill' }],
          commands: 1,
          removed: [{ description: 'Old', name: 'old-skill' }],
          total: 1,
          unchanged: []
        }
      })
    ).toEqual({
      output: 'skills reloaded',
      result: {
        added: [{ description: 'New', name: 'new-skill' }],
        commands: 1,
        removed: [{ description: 'Old', name: 'old-skill' }],
        total: 1,
        unchanged: []
      }
    })
    expect(
      decodeCommandsCatalogResponse({
        canon: { '/rs': '/reload-skills' },
        categories: [{ name: 'Session', pairs: [['/status', 'Show status']] }],
        pairs: [
          ['/reload-skills', 'Reload skills'],
          ['/dogfood', 'Run dogfood skill']
        ],
        skill_count: 1,
        warning: ''
      })
    ).toEqual({
      canon: { '/rs': '/reload-skills' },
      categories: [{ name: 'Session', pairs: [['/status', 'Show status']] }],
      pairs: [
        ['/reload-skills', 'Reload skills'],
        ['/dogfood', 'Run dogfood skill']
      ],
      skill_count: 1,
      warning: ''
    })
  })

  test('malformed values fail closed instead of reaching slash state', () => {
    expect(decodeSessionStatusResponse({ output: 1 })).toBeUndefined()
    expect(decodeSessionTitleResponse({ pending: false })).toBeUndefined()
    expect(decodeSessionSaveResponse({ file: null })).toBeUndefined()
    expect(decodeReloadEnvResponse({ updated: '2' })).toBeUndefined()
    expect(decodeReloadMcpResponse({ status: 'done' })).toBeUndefined()
    expect(decodeConfigValueResponse({ value: 1 })).toBeUndefined()
    expect(decodeConfigFullResponse({ config: null })).toBeUndefined()
    expect(decodeConfigMtimeResponse({ mtime: 'now' })).toBeUndefined()
    expect(decodeSessionSteerResponse({ status: 'accepted' })).toBeUndefined()
    expect(decodeSessionUndoResponse({ removed: '2' })).toBeUndefined()
    expect(decodeSkillsReloadResponse({ output: ['nope'], result: {} })).toBeUndefined()
    expect(decodeSkillsReloadResponse({ output: 'ok' })).toBeUndefined()
    expect(decodeCommandsCatalogResponse({ pairs: [['/bad', 1]] })).toBeUndefined()
    expect(
      decodeCommandsCatalogResponse({ categories: [{ name: 'Bad', pairs: [['/ok', 1]] }], pairs: [] })
    ).toBeUndefined()
  })

  test('prompt.submit ack: only an explicit voice_stopped:true marks a consumed no-turn stop phrase', () => {
    // {voice_stopped:true} (upstream ba13132298) means the gateway ended the
    // voice chat instead of starting a turn — the entry releases the pending
    // prompt on this signal, so a plain ack must NOT look like one.
    expect(decodePromptSubmitAck({ voice_stopped: true })).toEqual({ voice_stopped: true })
    expect(decodePromptSubmitAck({ ok: true })?.voice_stopped).toBeUndefined()
    expect(decodePromptSubmitAck({})?.voice_stopped).toBeUndefined()
    expect(decodePromptSubmitAck(undefined)).toBeUndefined()
    expect(decodePromptSubmitAck({ voice_stopped: 'yes' })).toBeUndefined()
  })

  test('only an explicit steer rejection proves non-admission', () => {
    expect(classifySessionSteerResponse({ status: 'queued' })).toBe('accepted')
    expect(classifySessionSteerResponse({ status: 'rejected' })).toBe('rejected')
    expect(classifySessionSteerResponse({ status: 'accepted' })).toBe('uncertain')
    expect(classifySessionSteerResponse({})).toBe('uncertain')
    expect(classifySessionSteerResponse(null)).toBe('uncertain')
  })
})
