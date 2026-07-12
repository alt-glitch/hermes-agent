import { describe, expect, test } from 'vitest'

import {
  activeSessionCountLabel,
  canTypeOrchestratorPrompt,
  clampOrchestratorSelection,
  closeFallbackAfterClose,
  currentSessionSelectionIndex,
  draftModelArgFromPickerValue,
  draftModelDisplayLabel,
  draftTitleFromPrompt,
  isNewSessionRow,
  newSessionRowIndex,
  orchestratorContextHint,
  orchestratorGlobalHotkeyHint,
  orchestratorRowClickAction,
  orchestratorVisibleRowIndexes,
  reanchorOrchestratorSelection,
  relativeSessionAge,
  resumableHistory,
  sessionRowKindAt,
  sessionsCountLabel,
  sessionStatusGlyph,
  sessionStatusLabel,
  shortSessionModel,
  unifiedSessionRowAction,
  type ActiveSessionRow,
  type SessionHistoryRow
} from '../logic/sessionOrchestrator.ts'

const live = (id: string, extra: Omit<ActiveSessionRow, 'id'> = {}): ActiveSessionRow => ({ id, ...extra })
const historical = (id: string): SessionHistoryRow => ({
  id,
  message_count: 1,
  preview: '',
  started_at: 1,
  title: id
})

describe('session orchestrator contracts', () => {
  test('maps the unified [new][live][history] row order', () => {
    expect([0, 1, 2, 3, 9].map(index => sessionRowKindAt(index, 2))).toEqual([
      'new',
      'live',
      'live',
      'history',
      'history'
    ])
    expect(sessionRowKindAt(1, 0)).toBe('history')
  })

  test('deduplicates history against live ids without disturbing order', () => {
    const history = [historical('a'), historical('b'), historical('c')]
    expect(resumableHistory(history, [live('b')]).map(row => row.id)).toEqual(['a', 'c'])
    expect(resumableHistory(history, [live('ephemeral-b', { session_key: 'b' })]).map(row => row.id)).toEqual([
      'a',
      'c'
    ])
    expect(resumableHistory(history, [live('ephemeral-b', { session_key: '   ' })]).map(row => row.id)).toEqual([
      'a',
      'b',
      'c'
    ])
    expect(resumableHistory(history, []).map(row => row.id)).toEqual(['a', 'b', 'c'])
  })

  test('formats statuses, models, counts, and stable relative ages', () => {
    expect(sessionStatusGlyph('working')).toBe('▶')
    expect(sessionStatusGlyph('custom')).toBe('·')
    expect(sessionStatusLabel('waiting')).toBe('waiting')
    expect(sessionStatusLabel('custom')).toBe('custom')
    expect(shortSessionModel('openai/gpt-5.5')).toBe('gpt-5.5')
    expect(activeSessionCountLabel(1)).toBe('1 live session')
    expect(activeSessionCountLabel(3)).toBe('3 live sessions')
    expect(sessionsCountLabel(2, 7)).toBe('2 live · 7 resumable')
    const now = 10 * 86400 * 1000
    expect(relativeSessionAge(10 * 86400, now)).toBe('today')
    expect(relativeSessionAge(8.5 * 86400, now)).toBe('yesterday')
    expect(relativeSessionAge(7 * 86400, now)).toBe('3d ago')
    expect(relativeSessionAge(undefined, now)).toBe('')
  })

  test('preserves the current session and windows around selection', () => {
    const sessions = [live('first'), live('second', { current: true }), live('third')]
    expect(currentSessionSelectionIndex(sessions, 'second')).toBe(1)
    expect(currentSessionSelectionIndex([live('first'), live('third')], 'third')).toBe(1)
    expect(currentSessionSelectionIndex(sessions, 'missing')).toBe(1)
    expect(currentSessionSelectionIndex([], 'missing')).toBe(0)
    expect(orchestratorVisibleRowIndexes(3, 3, 12)).toEqual([0, 1, 2, 3])
    expect(orchestratorVisibleRowIndexes(13, 13, 12)).toContain(13)
    expect(orchestratorVisibleRowIndexes(13, -20, 4)).toEqual([0, 1, 2, 3])
  })

  test('reanchors by identity when polling inserts or removes sessions', () => {
    expect(
      reanchorOrchestratorSelection(
        2,
        [live('a'), live('b')],
        [historical('h')],
        [live('x'), live('a'), live('b')],
        [historical('h')]
      )
    ).toBe(3)
    expect(
      reanchorOrchestratorSelection(
        3,
        [live('a')],
        [historical('h1'), historical('h2')],
        [live('x'), live('a')],
        [historical('h2'), historical('h1')]
      )
    ).toBe(3)
    expect(reanchorOrchestratorSelection(0, [live('a')], [], [], [])).toBe(0)
  })

  test('keeps the pinned New row selectable and prompt-only', () => {
    expect(newSessionRowIndex(3)).toBe(3)
    expect(clampOrchestratorSelection(-5, 2)).toBe(0)
    expect(clampOrchestratorSelection(99, 2)).toBe(2)
    expect(isNewSessionRow(2, 2)).toBe(true)
    expect(canTypeOrchestratorPrompt(1, 2)).toBe(false)
    expect(canTypeOrchestratorPrompt(2, 2)).toBe(true)
  })

  test('chooses safe close fallbacks', () => {
    const remaining = [live('next'), live('other')]
    expect(closeFallbackAfterClose('other', 'current', remaining)).toEqual({ action: 'stay' })
    expect(closeFallbackAfterClose('current', 'current', remaining)).toEqual({ action: 'activate', sessionId: 'next' })
    expect(closeFallbackAfterClose('current', 'current', [])).toEqual({ action: 'new' })
  })

  test('maps legacy and unified row clicks without guessing missing rows', () => {
    const sessions = [live('a'), live('b')]
    expect(orchestratorRowClickAction(1, sessions)).toEqual({ action: 'activate', sessionId: 'b' })
    expect(orchestratorRowClickAction(2, sessions)).toEqual({ action: 'select-new' })
    expect(unifiedSessionRowAction(0, sessions, [historical('h')])).toEqual({ action: 'select-new' })
    expect(unifiedSessionRowAction(2, sessions, [historical('h')])).toEqual({ action: 'activate', sessionId: 'b' })
    expect(unifiedSessionRowAction(3, sessions, [historical('h')])).toEqual({ action: 'resume', sessionId: 'h' })
    expect(unifiedSessionRowAction(99, sessions, [historical('h')])).toEqual({ action: 'select-new' })
  })

  test('normalizes picker args and derives compact prompt presentation', () => {
    expect(draftModelArgFromPickerValue('kimi-k2.6 --provider ollama-cloud --tui-session')).toBe(
      'kimi-k2.6 --provider ollama-cloud'
    )
    expect(draftModelDisplayLabel('openai/gpt-5.5 --provider openai-codex --global')).toBe('gpt-5.5')
    expect(draftModelDisplayLabel('')).toBe('current/default')
    expect(draftTitleFromPrompt('  Build the websocket orchestrator panel and make it robust.  ', 24)).toBe(
      'Build the websocket orc…'
    )
  })

  test('keeps hotkey help compact and contextual', () => {
    expect(orchestratorContextHint(false)).toBe('Session row: Enter switch · Ctrl+D close')
    expect(orchestratorContextHint(true)).toBe('New row: type prompt · Enter start · Tab model')
    expect(orchestratorGlobalHotkeyHint).toBe('↑↓ move · Ctrl+N new · Ctrl+R refresh · Esc close')
  })
})
