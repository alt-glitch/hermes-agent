/**
 * Markdown — assistant/reasoning text via the NATIVE `<markdown>` renderable
 * (`MarkdownRenderable`), exactly as opencode's TextPart (`routes/session/index.tsx`
 * :1687 `<markdown streaming internalBlockMode="top-level" tableOptions conceal>`).
 *
 * Why `<markdown>` (not `<code filetype="markdown">`): the anti-flicker mechanism
 * is `internalBlockMode="top-level"` — each top-level block (heading/para/list/
 * table/fence) becomes its own child renderable and `_stableBlockCount` (managed
 * internally) reports the settled head prefix, so stable blocks are NOT re-rendered
 * per streamed delta. The old `<code>` path re-measured the whole buffer each delta
 * → the content height oscillated → the scrollbar grew/shrank (the streaming
 * flicker regression). `tableOptions` renders GFM tables as an aligned grid WITH
 * inline markdown (bold/italic/code) inside cells — so a separate table renderer
 * is unnecessary. `streaming` keeps the trailing block open while chunks append and
 * finalizes it (half-open tables/fences) when flipped false.
 *
 * The `SyntaxStyle` is derived from the active theme (no hardcoded styles — §7.5)
 * and cached by theme-object identity, so all text parts share ONE instance and
 * it's rebuilt only when the skin changes (a new `Theme` object).
 */
import { createMarkdownCodeBlockRenderer, RGBA, SyntaxStyle } from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { createMemo } from 'solid-js'

import { applyTransforms } from '../logic/markdownTransforms.ts'
import type { Theme } from '../logic/theme.ts'
import { CODE_BLOCKS, type CodeBlockPlugin } from './markdown/codeBlocks.tsx'
import { useTheme } from './theme.tsx'

const FALLBACK = RGBA.fromHex('#E6EDF3')
const HEX6 = /^#[0-9a-fA-F]{6}$/

/** Theme colors are usually hex but may be `ansi256(n)`/`rgb(...)` after light-mode
 *  normalization — only hand hex to RGBA.fromHex, else fall back. */
function rgba(color: string): RGBA {
  return HEX6.test(color) ? RGBA.fromHex(color) : FALLBACK
}

function buildSyntaxStyle(theme: Theme): SyntaxStyle {
  const c = theme.color
  return SyntaxStyle.fromStyles({
    default: { fg: rgba(c.text) },
    // headings/links ride ACCENT, inline code LABEL (design pass): gold
    // `primary` is reserved for the earned lamp (newest answer glyph, `❯`) —
    // prose structure is warm but never the hero color.
    'markup.heading': { bold: true, fg: rgba(c.accent) },
    'markup.heading.1': { bold: true, fg: rgba(c.accent) },
    'markup.heading.2': { bold: true, fg: rgba(c.accent) },
    'markup.heading.3': { bold: true, fg: rgba(c.accent) },
    'markup.bold': { bold: true, fg: rgba(c.text) },
    'markup.italic': { fg: rgba(c.text), italic: true },
    'markup.list': { fg: rgba(c.accent) },
    'markup.quote': { fg: rgba(c.muted) },
    'markup.link': { fg: rgba(c.accent) },
    'markup.raw': { fg: rgba(c.label) },
    'markup.raw.block': { fg: rgba(c.label) },
    // ── CODE token scopes (tree-sitter highlight families; subscopes like
    // `keyword.return` fall back onto these). Without them every code token
    // rendered `default` — syntax highlighting parsed but painted monochrome
    // (glitch's report). Palette stays on existing theme tokens: keywords/
    // numbers warm accent, strings label-gold, comments muted italic,
    // functions the machinery blue, types ok-green; punctuation recedes.
    // The four core families route through the dedicated syntax_* skin tokens
    // (theme-sdk); their DEFAULTS are these same brand tokens (string→label,
    // number/keyword→accent, comment→muted), so a skin without them paints
    // byte-identically.
    comment: { fg: rgba(c.syntaxComment), italic: true },
    keyword: { bold: true, fg: rgba(c.syntaxKeyword) },
    string: { fg: rgba(c.syntaxString) },
    'string.special': { fg: rgba(c.syntaxString) },
    number: { fg: rgba(c.syntaxNumber) },
    boolean: { fg: rgba(c.accent) },
    constant: { fg: rgba(c.accent) },
    function: { fg: rgba(c.shellDollar) },
    'function.method': { fg: rgba(c.shellDollar) },
    constructor: { fg: rgba(c.shellDollar) },
    type: { fg: rgba(c.ok) },
    'type.builtin': { fg: rgba(c.ok) },
    attribute: { fg: rgba(c.label) },
    tag: { fg: rgba(c.accent) },
    property: { fg: rgba(c.text) },
    variable: { fg: rgba(c.text) },
    'variable.builtin': { fg: rgba(c.accent) },
    operator: { fg: rgba(c.muted) },
    punctuation: { fg: rgba(c.muted) },
    'punctuation.bracket': { fg: rgba(c.muted) },
    'punctuation.delimiter': { fg: rgba(c.muted) }
  })
}

let cache: { theme: Theme; style: SyntaxStyle } | undefined
/** Theme-derived SyntaxStyle, cached by theme identity — shared with the
 *  file-tool `<diff>` renderable (one instance per skin, same as markdown). */
export function syntaxStyleFor(theme: Theme): SyntaxStyle {
  if (cache && cache.theme === theme) return cache.style
  const style = buildSyntaxStyle(theme)
  cache = { style, theme }
  return style
}

export function Markdown(props: { text: string; streaming?: boolean; fg?: string }) {
  const theme = useTheme()
  const renderer = useRenderer()
  // Pre-parse text pipeline (logic/markdownTransforms.ts): today Tier-A LaTeX →
  // unicode, BEFORE the native parser sees the text (fences and inline code pass
  // through untouched; unclosed delimiters stay verbatim mid-stream). Memoized so
  // it recomputes only when the text delta arrives, and the no-transform fast
  // path returns the same string identity.
  const content = createMemo(() => applyTransforms(props.text, { streaming: props.streaming ?? false }))
  const renderNode = createMemo(() => {
    // Initial terminal width only selects a spacing density. The native local
    // ScrollBox below owns subsequent parent/terminal resize layout, avoiding
    // one global renderer resize listener per Markdown block in long sessions.
    const availableWidth = Math.max(20, renderer.width - 8)
    // Adapt each CODE_BLOCKS plugin onto OpenTUI's MarkdownCodeBlockRenderer:
    // a `null` return means "use the default fenced-code renderable". The
    // `theme()` read stays INSIDE this memo so a skin change rebuilds the map.
    const activeTheme = theme()
    const adapted = Object.fromEntries(
      Object.entries(CODE_BLOCKS).map(([lang, plugin]: [string, CodeBlockPlugin]) => [
        lang,
        (token: Parameters<CodeBlockPlugin>[0], context: { defaultRender: () => ReturnType<CodeBlockPlugin> }) =>
          plugin(token, {
            availableWidth,
            defaultRender: context.defaultRender,
            renderer,
            theme: activeTheme
          }) ?? context.defaultRender()
      ])
    )
    return createMarkdownCodeBlockRenderer(adapted) ?? (() => undefined)
  })
  // `internalBlockMode="top-level"` is the anti-flicker mode (stable head blocks
  // aren't re-rendered per delta); `tableOptions` gives native GFM tables with
  // inline formatting; `fg` overrides the base text color (muted for reasoning).
  // `conceal` hides the markdown markers for clean prose — mouse-selection then
  // copies the RENDERED text (markers gone) via native selection, by design.
  return (
    <markdown
      content={content()}
      syntaxStyle={syntaxStyleFor(theme())}
      streaming={props.streaming ?? false}
      internalBlockMode="top-level"
      tableOptions={{ style: 'grid', borderColor: theme().color.border }}
      renderNode={renderNode()}
      conceal
      fg={props.fg ?? theme().color.text}
    />
  )
}
