import { describe, expect, test } from 'vitest'

import {
  actionExitBlocked,
  actionModifier,
  isActionHotkey,
  isExitHotkey,
  isRedrawHotkey,
  openTuiHotkeys
} from '../logic/hotkeys.ts'

const key = (
  name: string,
  overrides: Partial<{ ctrl: boolean; eventType: string; meta: boolean; super: boolean }> = {}
) => ({
  ctrl: false,
  meta: false,
  name,
  ...overrides
})

describe('platform action hotkeys', () => {
  test('redraw is Ctrl+L off macOS and Cmd+L on macOS, never on release', () => {
    expect(isRedrawHotkey(key('l', { ctrl: true }), 'linux')).toBe(true)
    expect(isRedrawHotkey(key('l', { meta: true }), 'linux')).toBe(false)
    expect(isRedrawHotkey(key('l', { meta: true }), 'darwin')).toBe(true)
    expect(isRedrawHotkey(key('l', { super: true }), 'darwin')).toBe(true)
    expect(isRedrawHotkey(key('l', { ctrl: true }), 'darwin')).toBe(false)
    expect(isRedrawHotkey(key('l', { ctrl: true, eventType: 'release' }), 'linux')).toBe(false)
  })

  test('exit is action+D with the same platform mapping', () => {
    expect(isExitHotkey(key('d', { ctrl: true }), 'linux')).toBe(true)
    expect(isExitHotkey(key('d', { meta: true }), 'darwin')).toBe(true)
    expect(isExitHotkey(key('d', { ctrl: true }), 'darwin')).toBe(false)
    expect(isExitHotkey(key('d', { meta: true, eventType: 'release' }), 'darwin')).toBe(false)
  })

  test('generic action hotkeys use the same platform/release rules', () => {
    expect(isActionHotkey(key('k', { ctrl: true }), 'k', 'linux')).toBe(true)
    expect(isActionHotkey(key('k', { meta: true }), 'k', 'darwin')).toBe(true)
    expect(isActionHotkey(key('k', { ctrl: true }), 'k', 'darwin')).toBe(false)
    expect(isActionHotkey(key('k', { ctrl: true, eventType: 'release' }), 'k', 'linux')).toBe(false)
  })

  test('help copy derives the action modifier from the same source', () => {
    expect(actionModifier('linux')).toBe('Ctrl')
    expect(actionModifier('darwin')).toBe('Cmd')
    expect(openTuiHotkeys('linux')).toContainEqual(['Ctrl+D', 'exit'])
    expect(openTuiHotkeys('darwin')).toContainEqual(['Cmd+D', 'exit'])
    expect(openTuiHotkeys('linux')).toContainEqual(['Ctrl+L', 'redraw / repaint'])
    expect(openTuiHotkeys('darwin')).toContainEqual(['Cmd+L', 'redraw / repaint'])
    expect(openTuiHotkeys('linux').some(([label]) => label === 'Ctrl+K')).toBe(false)
    expect(openTuiHotkeys('darwin').some(([label]) => label === 'Cmd+K')).toBe(false)
    expect(openTuiHotkeys('linux')).toContainEqual([
      'Enter Enter (empty)',
      'stop the turn / force the next queued message'
    ])
  })

  test.each(['prompt', 'pager', 'sessionPicker', 'picker', 'billing'] as const)(
    'action+D is blocked while the %s overlay owns input',
    field => {
      const state = {
        backgroundPanel: false,
        billing: undefined,
        dashboard: false,
        pager: undefined,
        picker: undefined,
        prompt: undefined,
        promptHistory: false,
        sessionPicker: undefined,
        [field]: {}
      }
      expect(actionExitBlocked(state)).toBe(true)
    }
  )

  test.each(['dashboard', 'backgroundPanel', 'promptHistory'] as const)(
    'action+D is blocked while the %s overlay owns input',
    field => {
      const state = {
        backgroundPanel: false,
        billing: undefined,
        dashboard: false,
        pager: undefined,
        picker: undefined,
        prompt: undefined,
        promptHistory: false,
        sessionPicker: undefined,
        [field]: true
      }
      expect(actionExitBlocked(state)).toBe(true)
    }
  )

  test('action+D is allowed only when no overlay owns input', () => {
    expect(
      actionExitBlocked({
        backgroundPanel: false,
        billing: undefined,
        dashboard: false,
        pager: undefined,
        picker: undefined,
        prompt: undefined,
        promptHistory: false,
        sessionPicker: undefined
      })
    ).toBe(false)
  })
})
