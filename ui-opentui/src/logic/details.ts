/**
 * Detail-mode logic (/details — Epic 3 utility-command port; mirrors Ink
 * `domain/details.ts`). Global mode plus per-section overrides drive how the
 * transcript treats tool + reasoning rows:
 *
 *   - `collapsed` (default): today's behaviour — headers with click-to-expand.
 *   - `expanded`: tool bodies + settled reasoning previews default-OPEN.
 *   - `hidden`: tool/reasoning runs reduce to ONE muted `⚡ N tools hidden`-style
 *     line per run (never silently dropped — flipping the mode back restores,
 *     since the parts stay in the store untouched).
 *
 * Pure data + functions; the store carries the flag, messageLine/toolPart/
 * reasoningPart read it via the display context.
 */
import { Option, Schema } from 'effect'

import type { Part } from './store.ts'

export type DetailsMode = 'hidden' | 'collapsed' | 'expanded'
export type DetailsSection = 'thinking' | 'tools' | 'subagents' | 'activity' | 'delegation'
export type DetailsSections = Partial<Record<DetailsSection, DetailsMode>>

/** Cycle order (Ink parity: hidden → collapsed → expanded → hidden). */
export const DETAILS_MODES = ['hidden', 'collapsed', 'expanded'] as const

/** Gateway `complete.slash` suggests these supported per-section names after
 * `/details `; each can persist its own visibility mode or reset to inheritance. */
export const DETAILS_SECTIONS = ['thinking', 'tools', 'subagents', 'activity', 'delegation'] as const

export const DETAILS_USAGE = 'usage: /details [hidden|collapsed|expanded|cycle]'
export const DETAILS_SECTION_USAGE =
  'usage: /details <thinking|tools|subagents|activity|delegation> <hidden|collapsed|expanded|reset>'

const SECTION_DEFAULTS: DetailsSections = {
  activity: 'hidden',
  delegation: 'collapsed',
  thinking: 'expanded',
  tools: 'expanded'
}

export interface DetailsConfig {
  mode: DetailsMode
  sections: DetailsSections
}

const DetailsDisplayConfigSchema = Schema.Struct({
  details_mode: Schema.optionalKey(Schema.Unknown),
  focus_view: Schema.optionalKey(Schema.Unknown),
  tui_compact: Schema.optionalKey(Schema.Unknown),
  sections: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  thinking_mode: Schema.optionalKey(Schema.Unknown)
})
const DetailsRootConfigSchema = Schema.Struct({ display: Schema.optionalKey(DetailsDisplayConfigSchema) })
const decodeDetailsRootConfig = Schema.decodeUnknownOption(DetailsRootConfigSchema)

/** Decode Ink's persisted compact flag from `config.get full`. */
export function compactFromConfig(config: unknown): boolean {
  const decoded = decodeDetailsRootConfig(config)
  return Option.isSome(decoded) && Boolean(decoded.value.display?.tui_compact)
}

/** Decode the persisted focus-view flag (`display.focus_view`, /focus) from
 * `config.get full` — Ink applyDisplay's `!!d.focus_view` parity. */
export function focusViewFromConfig(config: unknown): boolean {
  const decoded = decodeDetailsRootConfig(config)
  return Option.isSome(decoded) && Boolean(decoded.value.display?.focus_view)
}

/** Decode the display subset of `config.get full`; invalid overrides are ignored. */
export function detailsFromConfig(config: unknown): DetailsConfig {
  const decoded = decodeDetailsRootConfig(config)
  const display = Option.isSome(decoded) ? decoded.value.display : undefined
  const thinkingRaw = display?.thinking_mode
  const thinking = typeof thinkingRaw === 'string' ? thinkingRaw.trim().toLowerCase() : ''
  const mode =
    parseDetailsMode(display?.details_mode) ??
    (thinking === 'full'
      ? 'expanded'
      : thinking === 'collapsed' || thinking === 'truncated'
        ? 'collapsed'
        : 'collapsed')
  const rawSections = display?.sections
  const sections: DetailsSections = {}
  if (rawSections && typeof rawSections === 'object' && !Array.isArray(rawSections)) {
    for (const section of DETAILS_SECTIONS) {
      const value = parseDetailsMode(rawSections[section])
      if (value) sections[section] = value
    }
  }
  return { mode, sections }
}

export function isDetailsSection(value: unknown): value is DetailsSection {
  return typeof value === 'string' && (DETAILS_SECTIONS as readonly string[]).includes(value)
}

export function sectionMode(
  name: DetailsSection,
  global: DetailsMode,
  sections: DetailsSections,
  commandOverride = false
): DetailsMode {
  return sections[name] ?? (commandOverride ? global : (SECTION_DEFAULTS[name] ?? global))
}

/** Parse a mode word; null for anything unrecognized (non-strings included). */
export function parseDetailsMode(v: unknown): DetailsMode | null {
  if (typeof v !== 'string') return null
  const norm = v.trim().toLowerCase()
  return DETAILS_MODES.find(m => m === norm) ?? null
}

/** The next mode in the cycle (`/details cycle`). */
export function nextDetailsMode(m: DetailsMode): DetailsMode {
  return DETAILS_MODES[(DETAILS_MODES.indexOf(m) + 1) % DETAILS_MODES.length] ?? 'collapsed'
}

/** One collapsed RUN of consecutive tool/reasoning parts (hidden mode). */
export interface HiddenRun {
  type: 'hiddenRun'
  /** Stable-ish key: the first hidden part's id. */
  id: string
  tools: number
  thoughts: number
}

/** What the transcript renders per part slot: a real part, or a hidden-run marker. */
export type DisplayPart = Part | HiddenRun

/**
 * Hidden mode: keep text parts, fold each consecutive run of tool/reasoning
 * parts into ONE HiddenRun marker (so a 5-tool fan-out reads as a single muted
 * line, not 5 of them). Pure — the source parts are untouched, so switching
 * the mode back restores everything.
 */
export function collapseHiddenParts(parts: readonly Part[]): DisplayPart[] {
  return collapseHiddenPartsBy(parts, () => true)
}

export function collapseHiddenPartsBy(
  parts: readonly Part[],
  hidden: (section: DetailsSection) => boolean
): DisplayPart[] {
  const out: DisplayPart[] = []
  let run: HiddenRun | undefined
  for (const part of parts) {
    // MoA reference parts NEVER fold: they are the mixture-of-agents process
    // the user explicitly opted into, not private model reasoning, so they
    // stay visible even when every section is hidden (upstream #64657 —
    // 07a732c2e5b's shouldShowThinkingTrail override, folded into the one
    // hidden-mode seam this engine has).
    const section = part.type === 'tool' ? 'tools' : part.type === 'reasoning' ? 'thinking' : null
    if (!section || !hidden(section)) {
      run = undefined
      out.push(part)
      continue
    }
    if (!run) {
      run = { id: `hidden-${part.id}`, thoughts: 0, tools: 0, type: 'hiddenRun' }
      out.push(run)
    }
    if (part.type === 'tool') run.tools += 1
    else run.thoughts += 1
  }
  return out
}

/** Muted one-liner for a hidden run: `2 tools · 1 thought hidden`. */
export function hiddenRunLabel(run: HiddenRun): string {
  const segs: string[] = []
  if (run.tools) segs.push(`${run.tools} tool${run.tools === 1 ? '' : 's'}`)
  if (run.thoughts) segs.push(`${run.thoughts} thought${run.thoughts === 1 ? '' : 's'}`)
  return `${segs.join(' · ')} hidden — /details collapsed to show`
}
