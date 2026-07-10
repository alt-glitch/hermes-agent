/**
 * ConfirmPrompt — a LOCAL (non-gateway) Y/N dialog (spec §2a). Driven by a local
 * callback, not an RPC: y/Enter → confirm, n/Esc/Ctrl+C → cancel. Used by client
 * slash commands like /clear and /new.
 */
import type { BoxRenderable } from '@opentui/core'
import { useBindings } from '@opentui/keymap/solid'
import { onMount } from 'solid-js'

import type { ConfirmSpec } from '../../logic/store.ts'
import { useTheme } from '../theme.tsx'

export function ConfirmPrompt(props: { spec: ConfirmSpec; onYes: () => void; onNo: () => void }) {
  const theme = useTheme()
  let rootRef: BoxRenderable | undefined
  // No focusable child here (unlike the <select> prompts), so focus the dialog box
  // itself on mount — that makes the focus-within keymap layer below active.
  onMount(() => rootRef?.focus())
  // Local Y/N dialog: y/Enter → confirm, n/Esc/Ctrl+C → cancel, scoped to the
  // dialog box (focus-within) via the native keymap.
  useBindings<BoxRenderable>(() => ({
    target: () => rootRef,
    commands: [
      {
        name: 'confirm',
        run() {
          props.onYes()
        }
      },
      {
        name: 'cancel',
        run() {
          props.onNo()
        }
      }
    ],
    bindings: [
      { key: 'y', cmd: 'confirm' },
      { key: 'return', cmd: 'confirm' },
      { key: 'n', cmd: 'cancel' },
      { key: 'escape', cmd: 'cancel' },
      { key: { name: 'c', ctrl: true }, cmd: 'cancel' }
    ]
  }))

  return (
    <box
      ref={el => (rootRef = el)}
      focusable
      style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, marginTop: 1, padding: 1 }}
      border
    >
      <text fg={props.spec.danger ? theme().color.error : theme().color.warn}>
        <b>{props.spec.title}</b>
      </text>
      {props.spec.detail ? <text fg={theme().color.muted}>{props.spec.detail}</text> : null}
      <text fg={theme().color.muted}>
        y/Enter {props.spec.confirmLabel ?? 'confirm'} · n/Esc {props.spec.cancelLabel ?? 'cancel'}
      </text>
    </box>
  )
}
