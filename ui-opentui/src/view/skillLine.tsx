/**
 * SkillLine — a skill slash-command invocation (e.g. `/dogfood`) rendered as a
 * COLLAPSED `role=user` row instead of dumping the entire skill body (100-400
 * lines of markdown) as a giant user bubble (glitch 2026-06-23).
 *
 *   ▶ /dogfood  · 312 lines        ← collapsed (default)
 *   ▼ /dogfood  · 312 lines        ← expanded header
 *   │ <full skill body>            ← the skill content, behind the toggle
 *
 * The FULL body still goes to the model (it lives in `message.text`, sent via
 * prompt.submit) — this is purely a transcript-render nicety. Mirrors the
 * ToolPart expand mechanics (per-instance override signal + useScrollAnchor so
 * expanding never yanks the viewport; left-bordered body frame). The header is
 * chrome (selectable=false); the body is the copyable content. Defaults to
 * collapsed for transcript scannability — the agent reply follows immediately.
 */
import { createSignal, Show } from 'solid-js'

import type { Message } from '../logic/store.ts'
import { Markdown } from './markdown.tsx'
import { useScrollAnchor } from './scrollAnchor.tsx'
import { useTheme } from './theme.tsx'

const GUTTER = 2

export function SkillLine(props: { message: Message }) {
  const theme = useTheme()
  const anchor = useScrollAnchor()
  const [expanded, setExpanded] = createSignal(false)
  const toggle = () => anchor(() => setExpanded(!expanded()))

  const skill = () => props.message.skill
  const command = () => skill()?.command ?? ''
  const lineCount = () => skill()?.lineCount ?? 0
  // A near-empty body has nothing worth expanding (still collapse the header
  // for visual consistency, but don't offer a toggle to an empty body).
  const collapsible = () => Boolean(props.message.text.trim())

  return (
    <box style={{ flexDirection: 'column', flexShrink: 0 }}>
      {/* header — clickable to toggle; the user `❯` glyph keeps the turn read
          as a user invocation (CC design: role=user, distinct treatment). */}
      <box style={{ flexDirection: 'row', flexShrink: 0 }} onMouseDown={() => collapsible() && toggle()}>
        <box style={{ flexShrink: 0, width: GUTTER }}>
          <text selectable={false}>
            <span style={{ fg: theme().color.primary }}>
              <b>{theme().brand.prompt}</b>
            </span>
          </text>
        </box>
        <box style={{ flexDirection: 'row', flexGrow: 1, minWidth: 0 }}>
          <text selectable={false}>
            {/* expand caret (▶/▼) — only when there's a body to reveal */}
            <Show when={collapsible()}>
              <span style={{ fg: theme().color.muted }}>{expanded() ? '▼ ' : '▶ '}</span>
            </Show>
            {/* the slash invocation as typed (incl. args) — the identity of the
                loaded skill, muted-bright so it reads as a command not prose */}
            <span style={{ fg: theme().color.statusFg }}>
              <b>{command()}</b>
            </span>
            {/* honest body size */}
            <Show when={lineCount() > 0}>
              <span
                style={{ fg: theme().color.muted }}
              >{`  · ${lineCount()} line${lineCount() === 1 ? '' : 's'}`}</span>
            </Show>
          </text>
        </box>
      </box>

      {/* expanded body — the full skill content inside a left-bordered frame
          (same chrome as the tool-output renderer). The body IS the copyable
          content (the skill markdown). */}
      <Show when={collapsible() && expanded()}>
        <box
          style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0, marginLeft: GUTTER, paddingLeft: 1 }}
          border={['left']}
          borderColor={theme().color.shellDollar}
        >
          <Markdown text={props.message.text.replace(/^\n+|\n+$/g, '')} streaming={false} fg={theme().color.muted} />
        </box>
      </Show>
    </box>
  )
}
