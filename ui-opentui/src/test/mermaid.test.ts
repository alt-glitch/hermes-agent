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
    expect(diagram('graph LR\nA --> B').text).toContain('A')
    expect(diagram('graph LR; A --> B').text).toContain('B')
    const compact = diagram('flowchart LR\nA-->B')
    expect(compact.text).toContain('A')
    expect(compact.text).toContain('B')
  })

  it.each([
    ['sequence', 'sequenceDiagram\nAlice->>Bob: Hello'],
    ['state', 'stateDiagram-v2\n[*] --> Ready\nReady --> [*]'],
    ['class', 'classDiagram\nclass Animal\nAnimal : +name'],
    ['ER', 'erDiagram\nCUSTOMER ||--o{ ORDER : places'],
    ['XY', 'xychart-beta\nx-axis [a, b]\ny-axis 0 --> 10\nbar [3, 7]']
  ])('renders a %s diagram', (_name, source) => {
    expect(diagram(source).text.length).toBeGreaterThan(5)
  })

  it('preserves arrow text inside a node label while normalizing edge arrows', () => {
    expect(diagram('graph LR\nA["literal A-->B"]-->C').text).toContain('literal A-->B')
  })

  it('uses terminal cell width and emits no control characters or trailing spaces', () => {
    const result = diagram('graph LR\nA["界🙂\u001b[31m"] --> B')
    const containsControl = [...result.text].some(char => {
      const code = char.codePointAt(0) ?? 0
      return (code < 32 && char !== '\n') || code === 127 || (code >= 128 && code <= 159)
    })
    expect(containsControl).toBe(false)
    expect(result.text.split('\n').every(line => line === line.trimEnd())).toBe(true)
    expect(result.width).toBeGreaterThanOrEqual(4)
  })

  it('keeps a valid wide graph as a horizontally scrollable diagram', () => {
    const result = diagram('graph LR\nA --> B --> C --> D --> E --> F --> G', 24)
    expect(result.scrollable).toBe(true)
    expect(result.width).toBeGreaterThan(24)
  })

  it('chooses a non-scrolling spacing tier when the viewport is wide enough', () => {
    expect(diagram('graph LR\nA --> B', 200).scrollable).toBe(false)
  })

  it('falls back for empty, invalid, and over-budget input', () => {
    expect(renderMermaidTerminal('', 80)).toEqual({ kind: 'fallback', reason: 'invalid' })
    expect(renderMermaidTerminal('not-a-diagram', 80).kind).toBe('fallback')
    expect(renderMermaidTerminal(`graph LR\nA["${'x'.repeat(MERMAID_SOURCE_LIMIT)}"]`, 80)).toEqual({
      kind: 'fallback',
      reason: 'too-large'
    })
  })

  it('rejects a complex-but-small graph before synchronous ELK layout', () => {
    const source = 'graph LR\n' + Array.from({ length: 50 }, (_, index) => `N${index} --> N${index + 1}`).join('\n')
    const started = performance.now()
    expect(renderMermaidTerminal(source, 120)).toEqual({ kind: 'fallback', reason: 'too-large' })
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('does not charge ignored comments or label text against structural complexity', () => {
    const noise = '>'.repeat(50) + '--'.repeat(50)
    expect(diagram(`graph LR\nA["literal ${noise}"] --> B\n%% ${noise}`).text).toContain('literal')
  })

  it('is deterministic across cached renders without exposing mutable output', () => {
    const source = 'graph TD\nStart --> Finish'
    expect(renderMermaidTerminal(source, 80)).toEqual(renderMermaidTerminal(source, 80))
  })
})
