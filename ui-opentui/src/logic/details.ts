/**
 * Global detail-mode logic (/details — Epic 3 utility-command port; mirrors Ink
 * `domain/details.ts`, GLOBAL mode only — per-section overrides are explicitly
 * deferred). The mode drives how the transcript treats tool + reasoning rows:
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
import type { Part } from './store.ts'

export type DetailsMode = 'hidden' | 'collapsed' | 'expanded'

/** Cycle order (Ink parity: hidden → collapsed → expanded → hidden). */
export const DETAILS_MODES = ['hidden', 'collapsed', 'expanded'] as const

/** Gateway `complete.slash` suggests these per-section names after `/details ` —
 *  recognized so picking one yields an honest "not supported yet" notice instead
 *  of the generic usage line (per-section overrides are deferred). */
export const DETAILS_SECTIONS = ['thinking', 'tools', 'subagents', 'activity'] as const

export const DETAILS_USAGE = 'usage: /details [hidden|collapsed|expanded|cycle]'

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
  const out: DisplayPart[] = []
  let run: HiddenRun | undefined
  for (const part of parts) {
    // text AND moaReference are PRIMARY content (the latter is the mixture-of-agents
    // process the user opted into) — never fold them into the hidden run.
    if (part.type === 'text' || part.type === 'moaReference') {
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
