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
 */
import { type InputRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For } from 'solid-js'

import { Markdown } from '../markdown.tsx'
import { useTheme } from '../theme.tsx'

export function ClarifyPrompt(props: {
  question: string
  choices: string[] | null
  onAnswer: (answer: string) => void
  onCancel: () => void
}) {
  const theme = useTheme()
  const choices = createMemo(() => props.choices ?? [])
  const hasChoices = () => choices().length > 0
  // The inline custom input sits at index === choices().length (the last row).
  const inputIndex = () => choices().length
  // Start on the first choice, or on the input when there are no choices.
  const [selected, setSelected] = createSignal(hasChoices() ? 0 : 0)
  let inputRef: InputRenderable | undefined

  const onInput = () => selected() === inputIndex()

  // Keep the native <input> focused exactly while it's the selected row, so
  // keystrokes type into it (and leave the list while a choice is selected).
  createEffect(() => {
    if (onInput()) inputRef?.focus()
    else inputRef?.blur()
  })

  const answerChoice = () => {
    const c = choices()[selected()]
    if (c !== undefined) props.onAnswer(c)
  }
  const submitCustom = () => props.onAnswer(inputRef?.value ?? '')

  useKeyboard(key => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      props.onCancel()
      return
    }
    // Match Ink's direct choice shortcuts. Zero represents the tenth choice;
    // choices beyond ten remain available through arrows/Enter.
    if (!onInput() && !key.ctrl && !key.meta && !key.option) {
      const quickIndex = key.name === '0' ? 9 : /^[1-9]$/.test(key.name) ? Number(key.name) - 1 : -1
      const choice = choices()[quickIndex]
      if (choice !== undefined) {
        props.onAnswer(choice)
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

  return (
    <box
      style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, marginTop: 1, padding: 1 }}
      border
    >
      {/* the question WRAPS within the bordered box width (F5) and renders
          markdown (bold/italic/`code`) via the native <markdown> renderable —
          same engine as the transcript, so `**x**`/backticks aren't shown raw
          (glitch 2026-06-14). The `? ` lead is part of the markdown content so
          it sits inline with the first rendered word. */}
      <box style={{ flexDirection: 'column', flexShrink: 0 }}>
        <Markdown text={`? ${props.question}`} fg={theme().color.label} />
      </box>

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
            ref={el => (inputRef = el)}
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

      <text fg={theme().color.muted}>
        {onInput()
          ? '↑↓ select · Enter send · Esc cancel'
          : `↑↓ select · Enter choose · 1-${Math.min(choices().length, 10)} quick pick · Esc cancel`}
      </text>
    </box>
  )
}
