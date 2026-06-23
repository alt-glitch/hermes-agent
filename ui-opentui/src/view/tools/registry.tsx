/**
 * Tool renderer registry (Epic 2.2) — maps a tool NAME to its renderer. The
 * shared shell (header glyph, expand toggle + scroll anchoring, the left-border
 * body frame) stays in `view/toolPart.tsx` so every tool keeps the house rules
 * (useScrollAnchor, themed chrome) for free; a renderer only supplies what
 * varies per tool:
 *   - `subtitle`   — the collapsed one-line summary shown after the tool name
 *   - `hint`       — an extra muted header note (e.g. delegate_task's monitor tip)
 *   - `expandable` — whether there's a body worth expanding beyond the header
 *   - `Body`       — the expanded body (labeled arg fields / output / diff)
 *
 * Unmapped tools (incl. MCP tools) fall back to the labeled-fields default
 * renderer — NEVER a raw JSON dump. To add a per-tool renderer: export a
 * `ToolRenderer` from a sibling module and add its tool names to `TOOLS`
 * (see `fileTool.tsx` — read/write/edit path + full diff, Epic 2.3).
 */
import type { Component } from 'solid-js'

import type { DiffStats } from '../../logic/diff.ts'
import type { ToolPartState } from '../../logic/store.ts'
import { bashRenderer } from './bashTool.tsx'
import { clarifyRenderer } from './clarifyTool.tsx'
import { defaultRenderer } from './defaultTool.tsx'
import { delegateRenderer } from './delegateTool.tsx'
import { fileRenderer } from './fileTool.tsx'
import { readRenderer } from './readTool.tsx'
import { searchRenderer } from './searchTool.tsx'
import { skillRenderer } from './skillTool.tsx'
import { todoRenderer } from './todoTool.tsx'

/** Props every tool Body receives: the part + usable content columns. */
export interface ToolBodyProps {
  part: ToolPartState
  /** Width (columns) available for body lines inside the bordered frame. */
  width: number
  /** Session cwd (from SessionInfoProvider) — file renderers relativize paths. */
  cwd?: string | undefined
}

export interface ToolRenderer {
  /** Collapsed one-line subtitle (verbatim command, primary arg, relative path, …). */
  subtitle: (part: ToolPartState, cwd?: string) => string
  /** Optional muted header note (chrome) — e.g. delegate_task's "(/agents to monitor)". */
  hint?: (part: ToolPartState) => string
  /** Optional `+N −M` change summary, themed by the shell next to the subtitle. */
  stats?: (part: ToolPartState) => DiffStats | undefined
  /** Whether the part has expandable content beyond the header (when settled). */
  expandable: (part: ToolPartState) => boolean
  /** The lines the expanded body will actually show — drives the honest
   *  "(N lines)" header count. Defaults to the raw resultText lines. */
  lines?: (part: ToolPartState) => string[]
  /** The expanded body, rendered inside the shared left-bordered frame. */
  Body: Component<ToolBodyProps>
}

/**
 * Per-tool head-glyph vocabulary (visual-hierarchy design pass, Appendix C).
 * The glyph IS the tool's identity in the default (collapsed) view — settled
 * rows show it in machinery blue (`shellDollar`); only the expanded header
 * swaps to `▼`. Running stays `⚡` (accent heat) and failure `✗` (error) —
 * lifecycle owns those two; this map owns WHAT the tool is:
 *   terminal `$` · read `◇` · write/patch `◆` · search `○` · web `●` ·
 *   clarify `?` · skill `▲` · delegate `⚕` (the one whimsy) · MCP/unknown `◦`
 */
export const TOOL_GLYPHS: Record<string, string> = {
  clarify: '?',
  delegate_task: '⚕',
  execute_code: '$',
  patch: '◆',
  process: '$',
  read_file: '◇',
  search_files: '○',
  skill_manage: '▲',
  skill_view: '▲',
  terminal: '$',
  todo: '☰',
  web_extract: '●',
  web_search: '●',
  write_file: '◆'
}

/** Fallback glyph for MCP/unmapped tools. */
export const DEFAULT_TOOL_GLYPH = '◦'

/** The settled head glyph for a tool name (vocabulary survives the default view).
 *  Skin `tool_emojis` overrides win over the built-in vocabulary, then the
 *  per-tool default, then the MCP/unknown fallback. */
export function glyphFor(name: string, overrides?: Record<string, string>): string {
  return overrides?.[name] ?? TOOL_GLYPHS[name] ?? DEFAULT_TOOL_GLYPH
}

const TOOLS: Record<string, ToolRenderer> = {
  // clarify (item 4): collapsed = `question: answer`; expanded = `User
  // answered:` + `· q: a` rows — NEVER the raw JSON result.
  clarify: clarifyRenderer,
  // delegate_task: structured agent-fan-out render (dispatched goals OR joined
  // per-task results) + the Ink-parity monitor hint — NEVER the raw JSON dump.
  delegate_task: delegateRenderer,
  // shell-ish tools (Epic 2.4): collapsed = the command verbatim; expanded =
  // full output (+ the command echo only when the header truncated it, item 3;
  // execute_code's code arg is Tree-sitter highlighted, item 7).
  execute_code: bashRenderer,
  process: bashRenderer,
  terminal: bashRenderer,
  // file-edit tools (Epic 2.3): collapsed = cwd-relative path + `+N −M`;
  // expanded = the FULL native diff.
  patch: fileRenderer,
  // read_file (items 1 + 7): collapsed = relpath; expanded = highlighted
  // content only (limit/offset suppressed).
  read_file: readRenderer,
  // search_files (item 2): collapsed = the pattern; expanded = grep-style
  // result lines only (context/output_mode/… suppressed).
  search_files: searchRenderer,
  skill_manage: fileRenderer,
  // skill_view (item 5): WHICH skill was loaded (+ one-line description) —
  // never the full skill contents.
  skill_view: skillRenderer,
  // todo (panel-primary): collapsed = "N tasks · …" summary; expanded = clean
  // checklist. The LIVE list is the pinned TodoPanel above the composer.
  todo: todoRenderer,
  write_file: fileRenderer
}

/** Resolve the renderer for a tool name (default = labeled-fields fallback). */
export function rendererFor(name: string): ToolRenderer {
  return TOOLS[name] ?? defaultRenderer
}
