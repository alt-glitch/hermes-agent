/**
 * ConnectionCard — the manage_connections card (port of Ink's
 * `connectionSetupOverlay.tsx`). The backend tool thread waits on this card:
 * every answer goes through `connection.respond`, a failed row's re-mint through
 * `connectors.connect`, and Ctrl+C interrupts the turn (which settles the
 * operation as `interrupt`). The card is a projection of the latest frame; the
 * phase logic lives in `logic/connectionCard.ts`.
 *
 * One input owner: every key causes exactly one action. Field editing reuses the
 * masked-editor model, so a secret value never lands in a renderable.
 */
import type { BoxRenderable } from '@opentui/core'
import { useKeyboard, usePaste } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import type { ConnectionEnvField } from '../../boundary/schema/Connection.ts'
import {
  CONNECTION_HINTS,
  envFields,
  failureLine,
  fieldLabel,
  hasFailed,
  initialDraft,
  missingRequired,
  phaseOf,
  unresolvedTargets,
  verbOf,
  type ConnectionCard as CardState
} from '../../logic/connectionCard.ts'
import { maskedEdit, maskedGraphemes, maskedInsert, type MaskedEditorState } from './maskedPrompt.tsx'
import { useTheme } from '../theme.tsx'

/** What the card sends back. `targets`/`settled_by` mirror `ConnectionAnswer`. */
export interface ConnectionAnswer {
  targets?: { name: string; status: 'approved' | 'skipped'; env?: Record<string, string> }[]
  settled_by?: 'continue'
}

export interface ConnectionCardOps {
  readonly respond: (opId: string, result: ConnectionAnswer) => Promise<unknown>
  readonly reconnect: (name: string) => Promise<unknown>
  readonly interrupt: () => void
  readonly openUrl: (url: string) => boolean
  readonly dismiss: (opId: string) => void
  readonly isSettled: (opId: string) => boolean
}

interface AnsweredRow {
  readonly name: string
  readonly seq: number
  readonly state: string
}

const SENDING_TIMEOUT_MS = 5_000
const EMPTY: MaskedEditorState = { graphemes: [], cursor: 0 }
const editorOf = (text: string): MaskedEditorState => {
  const graphemes = maskedGraphemes(text)
  return { graphemes, cursor: graphemes.length }
}
const EDIT_KEYS = new Set(['left', 'right', 'home', 'end', 'backspace', 'delete'])

export function ConnectionCard(props: { readonly card: CardState; readonly ops: ConnectionCardOps }) {
  const theme = useTheme()
  const c = () => theme().color
  let rootRef: BoxRenderable | undefined

  const unresolved = createMemo(() => unresolvedTargets(props.card))
  const target = () => unresolved()[0]
  const fields = createMemo((): readonly ConnectionEnvField[] => {
    const current = target()
    return current ? envFields(current) : []
  })
  const phase = () => {
    const current = target()
    return current ? phaseOf(current) : undefined
  }
  const targetKey = () => `${props.card.opId}:${target()?.name ?? ''}`

  const [draft, setDraft] = createSignal<Record<string, MaskedEditorState>>({})
  const [focus, setFocus] = createSignal(0)
  const [action, setAction] = createSignal<0 | 1>(0)
  const [answered, setAnswered] = createSignal<AnsweredRow | undefined>()
  const [notice, setNotice] = createSignal('')
  // One request at a time, so a held key cannot post the same answer again.
  let inFlight = false

  // A new target starts clean.
  createEffect(() => {
    targetKey()
    setDraft({})
    setFocus(0)
    setAction(0)
    setAnswered(undefined)
    setNotice('')
  })
  // Every snapshot re-sends required_env: fill only what the draft lacks, so a failed Connect keeps
  // what was typed. Secrets start empty.
  createEffect(() => {
    const seed = initialDraft(fields())
    setDraft(current => {
      const next = { ...current }
      for (const [name, value] of Object.entries(seed)) next[name] ??= value ? editorOf(value) : EMPTY
      return next
    })
  })
  // The third way out of "sending": the row gives its control back even if no frame arrives.
  createEffect(() => {
    if (!answered()) return
    const timer = setTimeout(() => setAnswered(undefined), SENDING_TIMEOUT_MS)
    onCleanup(() => clearTimeout(timer))
  })

  onMount(() => rootRef?.focus())

  const draftText = (): Record<string, string> =>
    Object.fromEntries(Object.entries(draft()).map(([name, editor]) => [name, editor.graphemes.join('')]))
  const missing = () => missingRequired(fields(), draftText())
  const sending = () => {
    const row = answered()
    if (!row || props.card.seq > row.seq) return false
    return props.card.targets.find(item => item.name === row.name)?.state === row.state
  }
  const rows = () => (phase() === 'form' ? fields().length + 1 : 1)
  const row = () => Math.min(focus(), rows() - 1)
  const selectorFocused = () => phase() === 'retry' || row() === fields().length

  const answeredNow = (): AnsweredRow | undefined => {
    const current = target()
    return current ? { name: current.name, seq: props.card.seq, state: current.state } : undefined
  }

  const send = (start: () => Promise<unknown>, failure: string, row: AnsweredRow | undefined): void => {
    if (inFlight || props.ops.isSettled(props.card.opId)) return
    inFlight = true
    setAnswered(row)
    setNotice('')
    start()
      .catch(() => {
        setAnswered(undefined)
        setNotice(failure)
      })
      .finally(() => {
        inFlight = false
      })
  }

  const respond = (result: ConnectionAnswer): void => {
    const opId = props.card.opId
    send(() => props.ops.respond(opId, result), 'That answer did not reach Hermes. Try again.', answeredNow())
  }

  const skip = (): void => {
    const current = target()
    if (current && !sending()) respond({ targets: [{ name: current.name, status: 'skipped' }] })
  }

  const connect = (): void => {
    const current = target()
    if (!current || sending()) return
    const absent = missing()
    if (absent) {
      setFocus(Math.max(0, fields().indexOf(absent)))
      return
    }
    respond({ targets: [{ env: draftText(), name: current.name, status: 'approved' }] })
  }

  const tryAgain = (): void => {
    const current = target()
    if (!current || sending()) return
    const name = current.name
    send(() => props.ops.reconnect(name), 'Hermes could not start that again. Try again.', answeredNow())
  }

  const openLink = (): void => {
    const url = target()?.connect_url
    if (url) setNotice(props.ops.openUrl(url) ? '' : 'The browser did not open. Copy the link above.')
  }

  const editField = (name: string, change: (editor: MaskedEditorState) => MaskedEditorState): void => {
    setDraft(current => ({ ...current, [name]: change(current[name] ?? EMPTY) }))
  }
  const focusedField = (): ConnectionEnvField | undefined =>
    phase() === 'form' && !selectorFocused() && !sending() ? fields()[row()] : undefined

  usePaste(event => {
    const field = focusedField()
    if (!field) return
    const text = new TextDecoder().decode(event.bytes)
    editField(field.name, editor => maskedInsert(editor, text))
    event.preventDefault()
    event.stopPropagation()
  })

  useKeyboard(key => {
    const consume = () => key.preventDefault()
    // Ctrl+C always stops the turn; ending the turn is what settles the operation.
    if (key.ctrl && key.name === 'c') {
      consume()
      props.ops.interrupt()
      return
    }
    const current = target()
    // Every row is answered and the settling frame has not landed: Esc closes locally.
    if (!current) {
      if (key.name === 'escape') {
        consume()
        props.ops.dismiss(props.card.opId)
      }
      return
    }
    const p = phase()
    if (p === 'authorized') {
      if ((key.name === 'escape' || key.name === 'return') && !sending()) {
        consume()
        respond({ settled_by: 'continue' })
      }
      return
    }
    if (key.name === 'escape') {
      consume()
      skip()
      return
    }
    if (p === 'browser') {
      if (key.name === 'return') {
        consume()
        openLink()
      }
      return
    }
    if (p === 'working') return

    const count = rows()
    const back = () => setFocus((row() - 1 + count) % count)
    const forward = () => setFocus((row() + 1) % count)
    const onSelector = selectorFocused()
    if (key.name === 'tab') {
      consume()
      if (key.shift) back()
      else forward()
      return
    }
    if ((key.name === 'down' || key.name === 'up') && !onSelector) {
      consume()
      if (key.name === 'down') forward()
      else back()
      return
    }
    if (onSelector) {
      if (key.name === 'left' || key.name === 'right' || key.name === 'up' || key.name === 'down') {
        consume()
        setAction(value => (value === 0 ? 1 : 0))
      } else if (key.name === 'return') {
        consume()
        if (action() === 1) skip()
        else if (p === 'retry') tryAgain()
        else connect()
      }
      return
    }
    // A field row owns editing keys; Enter moves to the next row (the last one moves to the selector).
    const field = focusedField()
    if (!field) return
    if (key.name === 'return') {
      consume()
      forward()
      return
    }
    if (EDIT_KEYS.has(key.name)) {
      consume()
      editField(field.name, editor => maskedEdit(editor, key.name as Parameters<typeof maskedEdit>[1]))
      return
    }
    const ch = key.sequence
    if (ch && !key.ctrl && !key.meta && !key.option) {
      consume()
      editField(field.name, editor => maskedInsert(editor, ch))
    }
  })

  const fieldText = (field: ConnectionEnvField, focused: boolean) => {
    const editor = draft()[field.name] ?? EMPTY
    const shown = field.secret ? editor.graphemes.map(() => '*') : editor.graphemes
    const before = shown.slice(0, editor.cursor).join('')
    const after = shown.slice(editor.cursor).join('')
    return { after, before, cursor: focused ? '▍' : '' }
  }

  const selector = (primary: string) =>
    `${action() === 0 ? '▸ ' : '  '}${primary}   ${action() === 1 ? '▸ ' : '  '}Skip`

  return (
    <box
      ref={el => (rootRef = el)}
      focusable
      border
      style={{ borderColor: c().border, flexDirection: 'column', flexShrink: 0, marginTop: 1, padding: 1 }}
    >
      <Show
        when={target()}
        fallback={
          <>
            <text fg={c().muted}>Finishing…</text>
            <text fg={c().muted}>{CONNECTION_HINTS.finishing}</text>
          </>
        }
      >
        {current => (
          <Show
            when={phase() !== 'authorized'}
            fallback={
              <>
                <text fg={c().ok}>
                  <b>Authorized. Tools unavailable.</b>
                </text>
                <Show when={current().discovery_error}>{error => <text fg={c().muted}>{error()}</text>}</Show>
                <text fg={c().accent}>▸ Continue</text>
                <text fg={c().muted}>{CONNECTION_HINTS.authorized}</text>
              </>
            }
          >
            <text fg={c().text}>
              <b>
                🔌 {verbOf(current().action)} {current().display || current().name}
              </b>
            </text>
            <Show when={unresolved().length > 1}>
              <text fg={c().muted}>{`${unresolved().length - 1} more to answer after this one.`}</text>
            </Show>
            <Show when={current().instructions}>{text => <text fg={c().muted}>{text()}</text>}</Show>
            <Show when={hasFailed(current())}>
              <text fg={c().muted}>{failureLine(current())}</text>
            </Show>
            <Show when={phase() === 'browser'}>
              <text fg={c().accent}>{current().connect_url ?? ''}</text>
            </Show>
            <Show when={phase() === 'working'}>
              <text fg={c().muted}>Working…</text>
            </Show>
            <Show when={phase() === 'form'}>
              <For each={fields()}>
                {(field, index) => {
                  const focused = () => !selectorFocused() && row() === index()
                  const parts = () => fieldText(field, focused())
                  return (
                    <box style={{ flexDirection: 'column', flexShrink: 0 }}>
                      <text fg={focused() ? c().accent : c().label}>
                        {`${focused() ? '▸ ' : '  '}${fieldLabel(field)}${field.required ? ' *' : ''}`}
                      </text>
                      <box style={{ flexDirection: 'row', paddingLeft: 2, flexShrink: 0 }}>
                        <text fg={c().text}>{parts().before}</text>
                        <text fg={c().accent}>{parts().cursor}</text>
                        <text fg={c().text}>{parts().after}</text>
                      </box>
                    </box>
                  )
                }}
              </For>
            </Show>
            <Show when={current().detail}>{detail => <text fg={c().error}>{detail()}</text>}</Show>
            <Show when={phase() === 'form' || phase() === 'retry'}>
              <text fg={selectorFocused() ? c().accent : c().muted}>
                {selector(phase() === 'retry' ? 'Try again' : verbOf(current().action))}
              </text>
            </Show>
            <Show when={phase() === 'form' && missing()}>
              {field => <text fg={c().muted}>{`${fieldLabel(field())} is required.`}</text>}
            </Show>
            <Show when={notice()}>{text => <text fg={c().error}>{text()}</text>}</Show>
            <Show when={sending()}>
              <text fg={c().muted}>Pending…</text>
            </Show>
            <text fg={c().muted}>{CONNECTION_HINTS[phase() ?? 'form']}</text>
          </Show>
        )}
      </Show>
    </box>
  )
}
