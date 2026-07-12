import { renderMermaidASCII } from 'beautiful-mermaid'
import stringWidth from 'string-width'

export const MERMAID_SOURCE_LIMIT = 64 * 1024
export const MERMAID_LINE_LIMIT = 400
export const MERMAID_OUTPUT_LIMIT = 256 * 1024
export const MERMAID_WIDTH_LIMIT = 1_000
export const MERMAID_HEIGHT_LIMIT = 400

const CACHE_LIMIT = 64
const MERMAID_STATEMENT_LIMIT = 24
const MERMAID_STRUCTURE_MARKER_LIMIT = 20

export interface MermaidDiagram {
  readonly kind: 'diagram'
  readonly text: string
  readonly width: number
  readonly height: number
  readonly scrollable: boolean
}

export interface MermaidFallback {
  readonly kind: 'fallback'
  readonly reason: 'invalid' | 'too-large' | 'too-wide'
}

export type MermaidRenderResult = MermaidDiagram | MermaidFallback

function stripControls(value: string): string {
  return [...value]
    .filter(char => {
      const code = char.codePointAt(0) ?? 0
      return char === '\n' || (code > 31 && code !== 127 && !(code >= 128 && code <= 159))
    })
    .join('')
}

function diagramWidth(value: string): number {
  return value.split('\n').reduce((width, line) => Math.max(width, stringWidth(line)), 0)
}

/** Accept Mermaid's common compact form without rewriting arrows inside labels. */
function normalizeMermaidSource(source: string): string {
  const sanitized = stripControls(source).replaceAll('\r\n', '\n').trim()
  const compact = sanitized.replace(/^(\s*(?:graph|flowchart)\s+(?:TD|TB|LR|BT|RL))\s*;\s*/i, '$1\n')
  return compact
    .split('\n')
    .map(line => {
      let quote = ''
      let depth = 0
      let result = ''
      for (let index = 0; index < line.length; index++) {
        const char = line[index] ?? ''
        if ((char === '"' || char === "'") && !quote) quote = char
        else if (char === quote) quote = ''
        if (!quote) {
          if ('[({'.includes(char)) depth++
          else if (']})'.includes(char)) depth = Math.max(0, depth - 1)
        }
        if (!quote && depth === 0) {
          // beautiful-mermaid 1.1.x silently misparses the common compact
          // flowchart form `A-->B`. Keep this deliberately narrow: ER
          // relationships such as `||--o{` are semantically different tokens.
          const operator = line.slice(index).startsWith('-->') ? '-->' : undefined
          if (operator) {
            result = result.trimEnd() + ` ${operator} `
            index += operator.length - 1
            while (line[index + 1] === ' ') index++
            continue
          }
        }
        result += char
      }
      return result.trimEnd()
    })
    .join('\n')
}

interface CachedVariant {
  readonly height: number
  readonly text: string
  readonly width: number
}

const variantCache = new Map<string, CachedVariant | null>()

function cacheSet(key: string, value: CachedVariant | null): void {
  variantCache.delete(key)
  variantCache.set(key, value)
  if (variantCache.size > CACHE_LIMIT) {
    const oldest = variantCache.keys().next().value
    if (oldest !== undefined) variantCache.delete(oldest)
  }
}

function variantFor(normalized: string, paddingX: number): CachedVariant | null {
  const key = `${paddingX}\u0000${normalized}`
  const cached = variantCache.get(key)
  if (cached !== undefined || variantCache.has(key)) {
    variantCache.delete(key)
    variantCache.set(key, cached ?? null)
    return cached ?? null
  }
  try {
    const text = stripControls(
      renderMermaidASCII(normalized, {
        boxBorderPadding: 1,
        colorMode: 'none',
        paddingX,
        paddingY: 2,
        useAscii: false
      })
    )
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      .trimEnd()
    const height = text ? text.split('\n').length : 0
    const width = diagramWidth(text)
    if (!text || text.length > MERMAID_OUTPUT_LIMIT || width > MERMAID_WIDTH_LIMIT || height > MERMAID_HEIGHT_LIMIT) {
      cacheSet(key, null)
      return null
    }
    const variant = { height, text, width }
    cacheSet(key, variant)
    return variant
  } catch {
    cacheSet(key, null)
    return null
  }
}

/**
 * ELK layout cost grows superlinearly. Byte/line caps alone are insufficient:
 * a 581-byte, 50-edge chain takes ~19s in beautiful-mermaid 1.1.3. Reject
 * complex-but-small inputs before synchronous layout; ordinary source remains
 * visible through the Markdown fallback.
 */
function withinComplexityBudget(source: string): boolean {
  const statements = source
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('%%'))
  if (statements.length > MERMAID_STATEMENT_LIMIT) return false
  let markers = 0
  for (const line of statements) {
    let quote = ''
    let depth = 0
    for (let index = 0; index < line.length; index++) {
      const char = line[index] ?? ''
      if ((char === '"' || char === "'") && !quote) quote = char
      else if (char === quote) quote = ''
      if (!quote) {
        if ('[({'.includes(char)) depth++
        else if (']})'.includes(char)) depth = Math.max(0, depth - 1)
      }
      if (!quote && depth === 0) {
        const rest = line.slice(index)
        const marker = ['->>', '--', '==', '-.'].find(candidate => rest.startsWith(candidate))
        if (marker) {
          markers++
          index += marker.length - 1
        }
      }
    }
  }
  return markers <= MERMAID_STRUCTURE_MARKER_LIMIT
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
 * Render a completed Mermaid source to terminal-native Unicode. The caller falls
 * back to OpenTUI's ordinary fenced-code renderer for every non-diagram result.
 */
export function renderMermaidTerminal(source: string, availableWidth: number): MermaidRenderResult {
  const raw = source.replaceAll('\r\n', '\n').trim()
  if (!raw) return { kind: 'fallback', reason: 'invalid' }
  if (raw.length > MERMAID_SOURCE_LIMIT || raw.split('\n').length > MERMAID_LINE_LIMIT) {
    return { kind: 'fallback', reason: 'too-large' }
  }
  const normalized = normalizeMermaidSource(source)
  if (!withinComplexityBudget(normalized)) return { kind: 'fallback', reason: 'too-large' }
  const widthLimit = Math.max(20, Math.floor(availableWidth))
  const paddingX = widthLimit >= 100 ? 5 : widthLimit >= 60 ? 3 : 1
  const selected = variantFor(normalized, paddingX)
  if (!selected) return { kind: 'fallback', reason: 'invalid' }
  return { kind: 'diagram', ...selected, scrollable: selected.width > widthLimit }
}
