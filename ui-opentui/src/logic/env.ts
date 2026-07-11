/**
 * env — shared boolean env-flag parsing (one source for the TRUE/FALSE regexes).
 *
 * Recognized truthy values: 1/true/yes/on; falsy: 0/false/no/off (case-insensitive,
 * surrounding whitespace trimmed). Anything else (incl. unset) is "unrecognized".
 */
export const TRUE_RE = /^(?:1|true|yes|on)$/i
export const FALSE_RE = /^(?:0|false|no|off)$/i

/** Parse a boolean env var; returns `fallback` when unset/unrecognized. */
export function envFlag(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim() ?? ''
  if (TRUE_RE.test(v)) return true
  if (FALSE_RE.test(v)) return false
  return fallback
}

/**
 * Tri-state toggle parse: `true`/`false` for a recognized value, `null` when
 * unset/unrecognized (so a caller can fall through to the next precedence rung).
 * Mirrors Ink's `parseToggle` (`ui-tui/src/config/env.ts`).
 */
export function envToggle(value: string | undefined): boolean | null {
  const v = value?.trim() ?? ''
  if (TRUE_RE.test(v)) return true
  if (FALSE_RE.test(v)) return false
  return null
}

/**
 * Whether the TUI is embedded in the dashboard PTY.
 *
 * This is intentionally the same single internal hand-off as Ink. A locally
 * selected inline/main-screen mode is not hosted, and must not disable normal
 * exits or `/update`.
 */
export function dashboardTuiMode(env: { readonly [k: string]: string | undefined } = process.env): boolean {
  return envFlag(env.HERMES_TUI_DASHBOARD, false)
}

/**
 * Resolve whether mouse tracking is ON at boot, deferring to Ink's env surface
 * (`ui-tui/src/config/env.ts`) so muscle memory + docs + support scripts carry
 * over. Precedence (highest first):
 *   1. `HERMES_TUI_MOUSE_TRACKING` (toggle) — the explicit force knob; beats all.
 *   2. `HERMES_TUI_DISABLE_MOUSE=1` — the legacy Ink kill switch (off).
 *   3. `HERMES_TUI_MOUSE` (toggle) — the OpenTUI-native alias (kept, rule 2);
 *      it's also what the launcher sets, so it stays a first-class boot knob.
 *   4. default ON (opencode parity: wheel-scroll, drag-scrollbar, click-to-expand,
 *      text-aware selection).
 * OpenTUI's renderer mouse is a single boolean, so Ink's granular off|wheel|
 * buttons|all collapses to on/off here (any non-off tracking mode → on).
 */
export function resolveMouseEnabled(env: { readonly [k: string]: string | undefined } = process.env): boolean {
  const trackingOverride = envToggle(env.HERMES_TUI_MOUSE_TRACKING)
  if (trackingOverride !== null) return trackingOverride
  if (envFlag(env.HERMES_TUI_DISABLE_MOUSE, false)) return false
  const mouseAlias = envToggle(env.HERMES_TUI_MOUSE)
  if (mouseAlias !== null) return mouseAlias
  return true
}

/**
 * The seeded initial prompt for `hermes --tui "prompt"` / `--image`.
 *
 * The launcher (`hermes_cli/main.py`) sets `HERMES_TUI_QUERY` (the established
 * cross-engine contract Ink reads via `STARTUP_QUERY`); the OpenTUI engine also
 * accepts `HERMES_TUI_PROMPT` as its own alias and a bare argv tail for
 * standalone dev launches. QUERY wins (it's the launcher contract); PROMPT and
 * argv are fallbacks. Empty → undefined.
 */
export function startupPrompt(
  env: { readonly [k: string]: string | undefined } = process.env,
  argv: readonly string[] = process.argv.slice(2)
): string | undefined {
  const query = env.HERMES_TUI_QUERY?.trim()
  if (query) return query
  const prompt = env.HERMES_TUI_PROMPT?.trim()
  if (prompt) return prompt
  const tail = argv.join(' ').trim()
  return tail || undefined
}

/**
 * The seeded image PATH for `hermes --tui --image <path>`. The launcher sets
 * `HERMES_TUI_IMAGE` (Ink reads it as `STARTUP_IMAGE` and `image.attach`es the
 * path before submitting the query). Empty → undefined.
 */
export function startupImage(env: { readonly [k: string]: string | undefined } = process.env): string | undefined {
  const image = env.HERMES_TUI_IMAGE?.trim()
  return image || undefined
}

/** Ink's default prompt when an image is seeded with no query (`STARTUP_QUERY`). */
export const STARTUP_IMAGE_DEFAULT_PROMPT = 'What do you see in this image?'

/**
 * `HERMES_TUI_NO_CONFIRM` — skip destructive-action confirm prompts (Ink parity,
 * `ui-tui/src/config/env.ts` `NO_CONFIRM_DESTRUCTIVE`). When truthy, the `/clear`
 * and `/new` confirm step is bypassed and the action runs immediately. Default
 * off (confirm). Same name, same truthy parsing as Ink.
 */
export function noConfirmDestructive(env: { readonly [k: string]: string | undefined } = process.env): boolean {
  return envFlag(env.HERMES_TUI_NO_CONFIRM, false)
}

/**
 * `HERMES_HEAPDUMP_ON_START` — write a manual heap snapshot at boot (Ink parity).
 * A diagnostic escape hatch that BYPASSES the diagnostics master switch (you set
 * it deliberately to capture a baseline). Default off.
 */
export function heapdumpOnStart(env: { readonly [k: string]: string | undefined } = process.env): boolean {
  return envFlag(env.HERMES_HEAPDUMP_ON_START, false)
}

/**
 * `HERMES_TUI_SCROLL_SPEED` (or `CLAUDE_CODE_SCROLL_SPEED` for portability) —
 * the wheel-scroll speed multiplier (Ink parity, `lib/wheelAccel.ts`
 * `readScrollSpeedBase`). Default 1 (the engine's native scroll behavior is
 * untouched), clamped to (0, 20]. Returns `null` when UNSET/garbage so the
 * caller leaves OpenTUI's native scroll acceleration alone — only an explicit,
 * in-range value installs a constant-multiplier override.
 */
export function scrollSpeedMultiplier(env: { readonly [k: string]: string | undefined } = process.env): number | null {
  const raw = (env.HERMES_TUI_SCROLL_SPEED ?? env.CLAUDE_CODE_SCROLL_SPEED ?? '').trim()
  if (!raw) return null
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(n, 20)
}

/**
 * The diagnostics master switch — `HERMES_TUI_DIAGNOSTICS` (default OFF).
 *
 * Gates the developer/profiling surface a regular user should never trip
 * over: the diagnostic slash commands (`/mem`, `/heapdump`) and the default
 * for `HERMES_TUI_WINDOW_STATS` (which can still be set individually). It is
 * an enable switch, not a secret: anyone CAN set it (support flows say
 * "relaunch with HERMES_TUI_DIAGNOSTICS=1"), it just keeps the day-to-day
 * surface clean. Read per call so tests (and long-lived processes whose
 * wrapper mutates env before launch) see the live value.
 */
export function diagnosticsEnabled(): boolean {
  return envFlag(process.env.HERMES_TUI_DIAGNOSTICS, false)
}

/**
 * Whether rich tool-call OUTPUTS are kept — `HERMES_TUI_TOOL_OUTPUTS` (default
 * ON). OpenTUI's rich tool cards (full result body + raw result/args dicts) are
 * its differentiator vs Ink, so they stay on for real users. Setting `=off`
 * drops both the RENDER and the STORE of those bodies (exact Ink parity: Ink
 * keeps only a short context line and discards the result/args dicts), which is
 * the biggest memory lever — used by the bench (D8: a fair Ink-vs-OpenTUI
 * engine-overhead comparison) and the low-mem mode. The redaction-safe
 * `argsPreview` one-liner, name/duration/error, and file-edit diffs are KEPT
 * either way (a diff is a high-value surface, not generic "output"). Read per
 * call so a wrapper that mutates env before launch sees the live value.
 */
export function toolOutputsEnabled(): boolean {
  return envFlag(process.env.HERMES_TUI_TOOL_OUTPUTS, true)
}

/**
 * Parse `HERMES_TUI_TOOL_OUTPUT_LINES` (a TUI-only env var — deliberately NOT
 * a config.yaml knob): how many output lines an expanded tool body shows.
 * UNSET → Infinity (UNLIMITED — expanded tool output is uncapped by default;
 * setting the var is how you RESTORE a cap, e.g. `=200`). A positive integer
 * → that cap. `0` → Infinity too (back-compat: it was the old opt-in
 * "unlimited" value). Garbage → Infinity (unrecognized ≙ no cap asked for —
 * the semantic is "cap only when the user asked for one").
 */
export function envOutputLines(value: string | undefined): number {
  const v = value?.trim() ?? ''
  if (!/^\d+$/.test(v)) return Number.POSITIVE_INFINITY
  const n = Number.parseInt(v, 10)
  return n === 0 ? Number.POSITIVE_INFINITY : n
}

/**
 * Default visible-height cap for the composer textarea, in rows (Ink composer
 * parity — 8 lines, ref feature request #10418). Beyond this the textarea
 * scrolls INTERNALLY (the native edit buffer keeps the cursor in view).
 */
export const COMPOSER_MAX_ROWS = 8

/**
 * Parse `HERMES_TUI_COMPOSER_ROWS` (a TUI-only env var — deliberately NOT a
 * config.yaml knob): the composer's visible-height cap before internal scroll
 * kicks in. A positive integer → that cap; unset / `0` / garbage → the
 * COMPOSER_MAX_ROWS default.
 */
export function envComposerRows(value: string | undefined): number {
  const v = value?.trim() ?? ''
  if (!/^\d+$/.test(v)) return COMPOSER_MAX_ROWS
  const n = Number.parseInt(v, 10)
  return n > 0 ? n : COMPOSER_MAX_ROWS
}

/**
 * Whether NO line cap applies (unset / `0` / unparseable). When unlimited,
 * the store prefers the always-full raw `result` over a gateway tail-capped
 * `result_text` — an "unlimited" view of a tail would still be missing its
 * head — see store.ts tool.complete. With an explicit finite cap the gateway
 * tail (+ honest omitted note) is kept: the user asked for a bounded view.
 */
export function envOutputUnlimited(value: string | undefined): boolean {
  return envOutputLines(value) === Number.POSITIVE_INFINITY
}

/**
 * The session's launch directory for `session.create`'s `cwd` param.
 *
 * The hermes launcher runs the OpenTUI engine with its process cwd set to the
 * engine's own package dir, so `process.cwd()` is NOT where the user ran
 * hermes. The launcher exports the real launch dir as `HERMES_CWD` (and the
 * gateway's `TERMINAL_CWD`); prefer those. Falls back to `process.cwd()` only
 * for standalone launches (smokes/dev) where no launcher set them, and returns
 * `undefined` when even that is empty so the gateway resolves its own default.
 */
export function launchCwd(env: { readonly [k: string]: string | undefined } = process.env): string | undefined {
  // First NON-BLANK of the launcher's vars (?? would keep a blank HERMES_CWD
  // and never reach TERMINAL_CWD).
  for (const value of [env.HERMES_CWD, env.TERMINAL_CWD]) {
    const trimmed = (value ?? '').trim()
    if (trimmed) return trimmed
  }
  try {
    const cwd = process.cwd().trim()
    return cwd || undefined
  } catch {
    return undefined
  }
}
