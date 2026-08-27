/**
 * Bounded reasoning summary — the OpenTUI port of the Ink tail-bound fix
 * (upstream 64882bc6: ui-tui/src/lib/text.ts `THINKING_CLEAN_TAIL_BOUND =
 * LIVE_RENDER_MAX_CHARS * 1.5`). Reasoning grows on every streamed token, and
 * the view's per-delta pipeline (this summary's replace/trim/slice, Markdown's
 * `preprocessMath`, the native `<markdown>` content) is full-string work — O(n)
 * per token, O(n^2) over a long stream — while only the newest tail is ever on
 * screen. Bounding the input here keeps per-delta render work constant WITHOUT
 * touching the store: `message.parts[]` still holds the full reasoning text
 * (copy/resume read the store, not this view helper).
 *
 * The leading `**Title**` line lives at the HEAD of the string, so on the
 * truncated path it is captured from a small head slice before the body is
 * tail-sliced — a naive tail slice would drop the title.
 *
 * Pure string work, no OpenTUI/Solid imports (the logic/ idiom).
 */

/** Mirror of Ink's bound: LIVE_RENDER_MAX_CHARS (16_000) * 1.5. */
export const REASONING_TAIL_BOUND = 24_000

export interface ReasoningSummary {
  title?: string
  body: string
}

/** `**Title**` on the leading line, blank-line- or end-of-text-terminated
 *  (opencode reasoningSummary). */
const TITLE_RE = /^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/
/** Truncated path: the text continues past the head slice, so the
 *  end-of-string alternative can only be a slice artifact — require the real
 *  blank line. */
const TITLE_HEAD_RE = /^\*\*([^*\n]+)\*\*\r?\n\r?\n/
/** Head window scanned for a title on the truncated path — a title is a single
 *  short line; anything longer wouldn't fit a header row anyway. */
const TITLE_SCAN = 1_024

/**
 * Split a leading `**Title**\n\n body` into `{title, body}`, bounding the body
 * to the newest `bound` chars when the accumulated text has outgrown it.
 */
export function reasoningSummary(text: string, bound: number = REASONING_TAIL_BOUND): ReasoningSummary {
  const raw = text ?? ''
  if (raw.length <= bound) {
    const s = raw.replace('[REDACTED]', '').trim()
    const m = s.match(TITLE_RE)
    const title = m?.[1]?.trim()
    if (!m || !title) return { body: s }
    return { body: s.slice(m[0].length).trimStart(), title }
  }
  // Over the bound: O(bound) head + tail slices only — never the full string.
  const head = raw.slice(0, TITLE_SCAN).replace('[REDACTED]', '').trimStart()
  const title = head.match(TITLE_HEAD_RE)?.[1]?.trim()
  const body = raw.slice(-bound).replace('[REDACTED]', '').trim()
  return title ? { body, title } : { body }
}
