/**
 * MaskedPrompt — sudo (🔐) / secret (🔑) masked entry (spec §8 #6). OpenTUI's
 * `<input>` has NO native mask (only value/placeholder/maxLength), and feeding it
 * stars via `value` is a feedback loop (onInput reports the masked value), so we
 * own a hidden grapheme buffer and capture input via OpenTUI's keyboard/paste
 * hooks, rendering one `*` per grapheme. Cursor movement and editing mirror a
 * normal single-line input without ever placing the secret in a renderable.
 *
 * Enter submits the real buffer; Esc/Ctrl+C submits empty so the agent unblocks.
 */
import { useKeyboard, usePaste } from '@opentui/solid'
import { createMemo, createSignal, Show } from 'solid-js'

import { useTheme } from '../theme.tsx'

export interface MaskedEditorState {
  readonly graphemes: readonly string[]
  readonly cursor: number
}

export type MaskedEditAction = 'left' | 'right' | 'home' | 'end' | 'backspace' | 'delete'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function maskedGraphemes(text: string): readonly string[] {
  return Array.from(segmenter.segment(text), part => part.segment)
}

export function maskedInsert(state: MaskedEditorState, text: string): MaskedEditorState {
  const printable = Array.from(text)
    .filter(character => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127
    })
    .join('')
  const inserted = maskedGraphemes(printable)
  if (inserted.length === 0) return state
  return {
    graphemes: [...state.graphemes.slice(0, state.cursor), ...inserted, ...state.graphemes.slice(state.cursor)],
    cursor: state.cursor + inserted.length
  }
}

export function maskedEdit(state: MaskedEditorState, action: MaskedEditAction): MaskedEditorState {
  const cursor = Math.max(0, Math.min(state.cursor, state.graphemes.length))
  if (action === 'left') return { ...state, cursor: Math.max(0, cursor - 1) }
  if (action === 'right') return { ...state, cursor: Math.min(state.graphemes.length, cursor + 1) }
  if (action === 'home') return { ...state, cursor: 0 }
  if (action === 'end') return { ...state, cursor: state.graphemes.length }
  if (action === 'backspace') {
    if (cursor === 0) return state
    return {
      graphemes: [...state.graphemes.slice(0, cursor - 1), ...state.graphemes.slice(cursor)],
      cursor: cursor - 1
    }
  }
  if (cursor === state.graphemes.length) return state
  return { graphemes: [...state.graphemes.slice(0, cursor), ...state.graphemes.slice(cursor + 1)], cursor }
}

function isMaskedEditAction(name: string): name is MaskedEditAction {
  return (
    name === 'left' ||
    name === 'right' ||
    name === 'home' ||
    name === 'end' ||
    name === 'backspace' ||
    name === 'delete'
  )
}

export function MaskedPrompt(props: {
  icon: string
  label: string
  sub?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const theme = useTheme()
  const [editor, setEditor] = createSignal<MaskedEditorState>({ graphemes: [], cursor: 0 })
  const beforeCursor = createMemo(() => '*'.repeat(editor().cursor))
  const afterCursor = createMemo(() => '*'.repeat(editor().graphemes.length - editor().cursor))

  usePaste(event => {
    setEditor(state => maskedInsert(state, new TextDecoder().decode(event.bytes)))
    event.preventDefault()
    event.stopPropagation()
  })

  useKeyboard(key => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      setEditor({ graphemes: [], cursor: 0 })
      props.onCancel()
      return
    }
    if (key.name === 'return') {
      const submitted = editor().graphemes.join('')
      setEditor({ graphemes: [], cursor: 0 })
      props.onSubmit(submitted)
      return
    }
    if (isMaskedEditAction(key.name)) {
      const action = key.name
      setEditor(state => maskedEdit(state, action))
      key.preventDefault()
      return
    }
    const ch = key.sequence
    if (ch && !key.ctrl && !key.meta && !key.option) {
      setEditor(state => maskedInsert(state, ch))
      key.preventDefault()
    }
  })

  return (
    <box
      style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, marginTop: 1, padding: 1 }}
      border
    >
      <text fg={theme().color.label}>
        <b>
          {props.icon} {props.label}
        </b>
      </text>
      <Show when={props.sub}>
        <text fg={theme().color.muted}>{props.sub}</text>
      </Show>
      <box style={{ flexDirection: 'row' }}>
        <text fg={theme().color.label}>{'> '}</text>
        <text fg={theme().color.text}>{beforeCursor()}</text>
        <text fg={theme().color.accent}>▍</text>
        <text fg={theme().color.text}>{afterCursor()}</text>
      </box>
      <text fg={theme().color.muted}>Enter send · Esc/Ctrl+C cancel · masked</text>
    </box>
  )
}
