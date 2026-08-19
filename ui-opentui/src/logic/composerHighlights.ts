/**
 * Reference spans shared by the native composer and sent-message transcript:
 * slash commands/skills, `@` references, and attachment/paste tokens. Styling
 * is render-only; concatenating the returned segments always reproduces the
 * source text exactly.
 */
export interface ComposerHighlight {
  ref: boolean
  text: string
}

export interface ComposerHighlightSpan {
  end: number
  start: number
}

// Leading or mid-prose. Keep paths (`/usr/local`) and arithmetic (`/4`) plain.
// A bare slash counts only at the end, while the command menu is opening.
const slashRe = () => /(?<=^|\s)(?:\/[a-zA-Z][\w-]*(?![\w-]*\/)|\/$)/g

// Typed and half-typed refs, including quoted values containing spaces.
const atRe = () => /(?<=^|\s)@(?:[\w-]+:(?:`[^`\n]*`?|"[^"\n]*"?|'[^'\n]*'?|\S*)|\S*)/g

// Ink's `[[ ... ]]` tokens plus OpenTUI's retained-paste and image idioms.
const tokenRe = () => /\[\[[^\n]*?\]\]|\[Pasted text #\d+(?: \+\d+ lines)?\]|\[Image #\d+\]/g

const matchSpans = (text: string, re: RegExp): ComposerHighlightSpan[] =>
  [...text.matchAll(re)].filter(m => m[0]).map(m => ({ end: m.index + m[0].length, start: m.index }))

export function composerHighlightSpans(text: string): ComposerHighlightSpan[] {
  // Tokens, then @refs, then slashes. Stable sorting preserves that priority
  // when two candidates start together; overlap filtering keeps one owner.
  return [...matchSpans(text, tokenRe()), ...matchSpans(text, atRe()), ...matchSpans(text, slashRe())]
    .sort((a, b) => a.start - b.start)
    .reduce<ComposerHighlightSpan[]>((kept, span) => {
      if (!kept.some(prev => span.start < prev.end && span.end > prev.start)) kept.push(span)
      return kept
    }, [])
}

export function splitComposerHighlights(text: string): ComposerHighlight[] {
  const out: ComposerHighlight[] = []
  let last = 0

  for (const span of composerHighlightSpans(text)) {
    if (span.start > last) out.push({ ref: false, text: text.slice(last, span.start) })
    out.push({ ref: true, text: text.slice(span.start, span.end) })
    last = span.end
  }

  if (last < text.length || !out.length) out.push({ ref: false, text: text.slice(last) })
  return out
}
