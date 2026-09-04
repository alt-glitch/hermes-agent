/**
 * Fenced-code-block plugins for the native `<markdown>` renderable — the
 * registry that decides which fence languages get a custom renderable instead
 * of OpenTUI's default `<code>` rendering. Mirrors `view/tools/registry.tsx`
 * (static typed table; unmapped languages fall through to the default) and
 * pi's `MarkdownTransformer` extension point, condensed to what has a real
 * consumer today: Mermaid diagrams.
 *
 * A plugin returns `null` to decline (the caller then uses the default
 * fenced-code renderable), matching OpenTUI's `MarkdownCodeBlockRenderer`
 * contract exactly.
 */
import {
  bold,
  fg,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  type CliRenderer,
  type MarkdownCodeBlockRenderer,
  type Renderable,
  type TextChunk
} from '@opentui/core'
import type { Span } from 'grok-mermaid'

import { mermaidFenceIsClosed, renderMermaidTerminal, type MermaidDiagram } from '../../logic/mermaid.ts'
import type { Theme } from '../../logic/theme.ts'

type CodeBlockToken = Parameters<MarkdownCodeBlockRenderer>[0]

/** Context handed to a fence plugin — everything the view used to close over. */
export interface CodeBlockContext {
  readonly theme: Theme
  readonly renderer: CliRenderer
  /** Columns the markdown block may use (terminal width minus chrome). */
  readonly availableWidth: number
  /** OpenTUI's default fenced-code renderable for this token. */
  readonly defaultRender: () => Renderable | null
}

export type CodeBlockPlugin = (token: CodeBlockToken, context: CodeBlockContext) => Renderable | null

const FALLBACK = RGBA.fromHex('#E6EDF3')
const HEX6 = /^#[0-9a-fA-F]{6}$/

/** Theme colors are usually hex but may be `ansi256(n)`/`rgb(...)` after
 *  light-mode normalization — only hand hex to RGBA.fromHex, else fall back. */
function rgba(color: string): RGBA {
  return HEX6.test(color) ? RGBA.fromHex(color) : FALLBACK
}

/** grok-mermaid semantic class → themed chunk (pi's mapping, our palette). */
function chunkFor(span: Span, theme: Theme): TextChunk {
  const c = theme.color
  switch (span.cls) {
    case 'border':
      return fg(rgba(c.muted))(span.text)
    case 'edge':
      return fg(rgba(c.accent))(span.text)
    case 'edgeLabel':
      return fg(rgba(c.muted))(span.text)
    case 'title':
      return bold(fg(rgba(c.accent))(span.text))
    case 'text':
    case 'none':
      return fg(rgba(c.text))(span.text)
  }
}

const NEWLINE: TextChunk = { __isChunk: true, text: '\n' }

function styledDiagram(diagram: MermaidDiagram, warning: string | undefined, theme: Theme): StyledText {
  const chunks: TextChunk[] = []
  diagram.rows.forEach((row, index) => {
    if (index > 0) chunks.push(NEWLINE)
    for (const span of row) chunks.push(chunkFor(span, theme))
  })
  if (warning !== undefined) chunks.push(NEWLINE, fg(rgba(theme.color.muted))(warning))
  return new StyledText(chunks)
}

/** Advisory parse warnings render as one muted line under the art (pi parity)
 *  — never a reason to withhold the diagram. Box-safe ASCII marker: `⚠` is
 *  ambiguous-width (2 columns in many terminals) and would break the fixed
 *  width accounting below. */
function warningText(diagram: MermaidDiagram): string | undefined {
  const first = diagram.warnings[0]
  if (first === undefined) return undefined
  const suffix = diagram.warnings.length > 1 ? ` (+${diagram.warnings.length - 1} more)` : ''
  return `! mermaid: ${first}${suffix}`
}

/**
 * A non-focusable horizontal viewport around fixed-size content. The terminal
 * width is not the Markdown parent's width (dialogs/padded rows can be much
 * narrower), and ScrollBox auto-hides its bar when content fits the layout.
 */
function horizontalViewport(
  context: CodeBlockContext,
  content: Renderable,
  size: { readonly width: number; readonly height: number }
): ScrollBoxRenderable {
  const viewport = new ScrollBoxRenderable(context.renderer, {
    contentOptions: { height: size.height, width: size.width },
    focusable: false,
    height: size.height + 1,
    horizontalScrollbarOptions: {
      showArrows: true,
      trackOptions: {
        backgroundColor: context.theme.color.border,
        foregroundColor: context.theme.color.accent
      }
    },
    scrollX: true,
    scrollY: false,
    width: '100%'
  })
  // ScrollBoxRenderable 0.4.1 hard-resets `_focusable = true` after its base
  // constructor, so the option alone is ignored. Explicitly use the public
  // setter: mouse wheel/drag remain hit-tested, while composer arrows and h/l
  // can never be stolen by an inline diagram.
  viewport.focusable = false
  viewport.add(content)
  return viewport
}

const mermaidCodeBlock: CodeBlockPlugin = (token, context) => {
  if (!mermaidFenceIsClosed(token.raw)) return null
  const result = renderMermaidTerminal(token.text, context.availableWidth)
  if (result.kind === 'fallback') return null
  // The warning line (when present) adds a content row beyond the art itself —
  // the viewport is scrollY:false, so height AND width must account for it.
  const warning = warningText(result)
  const height = result.height + (warning === undefined ? 0 : 1)
  const width = Math.max(result.width, warning?.length ?? 0)
  const diagram = new TextRenderable(context.renderer, {
    content: styledDiagram(result, warning, context.theme),
    fg: context.theme.color.text,
    selectable: true,
    height,
    width,
    wrapMode: 'none'
  })
  return horizontalViewport(context, diagram, { height, width })
}

/** Fence language → plugin. Unmapped languages use OpenTUI's default `<code>`. */
export const CODE_BLOCKS: Readonly<Record<string, CodeBlockPlugin>> = {
  mermaid: mermaidCodeBlock
}
