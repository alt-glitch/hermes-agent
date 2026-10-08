/**
 * Clarify unified question/result shape (Ink parity 5eea87882a): multi-select checkbox
 * questions answered as a raw JSON array, blank submit = skip (null), Esc = cancel ({}),
 * an empty questions list answered {} at once, and null prior answers read as skips.
 */
import { describe, expect, test } from 'vitest'

import { createServerRequestRouter, decodeServerRequest } from '../boundary/gateway/serverRequests.ts'
import type { PromptReply, PromptResponseDisposition } from '../boundary/promptResponses.ts'
import {
  clarifyAnswerText,
  clarifyMultiAnswer,
  clarifyRevisitState,
  formatAbandonedClarifyBatch
} from '../logic/clarifyBatch.ts'
import { createSessionStore } from '../logic/store.ts'
import { PromptOverlay } from '../view/prompts/promptOverlay.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

const theme = createSessionStore().state.theme
const ACCEPTED = { kind: 'accepted' } as const satisfies PromptResponseDisposition

type Store = ReturnType<typeof createSessionStore>

function openClarify(store: Store, id: string, params: Record<string, unknown>): void {
  const decoded = decodeServerRequest({
    id,
    method: 'clarify',
    params: { session_id: 'live-1', ...params },
    respond: () => false
  })
  if (typeof decoded === 'string') throw new Error(`clarify ${id}: ${decoded}`)
  store.openPrompt(decoded.prompt)
}

async function mountOverlay(store: Store, sent: PromptReply[]): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => theme}>
        <PromptOverlay
          store={store}
          onRespond={reply => {
            sent.push(reply)
            return Promise.resolve(ACCEPTED)
          }}
        />
      </ThemeProvider>
    ),
    { height: 30, kittyKeyboard: true, width: 80 }
  )
}

const MULTI_ONE = {
  questions: [{ qid: 'q0', question: 'Toppings?', choices: ['ham', 'olive', 'onion'], multi_select: true }]
}

describe('multi-select single question', () => {
  test('Space and digits toggle checkboxes; Enter answers the picks as a JSON array', async () => {
    const store = createSessionStore()
    openClarify(store, 'req-multi', MULTI_ONE)
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      expect(h.frame()).toContain('[ ] 1. ')
      h.keys.pressKey(' ') // toggle ham (highlighted)
      await h.settle()
      h.keys.pressKey('3') // toggle onion — a digit toggles, it does not answer
      await h.settle()
      expect(sent).toHaveLength(0)
      const frame = h.frame()
      expect(frame).toContain('[x] 1. ')
      expect(frame).toContain('[ ] 2. ')
      expect(frame).toContain('[x] 3. ')
      expect(frame).toContain('toggle')
      h.keys.pressEnter()
      await expect.poll(() => sent).toHaveLength(1)
      expect(sent[0]).toEqual({
        kind: 'answer',
        requestId: 'req-multi',
        result: { answers: { q0: JSON.stringify(['ham', 'onion']) } }
      })
    } finally {
      h.destroy()
    }
  })

  test('Enter with nothing picked answers the highlighted choice as a one-item array', async () => {
    const store = createSessionStore()
    openClarify(store, 'req-multi-hl', MULTI_ONE)
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      h.keys.pressArrow('down')
      await h.settle()
      h.keys.pressEnter()
      await expect.poll(() => sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ result: { answers: { q0: '["olive"]' } } })
    } finally {
      h.destroy()
    }
  })

  test('typed custom text joins the picks', async () => {
    const store = createSessionStore()
    openClarify(store, 'req-multi-typed', MULTI_ONE)
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      h.keys.pressKey('2')
      await h.settle()
      for (let i = 0; i < 3; i++) h.keys.pressArrow('down')
      await h.settle()
      await h.keys.typeText('pineapple')
      await h.settle()
      h.keys.pressEnter()
      await expect.poll(() => sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ result: { answers: { q0: '["olive","pineapple"]' } } })
    } finally {
      h.destroy()
    }
  })

  test('a blank submit with nothing picked is a skip (null)', async () => {
    const store = createSessionStore()
    openClarify(store, 'req-multi-skip', MULTI_ONE)
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      for (let i = 0; i < 3; i++) h.keys.pressArrow('down')
      await h.settle()
      h.keys.pressEnter()
      await expect.poll(() => sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ result: { answers: { q0: null } } })
    } finally {
      h.destroy()
    }
  })
})

const BATCH = {
  questions: [
    { qid: 'q0', question: 'Toppings?', choices: ['ham', 'olive'], multi_select: true },
    { qid: 'q1', question: 'Name?' }
  ]
}

describe('multi-select / skip / cancel in a batch', () => {
  test('a multi-select lock carries the JSON array; its locked line and revisit show the picks', async () => {
    const store = createSessionStore()
    openClarify(store, 'req-b', BATCH)
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      h.keys.pressKey('1')
      h.keys.pressKey('2')
      await h.settle()
      h.keys.pressEnter()
      await expect.poll(() => sent).toHaveLength(1)
      expect(sent[0]).toEqual({ kind: 'lock', requestId: 'req-b', questionId: 'q0', answer: '["ham","olive"]' })
      // The local mirror keeps the raw array; the locked line formats it.
      await expect.poll(() => store.state.prompt).toMatchObject({ answers: { q0: '["ham","olive"]' } })
      await expect.poll(() => h.frame()).toContain('→ ham, olive')
      // Revisit q0: both checkboxes come back ticked.
      h.keys.pressTab()
      await h.settle()
      const frame = h.frame()
      expect(frame).toContain('[x] 1. ')
      expect(frame).toContain('[x] 2. ')
    } finally {
      h.destroy()
    }
  })

  test('a blank submit locks null (skipped) and records an empty local lock', async () => {
    const store = createSessionStore()
    openClarify(store, 'req-skip', { ...BATCH, answers: { q0: '["ham"]' } })
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      await h.keys.typeText('   ')
      await h.settle()
      h.keys.pressEnter()
      await expect.poll(() => sent).toHaveLength(1)
      expect(sent[0]).toEqual({ kind: 'lock', requestId: 'req-skip', questionId: 'q1', answer: null })
    } finally {
      h.destroy()
    }
  })

  test('Esc cancels the batch with a response that carries no answers', async () => {
    const store = createSessionStore()
    openClarify(store, 'req-cancel', BATCH)
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      h.keys.pressKey('1')
      await h.settle()
      h.keys.pressEscape()
      await expect.poll(() => sent).toHaveLength(1)
      expect(sent[0]).toEqual({ kind: 'answer', requestId: 'req-cancel', result: {} })
    } finally {
      h.destroy()
    }
  })
})

describe('clarify request shape at the boundary', () => {
  test('an empty (or unaskable) questions list is answered {} at once and opens nothing', () => {
    const opened: unknown[] = []
    const router = createServerRequestRouter({
      openPrompt: prompt => opened.push(prompt),
      displayedSessionId: () => 's',
      settleWithdrawn: () => {}
    })
    try {
      for (const [id, questions] of [
        ['srq-empty', []],
        [
          'srq-blank',
          [
            { qid: '', question: 'no qid' },
            { qid: 'q1', question: '  ' }
          ]
        ]
      ] as const) {
        const written: unknown[] = []
        const disposition = router.handle({
          id,
          method: 'clarify',
          params: { session_id: 's', questions },
          respond: result => written.push(result) > 0
        })
        expect(disposition).toBe('held') // no error frame
        expect(written).toEqual([{}])
        // Nothing is held: a later answer finds it closed.
        expect(router.answer(id, { answers: {} })).toBe('closed')
      }
      expect(opened).toEqual([])
      expect(router.pending()).toEqual([])
    } finally {
      router.dispose()
    }
  })

  test('a single multi-select question opens the card in checkbox mode', () => {
    const store = createSessionStore()
    openClarify(store, 'req-shape', MULTI_ONE)
    expect(store.state.prompt).toMatchObject({ kind: 'clarify', qid: 'q0', multiSelect: true })
  })

  test('null prior answers (reconnect replay) read as skips', () => {
    const store = createSessionStore()
    openClarify(store, 'req-null', { ...BATCH, answers: { q0: null } })
    expect(store.state.prompt).toMatchObject({ answers: { q0: '' } })
    expect(store.recordClarifyAnswer('q1', 'Ada')).toBe(0)
  })
})

describe('multi-select answer helpers', () => {
  test('revisit restores picks, staging non-choice items as typed text', () => {
    expect(clarifyRevisitState(['a', 'b'], '["a","b"]', true)).toEqual({ custom: '', picked: ['a', 'b'], selected: 0 })
    expect(clarifyRevisitState(['a', 'b'], '["b","zz"]', true)).toEqual({ custom: 'zz', picked: ['b'], selected: 2 })
    // Not multi-select: the JSON string is just a typed answer.
    expect(clarifyRevisitState(['a'], '["a"]')).toEqual({ custom: '["a"]', picked: [], selected: 1 })
  })

  test('answers are a JSON array or empty; display text joins the items', () => {
    expect(clarifyMultiAnswer(['a'], [' x ', ''])).toBe('["a","x"]')
    expect(clarifyMultiAnswer([], ['  '])).toBe('')
    expect(clarifyAnswerText('["a","b"]', true)).toBe('a, b')
    expect(clarifyAnswerText('["a","b"]')).toBe('["a","b"]')
    expect(clarifyAnswerText('plain', true)).toBe('plain')
  })

  test('the abandoned record formats multi-select locks', () => {
    const text = formatAbandonedClarifyBatch(
      [
        { qid: 'q0', question: 'T?', multiSelect: true },
        { qid: 'q1', question: 'N?' }
      ],
      { q0: '["ham","olive"]' },
      'cancelled'
    )
    expect(text).toContain('✓ T? → ham, olive')
    expect(text).toContain('· N? (no answer)')
  })
})
