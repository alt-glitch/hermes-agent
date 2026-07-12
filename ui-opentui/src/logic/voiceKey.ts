import type { KeyEvent } from '@opentui/core'

export type VoiceKeyModifier = 'alt' | 'ctrl' | 'super'

export interface VoiceRecordKey {
  readonly key: string
  readonly modifier: VoiceKeyModifier
  readonly raw: string
}

export const DEFAULT_VOICE_RECORD_KEY: VoiceRecordKey = { key: 'b', modifier: 'ctrl', raw: 'ctrl+b' }

const MODIFIERS: Record<string, VoiceKeyModifier> = {
  alt: 'alt',
  control: 'ctrl',
  ctrl: 'ctrl',
  opt: 'alt',
  option: 'alt',
  super: 'super',
  win: 'super',
  windows: 'super'
}
const KEY_ALIASES: Record<string, string> = {
  bs: 'backspace',
  del: 'delete',
  esc: 'escape',
  ret: 'return',
  enter: 'return',
  return: 'return',
  spc: 'space'
}
const NAMED = new Set(['backspace', 'delete', 'escape', 'return', 'space', 'tab'])
const RESERVED_CTRL = new Set(['c', 'd', 'l'])

export function parseVoiceRecordKey(value: unknown): VoiceRecordKey {
  if (typeof value !== 'string') return DEFAULT_VOICE_RECORD_KEY
  const parts = value.trim().toLowerCase().replace(/\s+/g, '').split('+')
  if (parts.length !== 2) return DEFAULT_VOICE_RECORD_KEY
  const modifier = MODIFIERS[parts[0] ?? '']
  const rawKey = parts[1] ?? ''
  const key = KEY_ALIASES[rawKey] ?? rawKey
  if (!modifier || (!NAMED.has(key) && [...key].length !== 1)) return DEFAULT_VOICE_RECORD_KEY
  if (modifier === 'ctrl' && RESERVED_CTRL.has(key)) return DEFAULT_VOICE_RECORD_KEY
  return { key, modifier, raw: `${modifier}+${rawKey}` }
}

export function formatVoiceRecordKey(value: unknown): string {
  const parsed = typeof value === 'string' ? parseVoiceRecordKey(value) : DEFAULT_VOICE_RECORD_KEY
  const modifier =
    parsed.modifier === 'ctrl'
      ? 'Ctrl'
      : parsed.modifier === 'alt'
        ? 'Alt'
        : process.platform === 'darwin'
          ? 'Cmd'
          : 'Super'
  const key = parsed.key === 'return' ? 'Enter' : parsed.key.charAt(0).toUpperCase() + parsed.key.slice(1)
  return `${modifier}+${key}`
}

export function isVoiceRecordKey(event: KeyEvent, configured: unknown): boolean {
  if (event.eventType === 'release' || event.shift) return false
  const parsed = parseVoiceRecordKey(configured)
  const modifier =
    parsed.modifier === 'ctrl'
      ? event.ctrl && !event.option && !event.super
      : parsed.modifier === 'alt'
        ? event.option && !event.ctrl && !event.super
        : event.super === true && !event.ctrl && !event.option
  if (!modifier) return false
  return event.name.toLowerCase() === parsed.key
}

export function voiceRecordKeyFromConfig(config: unknown): string {
  if (!config || typeof config !== 'object') return DEFAULT_VOICE_RECORD_KEY.raw
  const voice = (config as { voice?: unknown }).voice
  if (!voice || typeof voice !== 'object') return DEFAULT_VOICE_RECORD_KEY.raw
  return parseVoiceRecordKey((voice as { record_key?: unknown }).record_key).raw
}
