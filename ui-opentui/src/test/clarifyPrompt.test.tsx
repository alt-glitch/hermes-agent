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
import type { PromptResponseDisposition, PromptResponseMethod } from '../boundary/promptResponses.ts'
import { clarifyRevisitState, type ClarifyBatchQuestion } from '../logic/clarifyBatch.ts'
import { createSessionStore } from '../logic/store.ts'
import { renderProbe, type RenderProbe } from './lib/render.ts'

const LONG =
  'Just analyze for now — give me the implementation plan doc (code-path refs + line numbers, screen-by-screen), no code yet.'

const theme = createSessionStore().state.theme
const ACCEPTED = { kind: 'accepted' } as const satisfies PromptResponseDisposition
const EXPIRED = { kind: 'terminal', reason: 'expired' } as const satisfies PromptResponseDisposition

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function mountOverlay(
  store: ReturnType<typeof createSessionStore>,
  onRespond: (method: PromptResponseMethod, params: Record<string, unknown>) => Promise<PromptResponseDisposition>
): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => theme}>
        <PromptOverlay store={store} onRespond={onRespond} />
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
  test.each(['escape', 'ctrl-c'] as const)('retains %s cancellation after leaving custom input', async key => {
    const store = createSessionStore()
    store.apply({ type: 'clarify.request', payload: { question: 'Choose', choices: ['A'], request_id: 'req-focus' } })
    const replies: Record<string, unknown>[] = []
    const h = await mountOverlay(store, (_method, params) => {
      replies.push(params)
      return Promise.resolve(ACCEPTED)
    })
    try {
      h.keys.pressArrow('down')
      await h.settle()
      h.keys.pressArrow('up')
      await h.settle()
      if (key === 'escape') h.keys.pressEscape()
      else h.keys.pressKey('c', { ctrl: true })
      await h.settle()
      expect(replies).toEqual([expect.objectContaining({ request_id: 'req-focus', answer: '' })])
      await expect.poll(() => store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('stays mounted while pending and prevents duplicate submit', async () => {
    const store = createSessionStore()
    store.apply({ type: 'clarify.request', payload: { question: 'Choose', choices: ['A'], request_id: 'req-1' } })
    let calls = 0
    let resolveResponse: ((value: PromptResponseDisposition) => void) | undefined
    const response = new Promise<PromptResponseDisposition>(resolve => (resolveResponse = resolve))
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
      resolveResponse?.(ACCEPTED)
      await expect.poll(() => store.state.prompt).toBeUndefined()
      await h.settle()
      expect(store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('an uncertain response retries only after the visible manual action', async () => {
    const store = createSessionStore()
    store.apply({ type: 'clarify.request', payload: { question: 'Choose', choices: ['A'], request_id: 'req-2' } })
    const sent: Record<string, unknown>[] = []
    const h = await mountOverlay(store, (_method, params) => {
      sent.push(params)
      return sent.length === 1
        ? Promise.reject(new Error('socket closed before acknowledgement'))
        : Promise.resolve(ACCEPTED)
    })
    try {
      h.keys.pressEnter()
      await expect.poll(() => h.frame()).toContain('delivery not confirmed')
      expect(store.state.prompt?.kind).toBe('clarify')
      expect(h.frame()).toContain('r retry same response')

      // Repeated answer controls remain inert: uncertainty is never an
      // automatic replay or permission to submit a newly selected answer.
      h.keys.pressEnter()
      await h.settle()
      expect(sent).toEqual([{ answer: 'A', request_id: 'req-2' }])
      expect(store.state.prompt?.kind).toBe('clarify')

      h.keys.pressKey('r')
      await expect.poll(() => sent).toHaveLength(2)
      expect(sent[1]).toEqual(sent[0])
      await expect.poll(() => store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('a manual retry reports a terminal result without inferring whether the first delivery was accepted', async () => {
    const store = createSessionStore()
    store.apply({
      type: 'clarify.request',
      payload: { question: 'Choose', choices: ['A'], request_id: 'req-lost-ack' }
    })
    let calls = 0
    const h = await mountOverlay(store, () => {
      calls += 1
      return Promise.resolve(calls === 1 ? { kind: 'uncertain', message: 'acknowledgement was lost' } : EXPIRED)
    })
    try {
      h.keys.pressEnter()
      await expect.poll(() => h.frame()).toContain('r retry same response')

      h.keys.pressKey('r')
      await expect.poll(() => calls).toBe(2)
      await expect.poll(() => store.state.prompt).toBeUndefined()
      expect(store.state.messages.at(-1)?.text).toContain(
        'is no longer pending — earlier response delivery remains unconfirmed'
      )
      expect(store.state.messages.at(-1)?.text).not.toContain('no response was accepted')
    } finally {
      h.destroy()
    }
  })

  test('Esc dismisses a locally stalled response without waiting for the RPC', async () => {
    const store = createSessionStore()
    store.apply({ type: 'clarify.request', payload: { question: 'Choose', choices: ['A'], request_id: 'req-stalled' } })
    const stalled = new Promise<PromptResponseDisposition>(() => {})
    const h = await mountOverlay(store, () => stalled)
    try {
      h.keys.pressEnter()
      await h.settle()
      expect(h.frame()).toContain('sending response')

      h.keys.pressEscape()
      await new Promise(resolve => setTimeout(resolve, 0))
      await h.settle()
      expect(store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('Ctrl+C dismisses an errored response without claiming cancellation was delivered', async () => {
    const store = createSessionStore()
    store.apply({ type: 'clarify.request', payload: { question: 'Choose', choices: ['A'], request_id: 'req-error' } })
    const h = await mountOverlay(store, () => Promise.reject(new Error('transport disconnected')))
    try {
      h.keys.pressEnter()
      await expect.poll(() => h.frame()).toContain('delivery not confirmed')

      h.keys.pressKey('c', { ctrl: true })
      await new Promise(resolve => setTimeout(resolve, 0))
      await h.settle()
      expect(store.state.prompt).toBeUndefined()
      expect(store.state.messages.at(-1)?.text).toContain('delivery was not confirmed')
      expect(store.state.messages.at(-1)?.text).not.toContain('cancelled')
    } finally {
      h.destroy()
    }
  })

  test('a terminal obsolete response closes the blocking prompt', async () => {
    const store = createSessionStore()
    store.apply({ type: 'clarify.request', payload: { question: 'Choose', choices: ['A'], request_id: 'req-expired' } })
    const h = await mountOverlay(store, () => Promise.resolve(EXPIRED))
    try {
      h.keys.pressEnter()
      await new Promise(resolve => setTimeout(resolve, 0))
      await h.settle()
      expect(store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('a terminal response remains locally closable before its deferred teardown', async () => {
    const store = createSessionStore()
    store.apply({
      type: 'clarify.request',
      payload: { question: 'Choose', choices: ['A'], request_id: 'req-terminal' }
    })
    const response = deferred<PromptResponseDisposition>()
    const h = await mountOverlay(store, () => response.promise)
    try {
      h.keys.pressEnter()
      await h.settle()
      response.resolve(EXPIRED)
      await Promise.resolve()
      h.keys.pressKey('c', { ctrl: true })
      await new Promise(resolve => setTimeout(resolve, 0))
      await h.settle()
      expect(store.state.prompt).toBeUndefined()
      expect(store.state.messages.at(-1)?.text).toContain('expired')
    } finally {
      h.destroy()
    }
  })

  test('a retry is fenced by its presenting session and cannot close a replacement prompt', async () => {
    const store = createSessionStore()
    store.setSessionId('session-old')
    store.apply({ type: 'clarify.request', payload: { question: 'Old?', choices: ['A'], request_id: 'req-old' } })
    const retry = deferred<PromptResponseDisposition>()
    let calls = 0
    const h = await mountOverlay(store, () => {
      calls += 1
      return calls === 1
        ? Promise.resolve({ kind: 'uncertain', message: 'socket closed before acknowledgement' })
        : retry.promise
    })
    try {
      h.keys.pressEnter()
      await expect.poll(() => h.frame()).toContain('r retry same response')

      store.setSessionId('session-other')
      h.keys.pressKey('r')
      await h.settle()
      expect(calls).toBe(1)

      store.setSessionId('session-old')
      h.keys.pressKey('r')
      await expect.poll(() => calls).toBe(2)
      store.setSessionId('session-new')
      store.apply({ type: 'clarify.request', payload: { question: 'New?', choices: ['B'], request_id: 'req-new' } })
      await h.settle()
      retry.resolve(ACCEPTED)
      await new Promise(resolve => setTimeout(resolve, 0))
      await h.settle()
      expect(store.state.prompt).toMatchObject({ kind: 'clarify', requestId: 'req-new' })
    } finally {
      h.destroy()
    }
  })

  test('approval responses carry the exact request and session identities', async () => {
    const store = createSessionStore()
    store.apply({
      type: 'approval.request',
      session_id: 'live-session',
      payload: { command: 'echo safe', description: 'test command', request_id: 'approval-exact' }
    })
    const sent: Array<{ method: PromptResponseMethod; params: Record<string, unknown> }> = []
    const h = await mountOverlay(store, (method, params) => {
      sent.push({ method, params })
      return Promise.resolve(ACCEPTED)
    })
    try {
      h.keys.pressEnter()
      await expect.poll(() => sent).toHaveLength(1)
      expect(sent[0]).toEqual({
        method: 'approval.respond',
        params: { choice: 'once', request_id: 'approval-exact', session_id: 'live-session' }
      })
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

  test('manual retry preserves the exact batch question identity after navigation', async () => {
    const store = createSessionStore()
    store.apply(BATCH_EVENT)
    const sent: Record<string, unknown>[] = []
    const h = await mountOverlay(store, (method, params) => {
      expect(method).toBe('clarify.respond')
      sent.push(params)
      return Promise.resolve(
        sent.length === 1 ? { kind: 'uncertain', message: 'socket closed before acknowledgement' } : ACCEPTED
      )
    })
    try {
      // q0 (choices): Enter attempts 'a', then the user navigates to q1 while
      // its outcome is uncertain. Manual retry must still carry q0 exactly.
      h.keys.pressEnter()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual({ answer: 'a', question_id: 'q0', request_id: 'req-batch' })
      await expect.poll(() => h.frame()).toContain('r retry same response')
      h.keys.pressTab()
      await h.settle()
      h.keys.pressKey('r')
      await expect.poll(() => sent.length).toBe(2)
      expect(sent[1]).toEqual(sent[0])

      // The acknowledged q0 lock is mirrored and q1 remains open.
      expect(store.state.prompt).toMatchObject({ kind: 'clarify', answers: { q0: 'a' } })

      // q1 is open-ended and receives only its own subsequent answer.
      await h.settle()
      await h.keys.typeText('freeform')
      await h.settle()
      h.keys.pressEnter()
      await expect.poll(() => sent.length).toBe(3)
      expect(sent[2]).toEqual({ answer: 'freeform', question_id: 'q1', request_id: 'req-batch' })
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
      return Promise.resolve(ACCEPTED)
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

describe('PromptOverlay — password-manager unlock card', () => {
  const UNLOCK = {
    type: 'vault.unlock.request',
    payload: { backend: 'onepassword', display_name: '1Password', request_id: 'vault-1' }
  } as const

  test('renders a masked card naming the manager and submits the master password to vault.unlock.respond', async () => {
    const store = createSessionStore()
    store.apply(UNLOCK)
    const sent: [PromptResponseMethod, Record<string, unknown>][] = []
    const h = await mountOverlay(store, (method, params) => {
      sent.push([method, params])
      return Promise.resolve(ACCEPTED)
    })
    try {
      expect(h.frame()).toContain('Unlock 1Password for this session')
      await h.keys.typeText('hunter2')
      await h.settle()
      // The secret never reaches a renderable; only its mask does.
      expect(h.frame()).not.toContain('hunter2')
      expect(h.frame()).toContain('*******')
      h.keys.pressEnter()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual(['vault.unlock.respond', { password: 'hunter2', request_id: 'vault-1' }])
      await expect.poll(() => store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('Esc keeps the manager locked: an empty password goes back to the same request', async () => {
    const store = createSessionStore()
    store.apply(UNLOCK)
    const sent: [PromptResponseMethod, Record<string, unknown>][] = []
    const h = await mountOverlay(store, (method, params) => {
      sent.push([method, params])
      return Promise.resolve(ACCEPTED)
    })
    try {
      h.keys.pressEscape()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual(['vault.unlock.respond', { password: '', request_id: 'vault-1' }])
      await expect.poll(() => store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('a late expiry for the same request closes the card without any response', async () => {
    const store = createSessionStore()
    store.apply(UNLOCK)
    const sent: unknown[] = []
    const h = await mountOverlay(store, (_method, params) => {
      sent.push(params)
      return Promise.resolve(EXPIRED)
    })
    try {
      store.apply({ type: 'vault.unlock.expire', payload: { request_id: 'vault-1' } })
      await expect.poll(() => store.state.prompt).toBeUndefined()
      expect(sent).toEqual([])
    } finally {
      h.destroy()
    }
  })
})

describe('PromptOverlay — masked cards share one wire shape', () => {
  const cases = [
    {
      event: { type: 'sudo.request', payload: { request_id: 'm-1' } },
      method: 'sudo.respond',
      field: 'password',
      heading: 'sudo password'
    },
    {
      event: { type: 'secret.request', payload: { env_var: 'API_KEY', prompt: 'paste it', request_id: 'm-1' } },
      method: 'secret.respond',
      field: 'value',
      heading: 'Secret: API_KEY'
    },
    {
      event: { type: 'vault.unlock.request', payload: { backend: 'bw', display_name: 'Bitwarden', request_id: 'm-1' } },
      method: 'vault.unlock.respond',
      field: 'password',
      heading: 'Unlock Bitwarden for this session'
    }
  ] as const

  test.each(cases)('$event.type: Enter sends the typed value, Esc sends an empty one', async c => {
    const store = createSessionStore()
    store.apply(c.event)
    const sent: [PromptResponseMethod, Record<string, unknown>][] = []
    const h = await mountOverlay(store, (method, params) => {
      sent.push([method, params])
      return Promise.resolve(ACCEPTED)
    })
    try {
      expect(h.frame()).toContain(c.heading)
      await h.keys.typeText('s3cret')
      await h.settle()
      expect(h.frame()).not.toContain('s3cret')
      h.keys.pressEnter()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual([c.method, { [c.field]: 's3cret', request_id: 'm-1' }])
      await expect.poll(() => store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }

    const cancelled: [PromptResponseMethod, Record<string, unknown>][] = []
    store.apply(c.event)
    const h2 = await mountOverlay(store, (method, params) => {
      cancelled.push([method, params])
      return Promise.resolve(ACCEPTED)
    })
    try {
      h2.keys.pressEscape()
      await expect.poll(() => cancelled.length).toBe(1)
      expect(cancelled[0]).toEqual([c.method, { [c.field]: '', request_id: 'm-1' }])
    } finally {
      h2.destroy()
    }
  })
})
