/**
 * ClarifyPrompt — the agent's clarifying question (spec §8 #6). A custom
 * keyboard-driven list (NOT the native <select>) so that:
 *   - long option text WRAPS instead of clipping at the right edge (F5),
 *   - options are numbered + the selected row is highlighted with a real
 *     background + accent (three signals, not just a ▸ glyph) (F5),
 *   - the custom answer is an ALWAYS-PRESENT inline <input> in the same screen,
 *     not a list row that toggles a separate view (F5),
 *   - Up/Down/Enter are preventDefault'd so the arrows drive the option
 *     selection and never leak to the transcript scrollbox (F6).
 *
 * Navigation: indices 0..N-1 are the choices; index N is the inline custom
 * input. Down past the last choice lands on the input (and focuses it); Up from
 * the input returns to the list. Enter on a choice answers it; Enter in the
 * input submits the typed text. Esc/Ctrl+C cancels (empty answer). When there
 * are no choices the input is the only control and is focused immediately.
 * Answered via `clarify.respond {answer, request_id}` (the caller wires onAnswer).
 *
 * BATCH mode (`questions` non-empty — multi-question clarify): a compact status
 * list — every question on its own row (✓ answered / ▸ active / · pending),
 * only the ACTIVE question's choices + input expanded, so a 5-question batch
 * stays a few rows tall. Enter locks the active answer via `onQuestionAnswer`
 * (clarify.respond + question_id) and the prompt remounts on the next
 * unanswered question; Tab / Shift-Tab cycle the active question with wrap, and
 * revisiting an answered question restores its earlier state (choice answers
 * put the cursor back on their row; typed answers land on the input row with
 * the text staged for editing — clarifyRevisitState). A locked answer renders
 * on its own indented line under its question (muted italic "(skipped)" for an
 * empty lock). Esc/Ctrl+C cancels the WHOLE batch (respond without
 * question_id). multi_select rides the state untouched — no checkbox UX yet
 * (same deliberate gap as Ink).
 */
import { type InputRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'

import { clarifyRevisitState, type ClarifyBatchQuestion } from '../../logic/clarifyBatch.ts'
import { Markdown } from '../markdown.tsx'
import { useTheme } from '../theme.tsx'

export function ClarifyPrompt(props: {
  question: string
  choices: string[] | null
  /** Batch mode: the ordered question list (single-question when absent/empty). */
  questions?: ClarifyBatchQuestion[] | undefined
  /** Batch mode: answers already locked (qid → answer). */
  answers?: Record<string, string> | undefined
  onAnswer: (answer: string) => void
  onCancel: () => void
  /** Batch mode: lock ONE question's answer (clarify.respond + question_id). */
  onQuestionAnswer?: (qid: string, answer: string) => void
}) {
  const theme = useTheme()
  const questions = createMemo(() => props.questions ?? [])
  const isBatch = () => questions().length > 0
  const answers = () => props.answers ?? {}
  // The active (expanded) batch question — starts on the first unanswered one,
  // so a reconnect-replayed partial batch resumes where the user left off. The
  // caller remounts this prompt after each acknowledged lock, which re-runs
  // this initializer — that IS the jump-to-next-unanswered behavior.
  const [active, setActive] = createSignal(
    Math.max(
      0,
      (props.questions ?? []).findIndex(q => (props.answers ?? {})[q.qid] === undefined)
    )
  )
  const activeQuestion = () => questions()[active()]
  // The working choice list: the active question's in batch mode, else the
  // single question's. All cursor/quick-pick/input logic below is shared.
  const choices = createMemo(() => (isBatch() ? (activeQuestion()?.choices ?? []) : (props.choices ?? [])))
  const hasChoices = () => choices().length > 0
  // The inline custom input sits at index === choices().length (the last row).
  const inputIndex = () => choices().length
  // Start on the first choice, or on the input when there are no choices.
  const [selected, setSelected] = createSignal(0)
  // Text staged into the (re)mounted input — revisiting a typed batch answer
  // pre-fills it so Enter edits the earlier text instead of starting blank.
  const [staged, setStaged] = createSignal('')
  let inputRef: InputRenderable | undefined

  const onInput = () => selected() === inputIndex()

  // Keep the native <input> focused exactly while it's the selected row, so
  // keystrokes type into it (and leave the list while a choice is selected).
  createEffect(() => {
    if (onInput()) inputRef?.focus()
    else inputRef?.blur()
  })

  /** Route an answer: per-question lock in batch mode, plain answer otherwise. */
  const commit = (answer: string) => {
    if (isBatch()) {
      const q = activeQuestion()
      if (q) props.onQuestionAnswer?.(q.qid, answer)
      return
    }
    props.onAnswer(answer)
  }

  const answerChoice = () => {
    const c = choices()[selected()]
    if (c !== undefined) commit(c)
  }
  const submitCustom = () => commit(inputRef?.value ?? '')

  /** Tab/Shift-Tab: cycle the active batch question (with wrap), restoring the
   *  revisited question's earlier state (cursor on its choice, or its typed
   *  text staged on the input row). */
  const moveActive = (delta: number) => {
    const qs = questions()
    if (qs.length === 0) return
    const next = (active() + delta + qs.length) % qs.length
    const q = qs[next]
    const restored = clarifyRevisitState(q?.choices ?? [], q ? answers()[q.qid] : undefined)
    // staged before active: the revisited question's input mounts synchronously
    // when `active` flips, reading the staged text in its ref callback.
    setStaged(restored.custom)
    setActive(next)
    setSelected(restored.selected)
    if (inputRef) inputRef.value = restored.custom
  }

  useKeyboard(key => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      props.onCancel()
      return
    }
    if (isBatch() && key.name === 'tab') {
      moveActive(key.shift ? -1 : 1)
      key.preventDefault() // never let Tab reach the (focused) inline input
      return
    }
    // Match Ink's direct choice shortcuts. Zero represents the tenth choice;
    // choices beyond ten remain available through arrows/Enter.
    if (!onInput() && !key.ctrl && !key.meta && !key.option) {
      const quickIndex = key.name === '0' ? 9 : /^[1-9]$/.test(key.name) ? Number(key.name) - 1 : -1
      const choice = choices()[quickIndex]
      if (choice !== undefined) {
        commit(choice)
        key.preventDefault()
        return
      }
    }
    // Total rows = choices + the always-present custom input.
    const total = choices().length + 1
    if (key.name === 'up') {
      setSelected(s => (s - 1 + total) % total)
      key.preventDefault() // F6: never let the arrow reach the scrollbox
      return
    }
    if (key.name === 'down') {
      setSelected(s => (s + 1) % total)
      key.preventDefault()
      return
    }
    if (key.name === 'return') {
      // On the input the native <input> onSubmit handles Enter; for a choice we
      // answer here and preventDefault so the key doesn't also submit elsewhere.
      if (!onInput()) {
        answerChoice()
        key.preventDefault()
      }
    }
  })

  /** The expanded interior shared by both modes: numbered wrapping choice rows
   *  + the always-present inline custom input as the last selectable row. */
  const choiceRows = () => (
    <box style={{ flexDirection: 'column', marginTop: 1 }}>
      <For each={choices()}>
        {(choice, i) => (
          <box
            style={{
              backgroundColor: i() === selected() ? theme().color.selectionBg : 'transparent',
              flexDirection: 'row',
              paddingLeft: 1,
              paddingRight: 1
            }}
          >
            {/* numbered + accent-when-selected; the choice text renders
                markdown (bold/`code`) and wraps within the flex column (F5).
                `fg` carries the selection accent as the base prose color. */}
            <text fg={i() === selected() ? theme().color.accent : theme().color.muted}>{`${i() + 1}. `}</text>
            <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
              <Markdown text={choice} fg={i() === selected() ? theme().color.accent : theme().color.text} />
            </box>
          </box>
        )}
      </For>

      {/* the custom answer is an inline input in the SAME screen (F5), the
          last selectable row — focused while selected, typed into directly */}
      <box
        style={{
          backgroundColor: onInput() ? theme().color.selectionBg : 'transparent',
          flexDirection: 'row',
          marginTop: hasChoices() ? 1 : 0,
          paddingLeft: 1,
          paddingRight: 1
        }}
      >
        <text fg={onInput() ? theme().color.accent : theme().color.muted}>{'✎ '}</text>
        <input
          ref={el => {
            inputRef = el
            // Revisit restore: a batch input remounts when the active question
            // changes — seed it with the staged earlier answer (empty otherwise).
            el.value = staged()
          }}
          focused={!hasChoices()}
          style={{ flexGrow: 1, minWidth: 0 }}
          placeholder={hasChoices() ? 'or type a custom answer…' : 'Type your answer…'}
          placeholderColor={theme().color.muted}
          textColor={theme().color.text}
          cursorColor={theme().color.accent}
          onSubmit={submitCustom}
        />
      </box>
    </box>
  )

  const answeredCount = () => questions().filter(q => answers()[q.qid] !== undefined).length
  const remainingCount = () => questions().length - answeredCount()
  // The final lock resolves the whole batch and the turn continues — say so.
  const lockVerb = () => (remainingCount() === 1 ? 'confirm and continue' : 'lock answer')

  return (
    <box
      style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, marginTop: 1, padding: 1 }}
      border
    >
      <Show
        when={isBatch()}
        fallback={
          <>
            {/* the question WRAPS within the bordered box width (F5) and renders
                markdown (bold/italic/`code`) via the native <markdown> renderable —
                same engine as the transcript, so `**x**`/backticks aren't shown raw
                (glitch 2026-06-14). The `? ` lead is part of the markdown content so
                it sits inline with the first rendered word. */}
            <box style={{ flexDirection: 'column', flexShrink: 0 }}>
              <Markdown text={`? ${props.question}`} fg={theme().color.label} />
            </box>

            {choiceRows()}

            <text fg={theme().color.muted}>
              {onInput()
                ? '↑↓ select · Enter send · Esc cancel'
                : `↑↓ select · Enter choose · 1-${Math.min(choices().length, 10)} quick pick · Esc cancel`}
            </text>
          </>
        }
      >
        {/* batch heading — chrome (the count), not markdown content */}
        <text fg={theme().color.label}>{`? ${questions().length} questions`}</text>

        <box style={{ flexDirection: 'column', marginTop: 1 }}>
          <For each={questions()}>
            {(q, i) => {
              const answer = () => answers()[q.qid]
              const isActive = () => i() === active()
              // ✓ answered / ▸ active / · pending — the compact status list.
              const marker = () => (answer() !== undefined ? '✓' : isActive() ? '▸' : '·')
              return (
                <box style={{ flexDirection: 'column', flexShrink: 0 }}>
                  <box style={{ flexDirection: 'row' }}>
                    <text fg={isActive() ? theme().color.accent : theme().color.muted}>{`${marker()} `}</text>
                    <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
                      <Markdown text={q.question} fg={isActive() ? theme().color.text : theme().color.muted} />
                    </box>
                  </box>

                  {/* the locked answer on its own indented line (ok color) so
                      every lock stays readable while Tab walks the list; an
                      empty lock is an explicit skip — muted italic. */}
                  <Show when={answer() !== undefined}>
                    <box style={{ flexDirection: 'row', paddingLeft: 2 }}>
                      <Show
                        when={answer()}
                        fallback={
                          <text>
                            <span style={{ fg: theme().color.muted, italic: true }}>(skipped)</span>
                          </text>
                        }
                      >
                        {locked => <text fg={theme().color.ok}>{`→ ${locked()}`}</text>}
                      </Show>
                    </box>
                  </Show>

                  {/* only the ACTIVE question expands its choices + input */}
                  <Show when={isActive()}>{choiceRows()}</Show>
                </box>
              )
            }}
          </For>
        </box>

        <text fg={theme().color.muted}>
          {`${answeredCount()}/${questions().length} answered · ↑↓ select · Enter ${lockVerb()} · Tab/Shift+Tab switch question · Esc cancel all`}
        </text>
      </Show>
    </box>
  )
}
