/**
 * Pure text-shaping helpers for compact tool-result rendering (spec v4 §7 / §8).
 * No OpenTUI/Solid imports — just string work, trivially unit-testable. Ported
 * 1:1 from the React build's `engine/toolOutput.ts` (itself mirroring opencode's
 * `util/collapse-tool-output.ts` + the gateway tool-result JSON-envelope unwrap).
 */

/** Result of collapsing tool output for the block render. */
export interface Collapsed {
  lines: string[]
  /** How many trailing lines were dropped (0 when nothing was hidden). */
  hiddenLines: number
  truncated: boolean
}

// CSI escape sequences (SGR colors, cursor, mouse). The gateway colors some
// slash/notice text with raw ANSI for the Ink TUI, which interprets it; the
// native `<text>` renders byte-for-byte, so those codes would leak as literal
// glyphs. Strip them on display (item 8).
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /[\u001b\u009b]\[[0-9;:?<>=]*[ -/]*[@-~]/g
/** Remove ANSI/SGR/mouse escape sequences so they don't render as literal text. */
export function stripAnsi(s: string): string {
  return (s ?? '').replace(ANSI_CSI, '')
}

/** Truncate a single line to `width` columns, adding an ellipsis when cut. */
export function truncate(s: string, width: number): string {
  const w = Math.max(1, width)
  return s.length > w ? s.slice(0, Math.max(1, w - 1)) + '…' : s
}

/**
 * Un-double-escape gateway output that arrived with LITERAL `\n`/`\t` escapes
 * (some tool tails are repr'd, so newlines show as backslash-n — item 7 "ugly").
 * Conservative: only un-escapes when literal `\n` sequences OUTNUMBER real
 * newlines, so genuinely multi-line output (and code that legitimately contains
 * the two chars `\` + `n`) is left untouched.
 */
export function normalizeOutput(text: string): string {
  const real = (text.match(/\n/g) ?? []).length
  const literal = (text.match(/\\n/g) ?? []).length
  if (literal > real)
    return text
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '  ')
  return text
}

/**
 * Unwrap the gateway's tool-result JSON envelope so the view shows the actual
 * output, not the wrapper. Many tools return
 * `{"output": "...", "exit_code": 0, "error": null}`. If `raw` parses to such an
 * object, return its `output` (plus a compact error/exit suffix when the command
 * failed); otherwise return `raw` unchanged. (Gotcha §8 — strip the envelope.)
 */
/**
 * When the gateway tail-caps a LARGE result it serialises the whole envelope
 * first, so the surviving tail ends mid-string with the envelope close — and,
 * if the head survived, opens with the envelope's prefix up to `"output": "`.
 * The fragment can't be JSON.parsed, so peel those affixes off conservatively
 * (only the exact gateway shapes; real output won't end this way). Two shapes
 * observed live (v6fix wire capture):
 *   terminal/process: `{"output": "…", "exit_code": 0, "error": null}`
 *   execute_code:     `{"status": "success", "output": "…",
 *                       "tool_calls_made": 0, "duration_seconds": 0.21[, "error": "…"]}`
 * The tail anchors on the first trailing key (`exit_code`/`tool_calls_made`)
 * then allows the remaining envelope keys in any order. Items 2 + 6.
 */
const ENVELOPE_HEAD = /^\s*\{\s*(?:"status"\s*:\s*"[^"]*"\s*,\s*)?"output"\s*:\s*"/
const ENVELOPE_TAIL =
  /"\s*,\s*"(?:exit_code|tool_calls_made)"\s*:\s*-?\d+(?:\s*,\s*"(?:error|status|duration_seconds|exit_code|tool_calls_made)"\s*:\s*(?:null|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"))*\s*\}\s*$/

function unwrapEnvelopeFragment(s: string): string {
  const tail = ENVELOPE_TAIL.test(s)
  const head = ENVELOPE_HEAD.test(s)
  if (!tail && !head) return s
  return s.replace(ENVELOPE_HEAD, '').replace(ENVELOPE_TAIL, '')
}

export function stripToolEnvelope(raw: string): string {
  const s = (raw ?? '').trim()
  if (!s.startsWith('{')) return normalizeOutput(unwrapEnvelopeFragment(raw ?? ''))

  try {
    const parsed: unknown = JSON.parse(s)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'output' in parsed) {
      const obj = parsed as Record<string, unknown>
      let out = typeof obj.output === 'string' ? obj.output : JSON.stringify(obj.output, null, 2)
      const err = obj.error
      const code = obj.exit_code
      if (typeof err === 'string' && err) out += `\n[error] ${err}`
      else if (typeof code === 'number' && code !== 0) out += `\n[exit ${code}]`
      out = normalizeOutput(out)
      if (obj.status === 'yielded_to_background') {
        // This records a handoff, not the process's current state (also used on resume).
        const session = typeof obj.session_id === 'string' && obj.session_id.trim() ? ` · ${obj.session_id}` : ''
        const pid =
          typeof obj.pid === 'number' && Number.isSafeInteger(obj.pid) && obj.pid > 0 ? ` · PID ${obj.pid}` : ''
        out += `${out && !out.endsWith('\n') ? '\n' : ''}[moved to background${session}${pid}]`
      }
      return out
    }
  } catch {
    // not parseable as a whole — maybe a tail-capped envelope fragment
  }
  return normalizeOutput(unwrapEnvelopeFragment(raw ?? ''))
}

/**
 * The gateway caps verbose tool output to a tail and PREFIXES a literal label
 * (`tui_gateway/server.py:_cap_tui_verbose_text`):
 *   `[showing verbose tail; omitted 5 lines / 234 chars]\n<tail>`
 *   `[showing verbose tail; omitted 512 chars]\n<tail>`
 * The raw label is neither useful nor pretty (item 2). Strip it off and hand the
 * view a tidy `omittedNote` ("5 lines / 234 chars") to render as a dim affordance.
 */
export function stripOmittedNote(text: string): { body: string; omittedNote?: string } {
  const s = (text ?? '').replace(/^\s+/, '')
  const match = s.match(/^\[showing verbose tail; omitted (.+?)\]\n/)
  if (!match) return { body: text ?? '' }
  return { body: s.slice(match[0].length), omittedNote: match[1] ?? '' }
}

/**
 * Width cap for a collapsed tool header's ARGS preview (design pass): args are
 * context, not content — they get at most ~half the pane, so a long command or
 * path can never become the loudest mass on screen. Shared by the header
 * truncation (toolPart) and the bash body's "did the header already show the
 * whole command" echo check (bashTool) so the two stay mirrored.
 */
export function argsCapColumns(totalWidth: number): number {
  return Math.max(8, Math.floor(totalWidth / 2))
}

/**
 * Collapse text to at most `maxLines` lines, each capped to `width` columns. The
 * view renders an overflow marker from `hiddenLines`; this stays pure (no marker).
 */
export function collapseToolOutput(text: string, maxLines: number, width: number): Collapsed {
  const all = (text ?? '').replace(/\s+$/, '').split('\n')
  const limit = Math.max(1, maxLines)
  const lines = all.slice(0, limit).map(l => truncate(l, width))
  const hiddenLines = Math.max(0, all.length - lines.length)
  return { hiddenLines, lines, truncated: hiddenLines > 0 }
}
