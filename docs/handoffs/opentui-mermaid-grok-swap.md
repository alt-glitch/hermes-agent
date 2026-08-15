# OpenTUI: swap beautiful-mermaid → grok-mermaid + markdown plugin surfaces

**Status:** spec for review · **Branch:** `sid/opentui` · **Scope:** `ui-opentui/` only (no gateway/Python)

## Why

Pi (earendil-works/pi) shipped native mermaid in v0.84.0 (commit `66534fbdc`, 89 lines)
on **grok-mermaid** — xAI's Apache-2.0 mermaid→Unicode renderer. Measured against our
beautiful-mermaid 1.1.3 pipeline:

| | beautiful-mermaid 1.1.3 (ours) | grok-mermaid 0.2.2 |
|---|---|---|
| Layout engine | ELK (superlinear; 581-byte/50-edge chain ≈ 19s sync) | own layout; same input **2ms** |
| Complexity budget | required (24 stmts / 20 markers, hand-rolled scanner) | unnecessary — delete it |
| Compact `A-->B` / `graph LR;` | misparses; we hand-normalize (`normalizeMermaidSource`) | parses natively — delete it |
| Output color | monochrome string | semantic `Span[][]` (`border/text/edge/edgeLabel/title/none`) → **theme-colored diagrams** |
| Streaming tolerance | none (invalid → fallback) | strict grammars retry minus last line → art stays up mid-stream |
| Warnings | none | advisory `warnings[]` (flowchart drops unparsable lines, renders rest) |
| Coverage | flowchart/sequence/state/class/ER **+ xychart** | flowchart(+subgraph)/sequence/state/class/ER — **no xychart/pie/gantt/mindmap** |
| Deps | ELK + string-width | zero deps, 644KB, `node>=18`, ESM, pure TS (no WASM) |

Verified by probe (`npm pack grok-mermaid@0.2.2`, node driver): semicolon headers OK,
CRLF OK, label-embedded `-->` preserved, half-typed streaming sequence renders, ANSI
escape **leaks into labels** (`[31m` visible) → our `stripControls` must stay.

Trade-off accepted: xychart-beta regresses to fenced-code fallback. All the diagram
types agents actually emit (flowchart/sequence/state/class/ER) are covered, plus
subgraph which beautiful-mermaid ASCII didn't do well.

## Design

### A. `logic/mermaid.ts` — rewrite around grok-mermaid

New result contract (idiomatic discriminated union, mirrors grok's semantic spans):

> **Corrections from adversarial review (2026-08-16, both reviewers):** grok's
> `MermaidArt` fields are `styled: Span[][]` (NOT `rows`), `plain: string[]`
> (per-row array, NOT a joined string), and there is **no `height`** — derive
> `styled.length`. Our `MermaidDiagram` below is our OWN mapped type. Tests:
> grok emits `▶` U+25B6 arrowheads (bm emitted `►` U+25BA) — update the glyph in
> mermaidMarkdown.test.tsx:46; every retained `.text` assertion (9 sites) renames
> to `.plain`; DELETE mermaid.test.ts:75 (complexity-budget reject, contradicts
> the new 50-edge test) and :82 (comment budget); :62's paddingX-tier name is
> stale. Warning line: viewport `height` + `contentOptions.height` MUST include
> the warning row or it clips (scrollY:false). stripControls rationale corrected:
> grok strips ESC itself; ours stays for C0/DEL/C1 + CRLF belt-and-suspenders.
> `render()→null` covers both invalid AND too-big — map all null → 'invalid'.

```ts
import { render, type Span } from 'grok-mermaid'  // MermaidArt: {plain: string[], styled: Span[][], width, warnings}

export interface MermaidDiagram {
  readonly kind: 'diagram'
  /** Rows of semantic spans — the view maps Cls → theme colors. */
  readonly rows: ReadonlyArray<ReadonlyArray<Span>>
  readonly plain: string          // trimmed monochrome text (copy/paste, tests)
  readonly width: number          // grok-reported display columns
  readonly height: number
  readonly warnings: readonly string[]
  readonly scrollable: boolean
}
export interface MermaidFallback {
  readonly kind: 'fallback'
  readonly reason: 'invalid' | 'too-large'
}
export type MermaidRenderResult = MermaidDiagram | MermaidFallback
```

`renderMermaidTerminal(source, availableWidth)`:
1. `stripControls` + CRLF-normalize + trim (KEEP — grok leaks ANSI/C0 into labels).
2. Cheap source caps stay as a DoS belt: `MERMAID_SOURCE_LIMIT` 64KB /
   `MERMAID_LINE_LIMIT` 400 → `'too-large'`.
3. `render(clean)` → `null` ⇒ `'invalid'` (view falls back to fenced code, unchanged UX).
4. Output caps: keep `MERMAID_WIDTH_LIMIT` 1000 / `MERMAID_HEIGHT_LIMIT` 400 ⇒ `'too-large'`.
5. `scrollable = width > max(20, floor(availableWidth))`.

**DELETE:** `normalizeMermaidSource` (bm parser workaround), `withinComplexityBudget` +
`MERMAID_STATEMENT_LIMIT`/`MERMAID_STRUCTURE_MARKER_LIMIT` (ELK-timing guard), the
64-entry LRU `variantCache` + `variantFor` (render is 1–3ms; `internalBlockMode="top-level"`
already prevents per-delta re-render of settled blocks; resize re-render at 3ms is free),
the `paddingX` width-preset ladder (grok has no padding knobs; layout is fixed), the
`string-width` import (grok reports `width` itself).

**KEEP:** `mermaidFenceIsClosed` unchanged — mid-stream fences still render as plain
code until closed. (grok tolerates half-typed input, but swapping a code block for a
diagram and back per keystroke would churn renderables; closed-fence gating stays.)

`package.json`: `- beautiful-mermaid@1.1.3`, `+ grok-mermaid@0.2.2` (exact pin, repo
convention). `string-width` is mermaid-only today (grep-verified) → drop it too.

### B. Theme-colored diagrams — `Span → TextChunk`

Map grok's `Cls` onto our `Theme` (same palette philosophy as `buildSyntaxStyle`;
pi's mapping as prior art):

| Cls | theme token |
|---|---|
| `border` | `muted` |
| `text` | `text` |
| `edge` | `accent` |
| `edgeLabel` | `muted` |
| `title` | `accent` + bold |
| `none` | plain (no fg) |

Build one `StyledText` from `@opentui/core` chunk builders (`fg(color)(text)`,
`bold`), rows joined by `\n` chunks, handed to the existing `TextRenderable` as
`content`. Reuse the `rgba()`/HEX6 guard from `markdown.tsx` (theme colors can be
`ansi256(n)` after light-mode normalization) — export it or duplicate the 3-liner
into the new module; reviewer's call.

Warnings (pi parity, our chrome): when `warnings.length > 0`, append one muted line
under the diagram inside the same viewport content:
`⚠ mermaid: <first warning>[ (+N more)]` — muted fg, never blocks the art
(grok docs: warnings are advisory; do not gate).

### C. Plugin surfaces — condense the seams we touch

Today `view/markdown.tsx` inlines the mermaid renderable construction (~40 lines of
ScrollBox/TextRenderable plumbing) inside the `Markdown` component, and
`preprocessMath` is a hardcoded call. Two typed registries, mirroring
`view/tools/registry.tsx` (in-repo precedent), pi's `MarkdownTransformer`, and
opencode's `feature-plugins/builtins.ts` (typed builtin-module array):

**1. `view/markdown/codeBlocks.tsx` — fence renderer registry**

```ts
/** Context handed to a fence plugin — everything markdown.tsx used to close over. */
export interface CodeBlockContext {
  readonly theme: Theme
  readonly renderer: CliRenderer
  readonly availableWidth: number
  /** OpenTUI's default fenced-code renderable for this token. */
  readonly defaultRender: () => Renderable | null
}
export type CodeBlockPlugin = (token: Tokens.Code, ctx: CodeBlockContext) => Renderable | null

/** lang → plugin; null/absent ⇒ OpenTUI default <code> rendering. */
export const CODE_BLOCKS: Readonly<Record<string, CodeBlockPlugin>> = { mermaid: mermaidCodeBlock }
```

`mermaidCodeBlock` (same file or `view/markdown/mermaidBlock.tsx`) owns: fence-closed
gate, `renderMermaidTerminal`, Span→StyledText theming, warning line, and the
horizontal `ScrollBoxRenderable` viewport (focusable=false workaround comment rides
along). The viewport wrapper is extracted as `horizontalViewport(renderer, theme,
content, {width, height})` — it's the reusable piece any future wide-block plugin
(tables? images?) needs.

`markdown.tsx`'s `renderNode` memo collapses to:

```ts
createMarkdownCodeBlockRenderer(
  mapValues(CODE_BLOCKS, plugin => (token, context) =>
    plugin(token, { theme: theme(), renderer, availableWidth, defaultRender: context.defaultRender }))
) ?? (() => undefined)
```

(Concretely: a small adapter, not a `mapValues` dep — plain object literal is fine
with one entry; the point is markdown.tsx stops knowing what mermaid is.)

**2. `logic/markdownTransforms.ts` — pre-parse text pipeline (pi's shape)**

```ts
export interface TransformContext { readonly streaming: boolean }
export type MarkdownTransform = (markdown: string, ctx: TransformContext) => string
export const TRANSFORMS: readonly MarkdownTransform[] = [mathTransform]
export const applyTransforms = (text: string, ctx: TransformContext): string =>
  TRANSFORMS.reduce((acc, t) => t(acc, ctx), text)
```

`mathTransform` wraps the existing `preprocessMath` (which already takes
`{streaming}`). `markdown.tsx`'s `content` memo calls `applyTransforms`. Zero
behavior change; the seam is now named and typed, and the next transform (emoji
shortcodes, callout syntax, whatever) is a one-line registry append instead of
another hardcoded import chain.

Not building: dynamic runtime registration (`registerX()` mutability), config
gating (pi's `off/final/streaming` knob), or cross-package plugin loading — no
consumer exists; AGENTS.md forbids speculative hooks. These registries are static
`const` tables like `TOOLS` — the *surface* is the exported type + table, and
making it dynamic later is additive.

### D. Tests — rewrite to the new behavior (never weaken)

- `mermaid.test.ts`: DROP xychart case (grok doesn't draw it) → replace with an
  explicit `xychart-beta → fallback 'invalid'` assertion + a `subgraph` render case
  (new capability). Compact/semicolon/label-arrow cases stay (now native). ADD:
  spans carry semantic classes (`rows.flat().some(s => s.cls === 'edge')`), warnings
  surface on flowchart-with-garbage, 50-edge chain renders as `'diagram'` (the old
  budget rejected it — behavior change, assert the improvement) **with a wall-clock
  guard** (`expect(elapsed).toBeLessThan(1000)`) so an ELK-class regression fails
  loud. DELETE complexity-budget tests.
- `mermaidMarkdown.test.tsx`: viewport/overflow/resize/fence tests stay (contract
  unchanged). ADD: themed chunks present (TextRenderable content is StyledText with
  >1 distinct fg) — headless-safe: plain `TextRenderable`, NOT native `<markdown>`
  body (which never paints headless), and these assertions read renderable state,
  not captured frames. ADD: warning line appears for a warned diagram when closed.
- New `markdownTransforms.test.ts`: transform order + streaming flag threading
  (table test, 10 lines).

### E. Gate + live verify

1. `unset NODE_ENV; npm ci` (after dep swap) — fnm Node 26.3 PATH.
2. `npm run check` → `echo $?` = 0.
3. `node scripts/build.mjs` → dist.
4. Live tmux smoke (isolated `HERMES_HOME`): prompt the agent to emit a flowchart +
   a sequence diagram; screenshot; verify themed colors + horizontal scroll on a
   wide one. (Colors are NOT headless-verifiable — live smoke is the proof.)

## Files touched

| File | Change |
|---|---|
| `ui-opentui/package.json` | dep swap; drop string-width |
| `ui-opentui/src/logic/mermaid.ts` | rewrite (§A) — expect net −80 lines |
| `ui-opentui/src/view/markdown.tsx` | shrink: transforms pipeline + registry adapter (§C) |
| `ui-opentui/src/view/markdown/codeBlocks.tsx` | NEW — registry + mermaid plugin + viewport helper |
| `ui-opentui/src/logic/markdownTransforms.ts` | NEW — transform pipeline |
| `ui-opentui/src/test/mermaid.test.ts` | rewrite (§D) |
| `ui-opentui/src/test/mermaidMarkdown.test.tsx` | extend (§D) |
| `ui-opentui/src/test/markdownTransforms.test.ts` | NEW |

## Known traps (pre-warn the implementer)

- `exactOptionalPropertyTypes` — conditional-assign optional fields, never explicit `undefined`.
- `no-non-null-assertion` is error in prod code (test files exempt).
- grok-mermaid is ESM-only (`"type":"module"`, exports map) — fine for our esbuild ESM
  build + vitest; do not add a require() anywhere.
- Theme colors may be non-hex after light-mode normalization → route through the HEX6
  guard before `fg()`.
- StyledText content on TextRenderable: verify `content` setter accepts StyledText
  (it does — `Text.d.ts: set content(value: StyledText | string)`), and `wrapMode:
  'none'` + explicit width/height stay (scroll geometry depends on them).
- Prettier runs in --check: run `npx prettier --write` on new files before the gate.
