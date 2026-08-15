import { describe, expect, it } from 'vitest'

import { MERMAID_SOURCE_LIMIT, mermaidFenceIsClosed, renderMermaidTerminal } from '../logic/mermaid.ts'

function diagram(source: string, width = 200) {
  const result = renderMermaidTerminal(source, width)
  expect(result.kind).toBe('diagram')
  if (result.kind !== 'diagram') throw new Error(`expected diagram, got ${result.reason}`)
  return result
}

describe('Mermaid fence completion', () => {
  it('requires a matching CommonMark closing fence', () => {
    expect(mermaidFenceIsClosed('```mermaid\ngraph LR\nA --> B\n```')).toBe(true)
    expect(mermaidFenceIsClosed('~~~~mermaid\ngraph LR\nA --> B\n~~~~~\n')).toBe(true)
    expect(mermaidFenceIsClosed('```mermaid\ngraph LR\nA --> B')).toBe(false)
    expect(mermaidFenceIsClosed('````mermaid\ngraph LR\nA --> B\n```')).toBe(false)
    expect(mermaidFenceIsClosed('```mermaid\ngraph LR\nA --> B\n~~~')).toBe(false)
  })
})

describe('terminal Mermaid rendering', () => {
  it('renders normal, compact-header, and unspaced flowcharts', () => {
    expect(diagram('graph LR\nA --> B').plain).toContain('A')
    expect(diagram('graph LR; A --> B').plain).toContain('B')
    const compact = diagram('flowchart LR\nA-->B')
    expect(compact.plain).toContain('A')
    expect(compact.plain).toContain('B')
  })

  it.each([
    ['sequence', 'sequenceDiagram\nAlice->>Bob: Hello'],
    ['state', 'stateDiagram-v2\n[*] --> Ready\nReady --> [*]'],
    ['class', 'classDiagram\nclass Animal\nAnimal : +name'],
    ['ER', 'erDiagram\nCUSTOMER ||--o{ ORDER : places'],
    ['subgraph', 'graph TD\nsubgraph Group\nA --> B\nend']
  ])('renders a %s diagram', (_name, source) => {
    expect(diagram(source).plain.length).toBeGreaterThan(5)
  })

  it('preserves arrow text inside a node label while rendering edge arrows', () => {
    expect(diagram('graph LR\nA["literal A-->B"]-->C').plain).toContain('literal A-->B')
  })

  it('classifies rows into semantic spans the view can theme', () => {
    const classes = new Set(
      diagram('graph LR\nA --> B')
        .rows.flat()
        .map(span => span.cls)
    )
    expect(classes.has('border')).toBe(true)
    expect(classes.has('edge')).toBe(true)
  })

  it('emits no control characters or trailing spaces, and reports cell width', () => {
    const result = diagram('graph LR\nA["界🙂\u001b[31m"] --> B')
    const containsControl = [...result.plain].some(char => {
      const code = char.codePointAt(0) ?? 0
      return (code < 32 && char !== '\n') || code === 127 || (code >= 128 && code <= 159)
    })
    expect(containsControl).toBe(false)
    expect(result.plain.split('\n').every(line => line === line.trimEnd())).toBe(true)
    expect(result.width).toBeGreaterThanOrEqual(4)
    expect(result.height).toBe(result.plain.split('\n').length)
  })

  it('keeps a valid wide graph as a horizontally scrollable diagram', () => {
    const result = diagram('graph LR\nA --> B --> C --> D --> E --> F --> G', 24)
    expect(result.scrollable).toBe(true)
    expect(result.width).toBeGreaterThan(24)
  })

  it('does not mark a fitting diagram scrollable', () => {
    expect(diagram('graph LR\nA --> B', 200).scrollable).toBe(false)
  })

  it('falls back for empty, invalid, undrawn-kind, and oversize input', () => {
    expect(renderMermaidTerminal('', 80)).toEqual({ kind: 'fallback', reason: 'invalid' })
    expect(renderMermaidTerminal('not-a-diagram', 80).kind).toBe('fallback')
    // grok-mermaid does not draw xychart/pie/gantt — ordinary fenced-code fallback.
    expect(renderMermaidTerminal('xychart-beta\nx-axis [a, b]\ny-axis 0 --> 10\nbar [3, 7]', 80)).toEqual({
      kind: 'fallback',
      reason: 'invalid'
    })
    expect(renderMermaidTerminal(`graph LR\nA["${'x'.repeat(MERMAID_SOURCE_LIMIT)}"]`, 80)).toEqual({
      kind: 'fallback',
      reason: 'too-large'
    })
  })

  it('renders a 50-edge chain quickly (the old ELK renderer needed a complexity budget)', () => {
    const source = 'graph LR\n' + Array.from({ length: 50 }, (_, index) => `N${index} --> N${index + 1}`).join('\n')
    const started = performance.now()
    const result = renderMermaidTerminal(source, 120)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result.kind).toBe('diagram')
  })

  it('surfaces advisory warnings without withholding the art', () => {
    const result = diagram('graph LR\nA --> B\ntotal garbage line here\nC --> D')
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.plain).toContain('A')
  })

  it('is deterministic across repeated renders', () => {
    const source = 'graph TD\nStart --> Finish'
    expect(renderMermaidTerminal(source, 80)).toEqual(renderMermaidTerminal(source, 80))
  })
})
