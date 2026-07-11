import { describe, expect, test } from 'vitest'

import {
  decodeCommandsCatalogResponse,
  decodeReloadEnvResponse,
  decodeSessionSaveResponse,
  decodeSessionStatusResponse,
  decodeSessionTitleResponse,
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
    expect(decodeSkillsReloadResponse({ output: ['nope'], result: {} })).toBeUndefined()
    expect(decodeSkillsReloadResponse({ output: 'ok' })).toBeUndefined()
    expect(decodeCommandsCatalogResponse({ pairs: [['/bad', 1]] })).toBeUndefined()
    expect(
      decodeCommandsCatalogResponse({ categories: [{ name: 'Bad', pairs: [['/ok', 1]] }], pairs: [] })
    ).toBeUndefined()
  })
})
