import { describe, expect, test } from 'vitest'

import {
  formatVoiceRecordKey,
  isVoiceRecordKey,
  parseVoiceRecordKey,
  voiceRecordKeyFromConfig
} from '../logic/voiceKey.ts'

const key = (over: Record<string, unknown>) =>
  ({
    ctrl: false,
    eventType: 'press',
    meta: false,
    name: 'b',
    option: false,
    preventDefault: () => {},
    shift: false,
    super: false,
    ...over
  }) as never

describe('voice record key', () => {
  test('parses supported config aliases and rejects reserved/dead chords', () => {
    expect(parseVoiceRecordKey('control + O')).toEqual({ key: 'o', modifier: 'ctrl', raw: 'ctrl+o' })
    expect(parseVoiceRecordKey('option+return')).toEqual({ key: 'return', modifier: 'alt', raw: 'alt+return' })
    expect(parseVoiceRecordKey('ctrl+c').raw).toBe('ctrl+b')
    expect(parseVoiceRecordKey('ctrl+f5').raw).toBe('ctrl+b')
  })

  test('matches native OpenTUI modifier/name fields exactly', () => {
    expect(isVoiceRecordKey(key({ ctrl: true, name: 'o' }), 'ctrl+o')).toBe(true)
    expect(isVoiceRecordKey(key({ ctrl: true, option: true, name: 'o' }), 'ctrl+o')).toBe(false)
    expect(isVoiceRecordKey(key({ name: 'return', option: true }), 'alt+enter')).toBe(true)
    expect(isVoiceRecordKey(key({ ctrl: true, eventType: 'release' }), 'ctrl+b')).toBe(false)
  })

  test('formats chrome labels and shape-safely hydrates config', () => {
    expect(formatVoiceRecordKey('ctrl+space')).toBe('Ctrl+Space')
    expect(voiceRecordKeyFromConfig({ voice: { record_key: 'alt+r' } })).toBe('alt+r')
    expect(voiceRecordKeyFromConfig({ voice: true })).toBe('ctrl+b')
  })
})
