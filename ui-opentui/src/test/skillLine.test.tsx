/**
 * Skill slash-command row (glitch 2026-06-23) — the collapsed render + store wiring.
 *   1. store: pushSkill → a `user` message with the FULL body in `text` (so the
 *      model + /copy still see it) AND `skill` metadata for the collapsed render.
 *   2. frame: SkillLine renders the `▶` caret + the `/command` + `· N lines`
 *      header, and does NOT dump the full body when collapsed.
 *
 * NOTE: the expanded body is a native `<markdown>` which does NOT paint in the
 * headless test renderer (render.test.tsx:38-40) — so the EXPANDED body text is
 * not frame-assertable here; the collapsed header (plain <text>/<span>) is. The
 * "collapsed hides the body" assertion is the load-bearing one for this feature.
 */
import { describe, expect, test } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { SkillLine } from '../view/skillLine.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame } from './lib/render.ts'

describe('pushSkill store wiring', () => {
  test('pushSkill pushes a user row with the full body in text + skill metadata', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const body = '# Dogfood Skill\n\nLine 2\nLine 3\nLine 4'
    store.pushSkill('/dogfood', body)
    const last = store.state.messages.at(-1)
    expect(last?.role).toBe('user') // correct API semantics — it IS the user's turn
    expect(last?.text).toBe(body) // FULL body preserved (the model + /copy see it)
    expect(last?.skill?.command).toBe('/dogfood')
    expect(last?.skill?.lineCount).toBe(5) // 5 lines in the body
  })

  test('the command preserves args verbatim', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushSkill('/triage-nous since yesterday', 'one line body')
    expect(store.state.messages.at(-1)?.skill?.command).toBe('/triage-nous since yesterday')
    expect(store.state.messages.at(-1)?.skill?.lineCount).toBe(1)
  })

  test('an empty body still records a skill row (lineCount 0)', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushSkill('/x', '')
    expect(store.state.messages.at(-1)?.skill?.lineCount).toBe(0)
  })
})

describe('SkillLine frame', () => {
  test('collapsed: shows ▶ caret + /command + line count, NOT the body', async () => {
    const body = 'SECRET_BODY_MARKER line one\nline two\nline three'
    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => createSessionStore().state.theme}>
          <SkillLine message={{ role: 'user', text: body, skill: { command: '/dogfood', lineCount: 3 } }} />
        </ThemeProvider>
      ),
      { width: 70, height: 6 }
    )
    expect(frame).toContain('▶') // collapsed caret (there's a body to expand)
    expect(frame).toContain('/dogfood') // the command identity
    expect(frame).toContain('3 lines') // honest body size
    expect(frame).not.toContain('SECRET_BODY_MARKER') // body stays hidden when collapsed
  })

  test('a body-less skill row shows no expand caret', async () => {
    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => createSessionStore().state.theme}>
          <SkillLine message={{ role: 'user', text: '', skill: { command: '/x', lineCount: 0 } }} />
        </ThemeProvider>
      ),
      { width: 60, height: 4 }
    )
    expect(frame).toContain('/x')
    expect(frame).not.toContain('▶')
    expect(frame).not.toContain('▼')
  })
})
