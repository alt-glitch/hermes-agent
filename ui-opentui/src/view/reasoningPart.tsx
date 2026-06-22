/**
 * ReasoningPart — the model's thinking trace, collapsible (item 6; opencode's
 * ReasoningPart/ReasoningHeader). Auto-EXPANDED while the turn streams (so you
 * watch it think), then COLLAPSES to a one-line `▶ Thought: <title>` once the
 * turn settles. Click the header to override either way.
 *
 *   ▼ Thinking: <title>        ← live (streaming), body shown
 *   ◐ Thought: <title>         ← settled (collapsed), click to reopen
 *   │ <reasoning markdown>     ← dim body in a left-bordered block
 *
 * Title is the model's leading `**bold**` line when present (opencode's
 * reasoningSummary). ALL muted (design pass: thinking is the most secondary
 * tier — glyph, label, and border ride the neutral grey; no accent ink) and
 * nested +2 columns with the tools (the machinery tier under the turn).
 */
import { createMemo, createSignal, Show } from 'solid-js'

import type { ThemeColors } from '../logic/theme.ts'
import { useDisplay } from './display.tsx'
import { Markdown } from './markdown.tsx'
import { useScrollAnchor } from './scrollAnchor.tsx'
import { useTheme } from './theme.tsx'

const GUTTER = 2
/** Machinery-tier nesting (design pass): thinking indents +2 with the tools. */
const INDENT = 2

/**
 * Header label style — reasoning is the MOST secondary tier, so the word
 * Thinking/Thought + its title preview stay muted but render ITALIC: a
 * `▶ Thought` row reads as a different KIND of row than a tool at a glance
 * (tools carry a bold text-colored name; reasoning stays quiet, just
 * recognizably distinct). Exported so tests can pin the selection logic
 * (char frames carry no color/attribute info).
 */
export function reasoningLabelStyle(color: ThemeColors): { fg: string; italic: boolean } {
  return { fg: color.muted, italic: true }
}

/** Split a leading `**Title**\n\n body` into {title, body} (opencode reasoningSummary). */
function reasoningSummary(text: string): { title?: string; body: string } {
  const s = (text ?? '').replace('[REDACTED]', '').trim()
  const m = s.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  const title = m?.[1]?.trim()
  if (!m || !title) return { body: s }
  return { title, body: s.slice(m[0].length).trimStart() }
}

export function ReasoningPart(props: { text: string; streaming?: boolean }) {
  const theme = useTheme()
  const anchor = useScrollAnchor()
  const display = useDisplay()
  const [override, setOverride] = createSignal<boolean | undefined>(undefined)
  // live → expanded so you see it think; settled → collapsed, unless the global
  // /details mode is `expanded` (previews default-open) OR /reasoning full is on
  // (expands ALL thinking independently of the global /details mode). Click
  // overrides — a user who clicked a section collapsed keeps it until they click
  // again (override() still wins).
  const expanded = () =>
    override() ?? (!!props.streaming || display().details === 'expanded' || display().reasoningFull)
  const toggle = () => anchor(() => setOverride(!expanded()))
  const summary = createMemo(() => reasoningSummary(props.text))
  const label = () => (props.streaming ? 'Thinking' : 'Thought')

  return (
    <Show when={summary().body || summary().title}>
      <box style={{ flexDirection: 'column', flexShrink: 0, marginLeft: INDENT }}>
        <box style={{ flexDirection: 'row', flexShrink: 0 }} onMouseDown={toggle}>
          <box style={{ flexShrink: 0, width: GUTTER }}>
            {/* ◐ collapsed / ▼ expanded — MUTED, never accent (design pass:
                thinking spends no warm ink; the half-moon also reads as a
                different KIND of row than a tool's $/◇/… at a glance). */}
            <text selectable={false}>
              <span style={{ fg: theme().color.muted }}>{expanded() ? '▼' : '◐'}</span>
            </text>
          </box>
          {/* the header is a collapsible-section LABEL (Thinking/Thought + title)
              — chrome, not the reasoning body — so a free-form drag yields only
              the markdown body below, not the section label (item 4). */}
          <text selectable={false}>
            {/* muted ITALIC label keeps reasoning the most secondary tier AND
                visibly a different kind of row than a tool (bold name) — see
                reasoningLabelStyle. */}
            <span style={reasoningLabelStyle(theme().color)}>{label()}</span>
            <Show when={summary().title}>
              <span style={reasoningLabelStyle(theme().color)}>{`: ${summary().title}`}</span>
            </Show>
          </text>
        </box>
        <Show when={expanded() && summary().body}>
          <box
            style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0, marginLeft: GUTTER, paddingLeft: 1 }}
            border={['left']}
            borderColor={theme().color.muted}
          >
            <Markdown text={summary().body} streaming={props.streaming ?? false} fg={theme().color.muted} />
          </box>
        </Show>
      </box>
    </Show>
  )
}
