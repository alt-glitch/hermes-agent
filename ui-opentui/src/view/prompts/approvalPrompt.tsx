/**
 * ApprovalPrompt — dangerous-command approval (spec §8 #6). Native `<select>`
 * (built-in ↑↓/j/k/Enter nav) over once/session/always/deny; a small `useKeyboard`
 * adds the Esc/Ctrl+C → deny cancel path the select doesn't cover. Answered via
 * `approval.respond {choice, session_id}`.
 */
import type { BoxRenderable } from '@opentui/core'

import { approvalChoices, type ApprovalChoice, type ApprovalChoicePolicy } from '../../logic/approval.ts'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'

const COPY: Record<ApprovalChoice, { description: string; name: string }> = {
  once: { description: 'Run this command this one time', name: 'Approve once' },
  session: { description: 'Allow for the rest of this session', name: 'Approve for session' },
  always: { description: 'Always allow this command', name: 'Always approve' },
  deny: { description: 'Reject this command', name: 'Deny' }
}

export function approvalOptions(policy: ApprovalChoicePolicy) {
  return approvalChoices(policy).map(value => ({ ...COPY[value], value }))
}

export function ApprovalPrompt(props: {
  allowPermanent: ApprovalChoicePolicy
  command: string
  description: string
  onChoose: (choice: ApprovalChoice) => void
  onCancel: () => void
}) {
  const theme = useTheme()
  let rootRef: BoxRenderable | undefined
  // Native select handles ↑↓/j/k/Enter over the options; the keymap owns the
  // Esc/Ctrl+C → deny cancel path the select doesn't cover.
  useCloseLayer(
    () => rootRef,
    () => props.onCancel()
  )

  return (
    <box
      ref={el => (rootRef = el)}
      style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, marginTop: 1, padding: 1 }}
      border
    >
      <text fg={theme().color.warn}>
        <b>⚠ Approval required</b>
      </text>
      <text fg={theme().color.text}>{props.command}</text>
      {props.description ? <text fg={theme().color.muted}>{props.description}</text> : null}
      <select
        focused
        options={approvalOptions(props.allowPermanent)}
        onSelect={(_index, option) => {
          if (option) props.onChoose(option.value as ApprovalChoice)
        }}
        backgroundColor={theme().color.statusBg}
        selectedBackgroundColor={theme().color.selectionBg}
        textColor={theme().color.text}
        selectedTextColor={theme().color.text}
        descriptionColor={theme().color.muted}
        style={{ height: 8, marginTop: 1 }}
      />
      <text fg={theme().color.muted}>↑↓ select · Enter confirm · Esc/Ctrl+C deny</text>
    </box>
  )
}
