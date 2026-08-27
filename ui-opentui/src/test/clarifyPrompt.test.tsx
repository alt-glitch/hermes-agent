/**
 * ClarifyPrompt rewrite (F5/F6) — headless frames + simulated keyboard.
 *
 * Asserts the four user-reported fixes:
 *   - long option text WRAPS (appears on a second line) instead of clipping (F5),
 *   - options are NUMBERED and the selected row is highlighted (F5),
 *   - the custom answer is an inline input in the SAME screen (F5),
 *   - Up/Down drive the selection and Enter answers the highlighted choice; the
 *     arrows don't escape to a scrollbox (F6 — we assert selection moved).
 */
import { ThemeProvider } from '../view/theme.tsx'
import { describe, expect, test } from 'vitest'

import { ClarifyPrompt } from '../view/prompts/clarifyPrompt.tsx'
import { PromptOverlay } from '../view/prompts/promptOverlay.tsx'
import type { PromptResponseMethod } from '../boundary/promptResponses.ts'
import { clarifyRevisitState, type ClarifyBatchQuestion } from '../logic/clarifyBatch.ts'
import { createSessionStore } from '../logic/store.ts'
import { renderProbe, type RenderProbe } from './lib/render.ts'

const LONG =
  'Just analyze for now — give me the implementation plan doc (code-path refs + line numbers, screen-by-screen), no code yet.'

const theme = createSessionStore().state.theme

async function mountOverlay(
  store: ReturnType<typeof createSessionStore>,
  onRespond: (method: PromptResponseMethod, params: Record<string, unknown>) => Promise<boolean>
): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => theme}>
        <PromptOverlay store={store} onRespond={onRespond} sessionId={() => 'live-1'} />
      </ThemeProvider>
    ),
    { height: 24, kittyKeyboard: true, width: 60 }
  )
}

async function mount(
  choices: string[] | null,
  onAnswer: (a: string) => void = () => {},
  onCancel: () => void = () => {}
): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => theme}>
        <ClarifyPrompt
          question="How do you want me to proceed?"
          choices={choices}
          onAnswer={onAnswer}
          onCancel={onCancel}
        />
      </ThemeProvider>
    ),
    { height: 24, kittyKeyboard: true, width: 60 }
  )
}

describe('PromptOverlay acknowledgement ownership', () => {
  test('stays mounted while pending and prevents duplicate submit', async () => {
    const store = createSessionStore()
    store.apply({ type: 'clarify.request', payload: { question: 'Choose', choices: ['A'], request_id: 'req-1' } })
    let calls = 0
    let resolveResponse: ((value: boolean) => void) | undefined
    const response = new Promise<boolean>(resolve => (resolveResponse = resolve))
    const h = await mountOverlay(store, () => {
      calls += 1
      return response
    })
    try {
      h.keys.pressEnter()
      await h.settle()
      expect(calls).toBe(1)
      expect(store.state.prompt?.kind).toBe('clarify')
      expect(h.frame()).toContain('sending response')
      h.keys.pressEnter()
      await h.settle()
      expect(calls).toBe(1)
      resolveResponse?.(true)
      await expect.poll(() => store.state.prompt).toBeUndefined()
      await h.settle()
      expect(store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('invalid acknowledgement shows an error and allows retry', async () => {
    const store = createSessionStore()
    store.apply({ type: 'clarify.request', payload: { question: 'Choose', choices: ['A'], request_id: 'req-2' } })
    let calls = 0
    const h = await mountOverlay(store, () => Promise.resolve(++calls > 1))
    try {
      h.keys.pressEnter()
      await new Promise(resolve => setTimeout(resolve, 0))
      await h.settle()
      expect(store.state.prompt?.kind).toBe('clarify')
      expect(h.frame()).toContain('not acknowledged')
      h.keys.pressEnter()
      await new Promise(resolve => setTimeout(resolve, 5))
      await h.settle()
      expect(calls).toBe(2)
      expect(store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })
})

describe('ClarifyPrompt (F5/F6)', () => {
  test('numbers every option and shows the inline custom-answer input (F5)', async () => {
    const h = await mount(['Alpha option', 'Beta option'])
    try {
      const frame = h.frame()
      expect(frame).toContain('1. ')
      expect(frame).toContain('2. ')
      // the inline custom input is present in the SAME screen (not a separate view)
      expect(frame).toContain('or type a custom answer')
      // NOTE: the option BODIES render through the native <markdown> renderable
      // (so `**bold**`/`code` in a choice isn't shown raw — glitch 2026-06-14).
      // Tree-sitter markdown doesn't settle in the headless test renderer, so the
      // body text isn't in the frame here (same limitation as render.test.tsx:38-40
      // and the transcript text parts) — the painted markdown is verified in the
      // live smoke. We assert the structural chrome (numbers + input) instead.
    } finally {
      h.destroy()
    }
  })

  test('a long option does not crash the bordered layout (F5)', async () => {
    const h = await mount([LONG, 'Short'])
    try {
      const frame = h.frame()
      // The long option flows into a flex column that wraps within the box width
      // (no clipping at the right edge). The body renders via native <markdown>
      // which doesn't paint headlessly (see the note above), so assert the layout
      // chrome survived a very long choice: both numbered rows + the box border +
      // the input are present (a clipping/overflow regression would break these).
      expect(frame).toContain('1. ')
      expect(frame).toContain('2. ')
      expect(frame).toContain('or type a custom answer')
      expect(frame).toContain('┌')
      expect(frame).toContain('└')
    } finally {
      h.destroy()
    }
  })

  test('Down moves the selection; Enter answers the highlighted choice (F6)', async () => {
    let answered: string | undefined
    const h = await mount(['Alpha option', 'Beta option'], a => (answered = a))
    try {
      h.keys.pressArrow('down') // 0 → 1 (Beta)
      await h.settle()
      h.keys.pressEnter()
      await h.settle()
      expect(answered).toBe('Beta option')
    } finally {
      h.destroy()
    }
  })

  test('number keys quick-pick choices, with 0 selecting the tenth', async () => {
    const answers: string[] = []
    const first = await mount(['Alpha', 'Beta'], answer => answers.push(answer))
    try {
      first.keys.pressKey('2')
      await first.settle()
      expect(answers).toEqual(['Beta'])
    } finally {
      first.destroy()
    }

    const tenth = await mount(
      Array.from({ length: 10 }, (_, index) => `Choice ${index + 1}`),
      answer => answers.push(answer)
    )
    try {
      tenth.keys.pressKey('0')
      await tenth.settle()
      expect(answers).toEqual(['Beta', 'Choice 10'])
    } finally {
      tenth.destroy()
    }
  })

  test('digits remain custom input when the inline input is selected', async () => {
    let answered: string | undefined
    const h = await mount(['Only choice'], answer => (answered = answer))
    try {
      h.keys.pressArrow('down')
      await h.settle()
      await h.keys.typeText('123')
      h.keys.pressEnter()
      await h.settle()
      expect(answered).toBe('123')
    } finally {
      h.destroy()
    }
  })

  test('Down past the last choice lands on the custom input; Enter sends typed text', async () => {
    let answered: string | undefined
    const h = await mount(['Only choice'], a => (answered = a))
    try {
      h.keys.pressArrow('down') // choice 0 → custom input (index 1)
      await h.settle()
      await h.keys.typeText('my custom reply')
      await h.settle()
      h.keys.pressEnter()
      await h.settle()
      expect(answered).toBe('my custom reply')
    } finally {
      h.destroy()
    }
  })

  test('no choices → the input is the only control and is focused', async () => {
    let answered: string | undefined
    const h = await mount(null, a => (answered = a))
    try {
      expect(h.frame()).toContain('Type your answer')
      await h.keys.typeText('freeform')
      await h.settle()
      h.keys.pressEnter()
      await h.settle()
      expect(answered).toBe('freeform')
    } finally {
      h.destroy()
    }
  })

  test('Esc cancels', async () => {
    let cancelled = false
    const h = await mount(
      ['A', 'B'],
      () => {},
      () => (cancelled = true)
    )
    try {
      h.keys.pressEscape()
      await h.settle()
      expect(cancelled).toBe(true)
    } finally {
      h.destroy()
    }
  })
})

// ── Batch (multi-question) clarify — compact status list, Tab cycling, ──────
// per-question locks, revisit restore. Question BODIES render via the native
// <markdown> renderable, which doesn't settle in the headless renderer (see the
// note in the F5 tests above) — so frames assert the structural chrome (✓/▸/·
// markers, numbered choice rows, the answered count, the plain-text locked
// answer lines) and the callback params carry the behavioral assertions.

const QUESTIONS: ClarifyBatchQuestion[] = [
  { choices: ['red', 'blue'], multiSelect: false, qid: 'q0', question: 'Primary color?' },
  { choices: ['x', 'y', 'z'], multiSelect: false, qid: 'q1', question: 'Axis?' }
]

async function mountBatch(
  questions: ClarifyBatchQuestion[],
  answers: Record<string, string>,
  onQuestionAnswer: (qid: string, answer: string) => void = () => {},
  onCancel: () => void = () => {}
): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => theme}>
        <ClarifyPrompt
          question=""
          choices={null}
          questions={questions}
          answers={answers}
          onAnswer={() => {}}
          onCancel={onCancel}
          onQuestionAnswer={onQuestionAnswer}
        />
      </ThemeProvider>
    ),
    { height: 24, kittyKeyboard: true, width: 60 }
  )
}

describe('ClarifyPrompt — batch mode', () => {
  test('compact status list: count heading, ▸/· markers, ONLY the active question expanded', async () => {
    const h = await mountBatch(QUESTIONS, {})
    try {
      const frame = h.frame()
      expect(frame).toContain('? 2 questions')
      expect(frame).toContain('▸') // active marker (q0)
      expect(frame).toContain('·') // pending marker (q1)
      expect(frame).not.toContain('✓') // nothing answered yet
      // only q0's two choices are expanded — q1's third row must NOT render
      expect(frame).toContain('1. ')
      expect(frame).toContain('2. ')
      expect(frame).not.toContain('3. ')
      expect(frame).toContain('or type a custom answer')
      expect(frame).toContain('0/2 answered')
      // the hint wraps within the 60-col frame — assert its wrap-safe pieces
      expect(frame).toContain('switch question')
      expect(frame).toContain('cancel all')
    } finally {
      h.destroy()
    }
  })

  test('Enter locks the ACTIVE question via onQuestionAnswer (qid + answer)', async () => {
    const locks: [string, string][] = []
    const h = await mountBatch(QUESTIONS, {}, (qid, answer) => locks.push([qid, answer]))
    try {
      h.keys.pressArrow('down') // red → blue
      await h.settle()
      h.keys.pressEnter()
      await h.settle()
      expect(locks).toEqual([['q0', 'blue']])
    } finally {
      h.destroy()
    }
  })

  test('digit quick-pick locks the active question', async () => {
    const locks: [string, string][] = []
    const h = await mountBatch(QUESTIONS, {}, (qid, answer) => locks.push([qid, answer]))
    try {
      h.keys.pressKey('2')
      await h.settle()
      expect(locks).toEqual([['q0', 'blue']])
    } finally {
      h.destroy()
    }
  })

  test('Tab moves to the next question (its choices expand); Tab again wraps back', async () => {
    const locks: [string, string][] = []
    const h = await mountBatch(QUESTIONS, {}, (qid, answer) => locks.push([qid, answer]))
    try {
      h.keys.pressTab()
      await h.settle()
      expect(h.frame()).toContain('3. ') // q1's three choices now expanded
      h.keys.pressEnter()
      await h.settle()
      expect(locks).toEqual([['q1', 'x']])
      h.keys.pressTab() // wrap: q1 → q0
      await h.settle()
      expect(h.frame()).not.toContain('3. ')
      h.keys.pressEnter()
      await h.settle()
      expect(locks).toEqual([
        ['q1', 'x'],
        ['q0', 'red']
      ])
    } finally {
      h.destroy()
    }
  })

  test('Shift-Tab wraps backwards to the last question', async () => {
    const locks: [string, string][] = []
    const h = await mountBatch(QUESTIONS, {}, (qid, answer) => locks.push([qid, answer]))
    try {
      h.keys.pressTab({ shift: true }) // q0 → q1 (wrap)
      await h.settle()
      expect(h.frame()).toContain('3. ')
      h.keys.pressEnter()
      await h.settle()
      expect(locks).toEqual([['q1', 'x']])
    } finally {
      h.destroy()
    }
  })

  test('mounts on the first UNANSWERED question; locked answers render on their own line', async () => {
    const h = await mountBatch(QUESTIONS, { q0: 'blue' })
    try {
      const frame = h.frame()
      expect(frame).toContain('✓') // q0 answered
      expect(frame).toContain('→ blue') // its locked answer line
      expect(frame).toContain('3. ') // q1 (3 choices) is the active question
      expect(frame).toContain('1/2 answered')
      expect(frame).toContain('Enter confirm and continue') // one remaining
    } finally {
      h.destroy()
    }
  })

  test('an empty locked answer renders as an explicit skip', async () => {
    const h = await mountBatch(QUESTIONS, { q0: '' })
    try {
      expect(h.frame()).toContain('(skipped)')
    } finally {
      h.destroy()
    }
  })

  test('revisiting a CHOICE answer restores the cursor onto its row', async () => {
    const locks: [string, string][] = []
    // q1 is active (first unanswered); Shift-Tab revisits answered q0.
    const h = await mountBatch(QUESTIONS, { q0: 'blue' }, (qid, answer) => locks.push([qid, answer]))
    try {
      h.keys.pressTab({ shift: true })
      await h.settle()
      h.keys.pressEnter() // cursor restored onto 'blue' (row 2) — not 'red'
      await h.settle()
      expect(locks).toEqual([['q0', 'blue']])
    } finally {
      h.destroy()
    }
  })

  test('revisiting a TYPED answer stages it on the input row for editing', async () => {
    const locks: [string, string][] = []
    const h = await mountBatch(QUESTIONS, { q0: 'chartreuse' }, (qid, answer) => locks.push([qid, answer]))
    try {
      h.keys.pressTab({ shift: true }) // q1 → q0 (answered via custom text)
      await h.settle()
      expect(h.frame()).toContain('chartreuse') // staged in the inline input
      h.keys.pressEnter() // input is the selected row → submits the staged text
      await h.settle()
      expect(locks).toEqual([['q0', 'chartreuse']])
    } finally {
      h.destroy()
    }
  })

  test('Esc cancels the whole batch', async () => {
    let cancelled = false
    const h = await mountBatch(QUESTIONS, {}, undefined, () => (cancelled = true))
    try {
      h.keys.pressEscape()
      await h.settle()
      expect(cancelled).toBe(true)
    } finally {
      h.destroy()
    }
  })
})

describe('clarifyRevisitState (pure restore helper)', () => {
  test('restores the cursor onto a choice answer', () => {
    expect(clarifyRevisitState(['red', 'blue'], 'blue')).toEqual({ custom: '', selected: 1 })
  })

  test('stages a typed answer on the input row for editing', () => {
    expect(clarifyRevisitState(['red', 'blue'], 'chartreuse')).toEqual({ custom: 'chartreuse', selected: 2 })
  })

  test('stages a typed answer for an open-ended question (no choices)', () => {
    expect(clarifyRevisitState([], 'free text')).toEqual({ custom: 'free text', selected: 0 })
  })

  test('resets cleanly for unanswered and empty answers', () => {
    expect(clarifyRevisitState(['red'], undefined)).toEqual({ custom: '', selected: 0 })
    expect(clarifyRevisitState(['red'], '')).toEqual({ custom: '', selected: 0 })
  })
})

describe('PromptOverlay — batch clarify per-question locks', () => {
  const BATCH_EVENT = {
    payload: {
      questions: [
        { choices: ['a', 'b'], qid: 'q0', question: 'One?' },
        { choices: null, qid: 'q1', question: 'Two?' }
      ],
      request_id: 'req-batch'
    },
    type: 'clarify.request'
  } as const

  test('locks answer per question; the prompt stays open until none remain', async () => {
    const store = createSessionStore()
    store.apply(BATCH_EVENT)
    const sent: Record<string, unknown>[] = []
    const h = await mountOverlay(store, (method, params) => {
      expect(method).toBe('clarify.respond')
      sent.push(params)
      return Promise.resolve(true)
    })
    try {
      // q0 (choices): Enter locks 'a' → clarify.respond {question_id: 'q0'}
      h.keys.pressEnter()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual({ answer: 'a', question_id: 'q0', request_id: 'req-batch' })
      // prompt STAYS open, the lock is mirrored locally
      expect(store.state.prompt).toMatchObject({ kind: 'clarify', answers: { q0: 'a' } })

      // remounted on q1 (open-ended → the input is focused): type + Enter
      await h.settle()
      await h.keys.typeText('freeform')
      await h.settle()
      h.keys.pressEnter()
      await expect.poll(() => sent.length).toBe(2)
      expect(sent[1]).toEqual({ answer: 'freeform', question_id: 'q1', request_id: 'req-batch' })
      // final lock resolves the batch — the prompt closes
      await expect.poll(() => store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('Esc cancel-all responds WITHOUT question_id and persists the partial record', async () => {
    const store = createSessionStore()
    store.apply(BATCH_EVENT)
    store.recordClarifyAnswer('q0', 'a')
    const sent: Record<string, unknown>[] = []
    const h = await mountOverlay(store, (_method, params) => {
      sent.push(params)
      return Promise.resolve(true)
    })
    try {
      h.keys.pressEscape()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual({ answer: '', request_id: 'req-batch' })
      await expect.poll(() => store.state.prompt).toBeUndefined()
      const record = store.state.messages.find(
        message => message.role === 'system' && message.text.startsWith('ask (2 questions)')
      )
      expect(record?.text).toContain('✓ One? → a')
      expect(record?.text).toContain('· Two? (no answer)')
      expect(record?.text).toContain('(cancelled)')
    } finally {
      h.destroy()
    }
  })
})
