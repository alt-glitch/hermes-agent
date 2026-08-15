import { render, type Span } from 'grok-mermaid'

export const MERMAID_SOURCE_LIMIT = 64 * 1024
export const MERMAID_LINE_LIMIT = 400
export const MERMAID_WIDTH_LIMIT = 1_000
export const MERMAID_HEIGHT_LIMIT = 400

export interface MermaidDiagram {
  readonly kind: 'diagram'
  /** Rows of semantic spans — the view maps `Span.cls` onto theme colors. */
  readonly rows: ReadonlyArray<ReadonlyArray<Span>>
  /** Right-trimmed monochrome text (copy/paste, width-free assertions). */
  readonly plain: string
  readonly width: number
  readonly height: number
  /** Advisory parse warnings (flowcharts drop unreadable lines, render the rest). */
  readonly warnings: readonly string[]
  readonly scrollable: boolean
}

export interface MermaidFallback {
  readonly kind: 'fallback'
  readonly reason: 'invalid' | 'too-large'
}

export type MermaidRenderResult = MermaidDiagram | MermaidFallback

/** grok-mermaid strips ESC itself; this belt-and-suspenders pass removes the
 *  remaining C0/DEL/C1 range so control bytes can never reach a renderable. */
function stripControls(value: string): string {
  return [...value]
    .filter(char => {
      const code = char.codePointAt(0) ?? 0
      return char === '\n' || (code > 31 && code !== 127 && !(code >= 128 && code <= 159))
    })
    .join('')
}

/** A completed CommonMark fence ends with the same marker and at least the opener length. */
export function mermaidFenceIsClosed(raw: string): boolean {
  const lines = raw.replaceAll('\r\n', '\n').split('\n')
  const opener = lines[0]?.match(/^ {0,3}(`{3,}|~{3,})/)
  if (!opener?.[1]) return false
  const marker = opener[1][0]
  const minimum = opener[1].length
  for (let index = lines.length - 1; index > 0; index--) {
    const line = lines[index]?.trimEnd() ?? ''
    const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
    const closingRun = closing?.[1]
    if (closingRun && closingRun[0] === marker && closingRun.length >= minimum) return true
    if (line.trim()) return false
  }
  return false
}

/**
 * Render a completed Mermaid source to terminal-native Unicode via grok-mermaid
 * (layout is milliseconds even for pathological inputs — no complexity budget
 * needed, unlike the previous ELK-based renderer). `render()` returns `null`
 * for blank input, syntax errors, undrawn diagram kinds (pie/gantt/xychart/…)
 * and layouts it refuses as too large — all of which fall back to the ordinary
 * fenced-code renderer at the caller.
 */
export function renderMermaidTerminal(source: string, availableWidth: number): MermaidRenderResult {
  const raw = stripControls(source).replaceAll('\r\n', '\n').trim()
  if (!raw) return { kind: 'fallback', reason: 'invalid' }
  if (raw.length > MERMAID_SOURCE_LIMIT || raw.split('\n').length > MERMAID_LINE_LIMIT) {
    return { kind: 'fallback', reason: 'too-large' }
  }
  const art = render(raw)
  if (!art) return { kind: 'fallback', reason: 'invalid' }
  const height = art.styled.length
  if (art.width > MERMAID_WIDTH_LIMIT || height > MERMAID_HEIGHT_LIMIT) {
    return { kind: 'fallback', reason: 'too-large' }
  }
  return {
    kind: 'diagram',
    rows: art.styled,
    plain: art.plain.join('\n'),
    width: art.width,
    height,
    warnings: art.warnings,
    scrollable: art.width > Math.max(20, Math.floor(availableWidth))
  }
}
