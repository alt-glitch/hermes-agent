/**
 * preprocessMath — the fence-aware LaTeX→Unicode span converter that runs on the
 * raw markdown BEFORE it reaches the native `<markdown>` renderable.
 *
 * Span detection ports the Ink tokenizer's exact rules (ui-tui markdown.tsx):
 *   • inline `$…$`  — INLINE_RE group 17: `(?<!\$)\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\$)`
 *     (content starts/ends non-space-non-$, no `$`/newline inside → currency-safe)
 *   • inline `\(…\)` — INLINE_RE group 18 (single line, lazy)
 *   • display `$$…$$` / `\[…\]` — opener only at line start (MATH_BLOCK_OPEN_RE),
 *     same-line close or scan-ahead; NO closer → line passes through verbatim
 *     (which is exactly what makes mid-stream unclosed math safe).
 *
 * Fence/inline-code state is tracked by hand because the markdown parser hasn't
 * run yet: ``` / ~~~ fences (any info string, closer same char + >= length) and
 * per-line backtick code spans (run of N backticks closed by exactly N).
 */
import { describe, expect, it } from 'vitest'

import { preprocessMath } from '../logic/mathPreprocess.ts'
import { BOX_CLOSE, BOX_OPEN } from '../logic/mathUnicode.ts'

const hasSentinels = (s: string) => s.includes(BOX_OPEN) || s.includes(BOX_CLOSE)

describe('preprocessMath — early exit', () => {
  it('returns the SAME string reference when no math trigger chars exist', () => {
    const s = 'plain prose with **bold** and a [link](https://x.dev), no math at all'
    expect(preprocessMath(s)).toBe(s)
  })

  it('returns the same reference when $ exists but nothing converts (pure currency)', () => {
    const s = 'I paid $5 and $10'
    expect(preprocessMath(s)).toBe(s)
  })

  it('handles the empty string', () => {
    expect(preprocessMath('')).toBe('')
  })
})

describe('preprocessMath — inline $…$', () => {
  it('converts a simple inline span', () => {
    expect(preprocessMath('Einstein: $E=mc^2$ wow')).toBe('Einstein: E=mc² wow')
  })

  it('converts Greek and blackboard inside inline math', () => {
    expect(preprocessMath('so $\\pi \\in \\mathbb{R}$ holds')).toBe('so π ∈ ℝ holds')
  })

  it('converts multiple spans on one line', () => {
    expect(preprocessMath('$\\alpha$ then $\\beta$')).toBe('α then β')
  })

  it('keeps unknown commands verbatim inside the span (delimiters still removed)', () => {
    expect(preprocessMath('see $\\circledast$ here')).toBe('see \\circledast here')
  })
})

describe('preprocessMath — currency anti-jank (Ink rule parity)', () => {
  it('does not mathify "$5 and $10" (closing $ preceded by space)', () => {
    expect(preprocessMath('it costs $5 and $10 today')).toBe('it costs $5 and $10 today')
  })

  it('does not mathify a lone unclosed dollar amount', () => {
    expect(preprocessMath('paid $5.')).toBe('paid $5.')
  })

  it('does not mathify when content starts with a space', () => {
    expect(preprocessMath('weird $ x$ thing')).toBe('weird $ x$ thing')
  })

  it('does not treat $$ as two inline delimiters', () => {
    expect(preprocessMath('a $$ b')).toBe('a $$ b')
  })
})

describe('preprocessMath — inline \\(…\\)', () => {
  it('converts paren-delimited inline math', () => {
    expect(preprocessMath('foo \\(x + y\\) bar')).toBe('foo x + y bar')
    expect(preprocessMath('\\(\\pi\\)')).toBe('π')
  })

  it('leaves an unclosed \\( verbatim', () => {
    expect(preprocessMath('foo \\(x + y bar')).toBe('foo \\(x + y bar')
  })
})

describe('preprocessMath — display math', () => {
  it('converts a single-line $$…$$ to its own plain paragraph text', () => {
    expect(preprocessMath('$$E = mc^2$$')).toBe('E = mc²')
  })

  it('converts a multi-line $$ block, blank-line separated from prose', () => {
    const input = 'Quadratic:\n$$\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n$$\nDone.'
    expect(preprocessMath(input)).toBe('Quadratic:\n\nx = (-b ± √{b² - 4ac})/2a\n\nDone.')
  })

  it('does not double blank lines when the block is already separated', () => {
    const input = 'Prose.\n\n$$\n\\sum_{n=0}^{\\infty} \\frac{1}{n!}\n$$\n\nMore.'
    expect(preprocessMath(input)).toBe('Prose.\n\n∑ₙ₌₀^∞ 1/n!\n\nMore.')
  })

  it('converts \\[ … \\] single-line and multi-line', () => {
    expect(preprocessMath('\\[ \\alpha + \\beta \\]')).toBe('α + β')
    expect(preprocessMath('\\[\n\\frac{a}{b}\n\\]')).toBe('a/b')
  })

  it('keeps content on the opener/closer lines (`$$x +` … `y$$`)', () => {
    expect(preprocessMath('$$x^2 +\ny^2$$')).toBe('x² +\ny²')
  })

  it('leaves `$$x$$ trailing prose` verbatim (opener must close on its own line)', () => {
    const s = '$$x+y$$ followed by more'
    expect(preprocessMath(s)).toBe(s)
  })

  it('leaves an unclosed $$ block verbatim (no partial conversion)', () => {
    const s = 'Before\n$$\nE = mc^2'
    expect(preprocessMath(s)).toBe(s)
  })

  it('many unmatched openers of one delimiter stay verbatim while the other delimiter still closes', () => {
    // The closer scan for `$$` is remembered as exhausted after the first
    // miss (no later `$$` opener can find one); `\[` keeps its own state.
    const unmatched = Array.from({ length: 40 }, (_, n) => `$$ x_${n}`).join('\n')
    expect(preprocessMath(unmatched)).toBe(unmatched)
    const mixed = `${unmatched}\n\\[\n\\alpha\n\\]\nAfter`
    expect(preprocessMath(mixed)).toBe(`${unmatched}\n\nα\n\nAfter`)
  })

  it('an unmatched opener does not hide a later same-delimiter block that does close', () => {
    // A miss is only remembered when the scan reached EOF; here the first
    // opener's scan finds the `$$` closer on line 2 and consumes that block,
    // and the final lone `$$` (no closer) stays verbatim.
    expect(preprocessMath('$$ a\n$$\nx^2\n$$\nTail')).toBe(' a\n\nx^2\n$$\nTail')
  })
})

describe('preprocessMath — \\boxed sentinels are stripped to plain text', () => {
  it('strips the U+0001/U+0002 sentinels, keeping the inner text', () => {
    const out = preprocessMath('$$\\boxed{x = 0}$$')
    expect(out).toBe('x = 0')
    expect(hasSentinels(out)).toBe(false)
  })

  it('strips sentinels in inline spans too', () => {
    expect(preprocessMath('answer $\\boxed{42}$ found')).toBe('answer 42 found')
  })
})

describe('preprocessMath — fence passthrough', () => {
  it('leaves $ spans inside ``` fences untouched (any info string)', () => {
    const s =
      'Look:\n\n```python title=x.py\nprice = "$5 and $10"\nmath = "$E=mc^2$"\n$$\nnot math\n$$\n```\n\nBut $\\pi$ converts.'
    expect(preprocessMath(s)).toBe(
      'Look:\n\n```python title=x.py\nprice = "$5 and $10"\nmath = "$E=mc^2$"\n$$\nnot math\n$$\n```\n\nBut π converts.'
    )
  })

  it('respects ~~~ fences and longer-run closers', () => {
    const s = '~~~\n$E=mc^2$\n~~~~\nafter $\\pi$'
    expect(preprocessMath(s)).toBe('~~~\n$E=mc^2$\n~~~~\nafter π')
  })

  it('a shorter or different-char run does NOT close the fence', () => {
    const s = '````\n```\n$E=mc^2$\n~~~\n````\n$\\pi$'
    expect(preprocessMath(s)).toBe('````\n```\n$E=mc^2$\n~~~\n````\nπ')
  })

  it('an unclosed fence protects everything after it (streaming code block)', () => {
    const s = '```sh\necho "$HOME and $PATH$"\nstill inside $x$'
    expect(preprocessMath(s)).toBe(s)
  })
})

describe('preprocessMath — inline code passthrough', () => {
  it('leaves `$x$` in single-backtick code untouched, converts math outside', () => {
    expect(preprocessMath('use `$x$` to write $\\pi$')).toBe('use `$x$` to write π')
  })

  it('handles double-backtick spans containing a backtick (exact-N closer)', () => {
    expect(preprocessMath('``code $a$ with ` tick`` then $\\pi$')).toBe('``code $a$ with ` tick`` then π')
  })

  it('an unmatched backtick run is literal; math after it still converts', () => {
    expect(preprocessMath('`unclosed and $\\pi$')).toBe('`unclosed and π')
  })

  it('display opener inside inline code is not display math', () => {
    const s = 'the `$$` delimiter is TeX'
    expect(preprocessMath(s)).toBe(s)
  })
})

describe('preprocessMath — streaming safety (growing prefixes)', () => {
  const doc = 'Euler: $e^{i\\pi}$ neat.\n\n$$\n\\sum_{n=0}^{\\infty} \\frac{1}{n!}\n$$\n\nDone $5 cheap.'
  const final = 'Euler: e^(iπ) neat.\n\n∑ₙ₌₀^∞ 1/n!\n\nDone $5 cheap.'

  it('every prefix produces sane output: no sentinels, no partial conversion of an open span', () => {
    for (let n = 1; n <= doc.length; n++) {
      const out = preprocessMath(doc.slice(0, n), { streaming: true })
      expect(hasSentinels(out)).toBe(false)
      // an inline span still open (single `$` so far) must stay verbatim
      if (n >= 8 && n < 'Euler: $e^{i\\pi}$'.length) {
        expect(out).toBe(doc.slice(0, n))
      }
    }
  })

  it('the inline span converts exactly once its closer arrives', () => {
    const upto = 'Euler: $e^{i\\pi}$'.length
    expect(preprocessMath(doc.slice(0, upto), { streaming: true })).toBe('Euler: e^(iπ)')
  })

  it('an open $$ block stays verbatim until the closing line arrives', () => {
    const open = 'Euler: $e^{i\\pi}$ neat.\n\n$$\n\\sum_{n=0}^{\\infty} \\frac{1}{n!}'
    expect(preprocessMath(open, { streaming: true })).toBe(
      'Euler: e^(iπ) neat.\n\n$$\n\\sum_{n=0}^{\\infty} \\frac{1}{n!}'
    )
    const closed = open + '\n$$'
    expect(preprocessMath(closed, { streaming: true })).toBe('Euler: e^(iπ) neat.\n\n∑ₙ₌₀^∞ 1/n!')
  })

  it('the full document converts and is stable across the streaming flag', () => {
    expect(preprocessMath(doc, { streaming: true })).toBe(final)
    expect(preprocessMath(doc)).toBe(final)
  })
})

describe('preprocessMath — mixed document', () => {
  it('prose + fence + inline code + currency + inline and display math', () => {
    const input = [
      '# Math $\\Sigma$ report',
      '',
      'Costs $5 and $10, but $\\alpha + \\beta$ converts and \\(x^2\\) too.',
      '',
      '```tex',
      'keep $\\alpha$ raw $$',
      '```',
      '',
      '$$',
      '\\boxed{\\frac{n+1}{2}}',
      '$$',
      '',
      'End `$ literal` here.'
    ].join('\n')
    const expected = [
      '# Math Σ report',
      '',
      'Costs $5 and $10, but α + β converts and x² too.',
      '',
      '```tex',
      'keep $\\alpha$ raw $$',
      '```',
      '',
      '(n+1)/2',
      '',
      'End `$ literal` here.'
    ].join('\n')
    expect(preprocessMath(input)).toBe(expected)
  })
})
