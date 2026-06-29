/**
 * MoaReferencePart — one reference model's full output in a mixture-of-agents
 * (MoA) turn, shown as its own labelled block BEFORE the aggregator responds:
 *
 *   ◇ Reference 1/3 — openrouter:openai/gpt-5.5   ← header (chrome)
 *   │ <that reference model's markdown output>     ← dim body, left-bordered
 *
 * Unlike ReasoningPart this is ALWAYS expanded and is PRIMARY content (the user
 * opted into the mixture process), so it is NOT collapsed by `/details` and not
 * gated by any reasoning toggle. It carries the source-model label + position
 * (index/count), arrives complete (one event per reference), and is never merged
 * with siblings. Port of Ink's turnController.recordMoaReference (163cb24d4).
 */
import { Show } from 'solid-js'

import { Markdown } from './markdown.tsx'
import { useTheme } from './theme.tsx'

const GUTTER = 2
/** Match ReasoningPart's machinery-tier nesting (+2 columns). */
const INDENT = 2

/** `◇ Reference 1/3 — label` when index+count are both present (truthy, matching
 *  Ink's `index && count` — so index 0 falls to the no-number form); else
 *  `◇ Reference — label`. Exported so a char-frame test can pin the header text. */
export function moaReferenceHeader(label: string, index?: number, count?: number): string {
  return index && count ? `Reference ${index}/${count} — ${label}` : `Reference — ${label}`
}

export function MoaReferencePart(props: { part: { label: string; text: string; index?: number; count?: number } }) {
  const theme = useTheme()
  const header = () => moaReferenceHeader(props.part.label, props.part.index, props.part.count)
  const body = () => props.part.text.trim()

  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, marginLeft: INDENT }}>
      <box style={{ flexDirection: 'row', flexShrink: 0 }}>
        <box style={{ flexShrink: 0, width: GUTTER }}>
          {/* ◇ diamond — single-width BMP glyph; marks a reference block, a
              different KIND of row than a tool ($/◇…) or reasoning (◐/▼). Muted:
              the reference body is the content, the header is quiet chrome. */}
          <text selectable={false}>
            <span style={{ fg: theme().color.muted }}>◇</span>
          </text>
        </box>
        {/* header is a LABEL (chrome) — a free-form drag yields only the markdown
            body below, not the `◇ Reference …` line. */}
        <text selectable={false}>
          <span style={{ fg: theme().color.muted }}>{header()}</span>
        </text>
      </box>
      <Show when={body()}>
        <box
          style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0, marginLeft: GUTTER, paddingLeft: 1 }}
          border={['left']}
          borderColor={theme().color.muted}
        >
          <Markdown text={body()} streaming={false} fg={theme().color.muted} />
        </box>
      </Show>
    </box>
  )
}
