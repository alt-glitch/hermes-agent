/**
 * Slash-token matching for the composer (Epic 6) — pure tokenizer + matcher,
 * no deps, fully table-testable. The composer uses this to:
 *
 *   1. HIGHLIGHT a `/name` token whose name exactly matches a valid
 *      command/skill name (native textarea highlight ranges),
 *   2. SUGGEST an autocorrect when the message IS a bare `/name` token at the
 *      very start and the name is exactly one edit away (Damerau-Levenshtein /
 *      OSA distance 1) from exactly ONE valid name — surfaced through the
 *      existing completion dropdown, never auto-applied.
 *
 * Anti-jank rule (the whole point): a `/` in the middle of prose must NOT
 * trigger completion or autocorrect. Mid-prose tokens get highlight-only when
 * they exactly match a valid name; otherwise nothing happens. Path-looking
 * tokens (`a/b`, `/usr/bin`, `./x`) are never tokens at all.
 *
 * The catalog of valid names is supplied by the caller (the composer LEARNS it
 * from the slash-completion batches the gateway already sends — the completion
 * flow is the source of truth; nothing is hardcoded here).
 */

/** A standalone `/name` token found in the composer text. */
export interface SlashToken {
  /** The name WITHOUT the leading `/`. */
  name: string
  /** Char offset of the leading `/` in the text. */
  start: number
  /** Char offset one past the last name char. */
  end: number
  /** Whether the token sits at the very start of the message (offset 0). */
  lead: boolean
}

/** An autocorrect suggestion for the lead token (`/comit` → `commit`). */
export interface SlashSuggestion {
  /** The corrected name (no slash). */
  name: string
  /** Char offset the accepted suggestion replaces from (just past the `/`). */
  from: number
}

export interface SlashAnalysis {
  /** Tokens whose name EXACTLY matches a valid name — highlight these. */
  highlights: SlashToken[]
  /** The one-edit autocorrect for a bare lead token; null when none applies. */
  suggestion: SlashSuggestion | null
}

/** Command/skill name charset: starts alphanumeric, then word chars / `.` / `-`.
 *  Notably EXCLUDES `/` — `/usr/bin` is a path, never a command token. */
const NAME_RE = /^[A-Za-z0-9][\w.-]*$/

const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'

/**
 * Extract every standalone `/name` token. Boundary rules:
 *   - the `/` must be at the start of the text or preceded by whitespace
 *     (`a/b` and `path/to` are not tokens),
 *   - the name runs to the next whitespace (or end) and must match NAME_RE
 *     (`/usr/bin` has a `/` in the body → not a token; bare `/` is nothing).
 */
export function slashTokens(text: string): SlashToken[] {
  const tokens: SlashToken[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '/') continue
    if (i > 0 && !isSpace(text[i - 1])) continue
    let j = i + 1
    while (j < text.length && !isSpace(text[j])) j++
    const name = text.slice(i + 1, j)
    if (NAME_RE.test(name)) tokens.push({ end: j, lead: i === 0, name, start: i })
    i = j
  }
  return tokens
}

/**
 * Whether `a` and `b` are EXACTLY one edit apart under Damerau-Levenshtein
 * (OSA): one substitution, one insertion/deletion, or one adjacent
 * transposition. Equal strings are zero edits → false.
 */
export function isOneEdit(a: string, b: string): boolean {
  if (a === b) return false
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    // one substitution, or one adjacent transposition
    let i = 0
    while (i < la && a[i] === b[i]) i++
    if (i === la) return false // identical (handled above, defensive)
    // try substitution: rest after i must match
    if (a.slice(i + 1) === b.slice(i + 1)) return true
    // try transposition of i,i+1
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)
  }
  // one insertion/deletion: align the longer against the shorter
  const [short, long] = la < lb ? [a, b] : [b, a]
  let i = 0
  while (i < short.length && short[i] === long[i]) i++
  return short.slice(i) === long.slice(i + 1)
}

/**
 * Analyze the composer text against the valid-name catalog.
 * Matching is CASE-SENSITIVE per the catalog (commands are stored lowercase;
 * `/Help` is not exact — though it IS one edit from `help`, so it suggests).
 *
 * Suggestion rules (anti-jank):
 *   - only for the LEAD token, and only while the message is EXACTLY the bare
 *     token (`/comit` — not `/comit args`, never mid-prose),
 *   - the token must not already be exact,
 *   - exactly ONE catalog name within one edit; ambiguity → nothing.
 */
export function analyzeSlash(text: string, names: ReadonlySet<string>): SlashAnalysis {
  const tokens = slashTokens(text)
  const highlights = tokens.filter(t => names.has(t.name))
  let suggestion: SlashSuggestion | null = null
  const lead = tokens[0]
  if (lead && lead.lead && text === `/${lead.name}` && !names.has(lead.name)) {
    let candidate: string | undefined
    let count = 0
    for (const n of names) {
      if (isOneEdit(lead.name, n)) {
        candidate = n
        if (++count > 1) break
      }
    }
    if (count === 1 && candidate !== undefined) suggestion = { from: 1, name: candidate }
  }
  return { highlights, suggestion }
}

/**
 * Names learnable from a slash-completion batch. Only when the composer text is
 * a bare lead token (`/…` with no space) are the candidates command/skill NAMES
 * — after a space the gateway completes ARGS (`/details thinking`), which must
 * not pollute the catalog. Item text arrives as `name `, `name`, or `/name`
 * (the gateway's extras carry the slash); all normalize to the bare name.
 */
export function learnableNames(text: string, items: ReadonlyArray<{ text: string }>): string[] {
  if (!/^\/\S*$/.test(text)) return []
  const out: string[] = []
  for (const item of items) {
    let name = item.text.trim()
    if (name.startsWith('/')) name = name.slice(1)
    if (NAME_RE.test(name)) out.push(name)
  }
  return out
}

/**
 * Convert a JS string offset into the native highlight char offset: the native
 * char-range counter skips newlines (mirror of ExtmarksController.
 * offsetExcludingNewlines in @opentui/core for plain-width text).
 */
export function nativeCharOffset(text: string, offset: number): number {
  let newlines = 0
  const max = Math.min(offset, text.length)
  for (let i = 0; i < max; i++) if (text[i] === '\n') newlines++
  return offset - newlines
}
