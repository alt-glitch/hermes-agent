/**
 * Fence-aware LaTeX→Unicode span converter. Runs on the raw markdown string
 * BEFORE it reaches the native `<markdown>` renderable (the one seam in
 * view/markdown.tsx), so the native parser only ever sees already-converted
 * unicode text. Tier-A: text-only — no styled spans, no accent color on math
 * (that needs renderNode hooks into MarkdownRenderable; deferred).
 *
 * Span detection ports the Ink tokenizer's EXACT rules (ui-tui/src/components/
 * markdown.tsx — keep in sync):
 *
 *   • inline `$…$` — INLINE_RE group 17:
 *       (?<!\$)\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\$)
 *     content starts AND ends with a non-space-non-`$`, contains no `$` or
 *     newline. This is the currency guard: in `I paid $5 and $10` the closing
 *     `$` is preceded by a space, so nothing matches and the prose survives.
 *   • inline `\(…\)` — INLINE_RE group 18: `\\\(([^\n]+?)\\\)` (single line).
 *   • display `$$…$$` / `\[…\]` — MATH_BLOCK_OPEN_RE: opener only at the start
 *     of a (whitespace-trimmed) line; closes on the same line (`$$x$$`) or on a
 *     later line ENDING with the closer. No closer anywhere → the line passes
 *     through verbatim (Ink renders it as a plain paragraph). That rule is what
 *     makes streaming safe for free: an unclosed `$$`/`$` mid-stream stays
 *     verbatim and converts exactly once, when the closing delimiter arrives
 *     (the whole text re-feeds per delta).
 *
 * Because the markdown parser hasn't run yet, fence / inline-code state is
 * tracked here:
 *   • fenced blocks: ``` or ~~~ runs (3+, any info string) open; a line that is
 *     only a run of the SAME character, at least as long, closes (CommonMark).
 *     Everything inside, including the fence lines, passes through untouched.
 *   • inline code: per-line backtick scan — a run of N backticks opens a span
 *     closed by the next run of EXACTLY N backticks on the same line
 *     (CommonMark rule); unmatched runs are literal text. Multi-line inline
 *     code spans are NOT supported (the Ink tokenizer was per-line too).
 *
 * Known, documented deviations from full markdown awareness (both rare, both
 * shared with or narrower than the Ink renderer's behavior):
 *   • a paired `$…$` inside a link destination (`[x](http://a$b$c)`) converts;
 *     Ink's tokenizer matched the link first.
 *   • 4-space-indented code blocks are not tracked (fences only).
 *
 * `\boxed{…}` sentinels (U+0001/U+0002 from texToUnicode) are STRIPPED to the
 * inner text — injecting a styled span into the native renderable needs
 * renderer hooks; deferred with the rest of tier-B.
 *
 * Perf: this runs over the FULL text on every streaming delta. Early-exit
 * fast path returns the same string reference when no `$` / `\(` / `\[`
 * appears at all, and when a scan converts nothing the original reference is
 * returned too (so the renderable's content prop stays identity-stable).
 */
import { BOX_RE, texToUnicode } from './mathUnicode.ts'

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/

// Display math openers/closers — ported verbatim from Ink's markdown.tsx.
const MATH_BLOCK_OPEN_RE = /^\s*(\$\$|\\\[)(.*)$/
const MATH_BLOCK_CLOSE_DOLLAR_RE = /^(.*?)\$\$\s*$/
const MATH_BLOCK_CLOSE_BRACKET_RE = /^(.*?)\\\]\s*$/

// Ink INLINE_RE group 17 / 18, anchored (sticky). The `(?<!\$)` lookbehind is
// checked by the caller (prev char), everything else is byte-for-byte Ink's.
const INLINE_DOLLAR_RE = /\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\$)/y
const INLINE_PAREN_RE = /\\\(([^\n]+?)\\\)/y

/** texToUnicode + strip the \boxed highlight sentinels down to plain text. */
const toUnicode = (tex: string): string => texToUnicode(tex).replace(BOX_RE, '$1')

/** Index of the next run of EXACTLY `len` backticks at/after `from`, or -1. */
const findBacktickClose = (line: string, from: number, len: number): number => {
  let i = from
  while (i < line.length) {
    if (line[i] !== '`') {
      i++
      continue
    }

    let j = i + 1

    while (j < line.length && line[j] === '`') j++

    if (j - i === len) {
      return i
    }

    i = j
  }

  return -1
}

// Convert inline `$…$` / `\(…\)` spans in one prose line, skipping inline
// code spans. Returns the SAME string reference when nothing converted.
const convertInline = (line: string): string => {
  let out = ''
  let i = 0
  let changed = false

  while (i < line.length) {
    const ch = line[i]

    if (ch === '`') {
      let j = i + 1

      while (j < line.length && line[j] === '`') j++

      const close = findBacktickClose(line, j, j - i)

      if (close >= 0) {
        out += line.slice(i, close + (j - i))
        i = close + (j - i)
      } else {
        out += line.slice(i, j)
        i = j
      }

      continue
    }

    if (ch === '$' && line[i - 1] !== '$') {
      INLINE_DOLLAR_RE.lastIndex = i
      const m = INLINE_DOLLAR_RE.exec(line)

      if (m) {
        out += toUnicode(m[1] ?? '')
        i = INLINE_DOLLAR_RE.lastIndex
        changed = true

        continue
      }
    }

    if (ch === '\\' && line[i + 1] === '(') {
      INLINE_PAREN_RE.lastIndex = i
      const m = INLINE_PAREN_RE.exec(line)

      if (m) {
        out += toUnicode(m[1] ?? '')
        i = INLINE_PAREN_RE.lastIndex
        changed = true

        continue
      }
    }

    out += ch
    i++
  }

  return changed ? out : line
}

export function preprocessMath(markdown: string, _opts?: { streaming?: boolean | undefined }): string {
  // Fast path — REQUIRED, this runs on every streaming delta. No math trigger
  // characters anywhere → hand back the exact same string (identity).
  if (!markdown.includes('$') && !markdown.includes('\\(') && !markdown.includes('\\[')) {
    return markdown
  }

  const lines = markdown.split('\n')
  const out: string[] = []
  let changed = false
  let fence: { char: string; len: number } | null = null
  const noCloserAhead = { dollar: false, bracket: false }
  let i = 0

  // Emit a converted display block as its own paragraph: blank-line separated
  // from surrounding prose (only where a separator is actually missing).
  const pushDisplay = (block: string[], nextIdx: number) => {
    if (out.length > 0 && out[out.length - 1]?.trim()) {
      out.push('')
    }

    out.push(...block)

    if (nextIdx < lines.length && lines[nextIdx]?.trim()) {
      out.push('')
    }

    changed = true
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (fence) {
      out.push(line)
      const close = line.match(FENCE_CLOSE_RE)?.[1]

      if (close && close.charAt(0) === fence.char && close.length >= fence.len) {
        fence = null
      }

      i++

      continue
    }

    const open = line.match(FENCE_OPEN_RE)?.[1]

    if (open) {
      fence = { char: open.charAt(0), len: open.length }
      out.push(line)
      i++

      continue
    }

    const mathOpen = line.match(MATH_BLOCK_OPEN_RE)

    if (mathOpen) {
      const closeRe = mathOpen[1] === '$$' ? MATH_BLOCK_CLOSE_DOLLAR_RE : MATH_BLOCK_CLOSE_BRACKET_RE
      const headRest = mathOpen[2] ?? ''

      // Single-line block: `$$x + y = z$$` or `\[x\]`.
      const sameLineClose = headRest.match(closeRe)

      if (sameLineClose) {
        const inner = (sameLineClose[1] ?? '').trim()
        pushDisplay(inner ? [toUnicode(inner)] : [], i + 1)
        i++

        continue
      }

      // Multi-line block: scan ahead for a real closer before committing. If
      // none exists in the rest of the (possibly still-streaming) document,
      // the line stays verbatim — Ink's paragraph fallback.
      //
      // A scan that reached EOF without a closer proves that no later opener
      // of the same delimiter can find one either (its scan range is a strict
      // subset), so remember that and skip the rescan: without it a document
      // of unmatched openers costs O(lines²) on every streaming delta.
      let closeIdx = -1
      let closeTail = ''

      if (!noCloserAhead[mathOpen[1] === '$$' ? 'dollar' : 'bracket']) {
        for (let j = i + 1; j < lines.length; j++) {
          const m = (lines[j] ?? '').match(closeRe)

          if (m) {
            closeIdx = j
            closeTail = m[1] ?? ''

            break
          }
        }

        if (closeIdx < 0) {
          noCloserAhead[mathOpen[1] === '$$' ? 'dollar' : 'bracket'] = true
        }
      }

      if (closeIdx >= 0) {
        const block: string[] = []

        if (headRest.trim()) {
          block.push(headRest)
        }

        for (let j = i + 1; j < closeIdx; j++) {
          block.push(lines[j] ?? '')
        }

        const tail = closeTail.trimEnd()

        if (tail.trim()) {
          block.push(tail)
        }

        pushDisplay(
          block.map(l => toUnicode(l)),
          closeIdx + 1
        )
        i = closeIdx + 1

        continue
      }
    }

    const converted = convertInline(line)

    if (converted !== line) {
      changed = true
    }

    out.push(converted)
    i++
  }

  return changed ? out.join('\n') : markdown
}
