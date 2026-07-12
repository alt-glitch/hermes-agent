import { CodeRenderable, ScrollBoxRenderable, TextRenderable, type Renderable } from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { describe, expect, it } from 'vitest'

import { Markdown } from '../view/markdown.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

function walk(node: Renderable, visit: (node: Renderable) => void): void {
  visit(node)
  for (const child of node.getChildren()) walk(child, visit)
}

async function mount(text: string, width: number, streaming = false, parentWidth?: number) {
  let root: Renderable | undefined
  function Grab() {
    root = useRenderer().root
    return null
  }
  const probe = await renderProbe(
    () => (
      <ThemeProvider>
        <Grab />
        <box style={{ width: parentWidth ?? '100%' }}>
          <Markdown text={text} streaming={streaming} />
        </box>
      </ThemeProvider>
    ),
    { height: 24, width }
  )
  await probe.settle()
  const collect = () => {
    const nodes: Renderable[] = []
    if (root) walk(root, node => nodes.push(node))
    return nodes
  }
  return { collect, nodes: collect(), probe }
}

describe('inline Mermaid Markdown renderable', () => {
  it('renders a completed fitting fence as selectable native Unicode text', async () => {
    const mounted = await mount('Before\n\n```mermaid\ngraph LR\nA --> B\n```\n\nAfter', 100)
    try {
      expect(mounted.probe.frame()).toMatch(/[┌┐└┘]/u)
      expect(mounted.nodes.some(node => node instanceof ScrollBoxRenderable)).toBe(true)
      const diagram = mounted.nodes.find(node => node instanceof TextRenderable && node.plainText.includes('►')) as
        | TextRenderable
        | undefined
      expect(diagram?.selectable).toBe(true)
    } finally {
      mounted.probe.destroy()
    }
  })

  it('puts a wide diagram in a local horizontal ScrollBox with native overflow state', async () => {
    const source = '```mermaid\ngraph LR\nA --> B --> C --> D --> E --> F --> G\n```'
    const mounted = await mount(source, 34)
    try {
      const scroll = mounted.nodes.find(node => node instanceof ScrollBoxRenderable) as ScrollBoxRenderable | undefined
      expect(scroll).toBeDefined()
      expect(scroll!.scrollWidth).toBeGreaterThan(scroll!.viewport.width)
      expect(scroll!.horizontalScrollBar.visible).toBe(true)
      expect(scroll!.verticalScrollBar.visible).toBe(false)
      expect(scroll!.focusable).toBe(false)
      scroll!.scrollTo({ x: scroll!.scrollWidth, y: 0 })
      expect(scroll!.scrollLeft).toBeGreaterThan(0)
    } finally {
      mounted.probe.destroy()
    }
  })

  it('leaves incomplete streaming and invalid Mermaid fences as source code', async () => {
    const incomplete = await mount('```mermaid\ngraph LR\nA --> B', 80, true)
    const invalid = await mount('```mermaid\nnot-a-diagram\n```', 80)
    try {
      const incompleteCode = incomplete.nodes.find(
        node => node instanceof CodeRenderable && node.filetype === 'mermaid'
      ) as CodeRenderable
      const invalidCode = invalid.nodes.find(
        node => node instanceof CodeRenderable && node.filetype === 'mermaid'
      ) as CodeRenderable
      expect(incompleteCode).toBeDefined()
      expect(invalidCode).toBeDefined()
      expect(incompleteCode.plainText).toContain('graph LR')
      expect(invalidCode.plainText).toContain('not-a-diagram')
    } finally {
      incomplete.probe.destroy()
      invalid.probe.destroy()
    }
  })

  it('reconciles a fitting diagram into horizontal overflow after a narrow resize', async () => {
    const source = '```mermaid\ngraph LR\nA --> B --> C --> D --> E --> F --> G\n```'
    const mounted = await mount(source, 120)
    try {
      const wide = mounted.collect().find(node => node instanceof ScrollBoxRenderable) as ScrollBoxRenderable
      expect(wide.horizontalScrollBar.visible).toBe(false)
      mounted.probe.resize(32, 24)
      for (let pass = 0; pass < 4; pass++) await mounted.probe.settle()
      const scroll = mounted.collect().find(node => node instanceof ScrollBoxRenderable) as
        | ScrollBoxRenderable
        | undefined
      expect(scroll).toBeDefined()
      expect(scroll!.scrollWidth).toBeGreaterThan(scroll!.viewport.width)
      expect(scroll!.scrollLeft).toBe(0)
    } finally {
      mounted.probe.destroy()
    }
  })

  it('uses the actual constrained parent for overflow, not global terminal width', async () => {
    const source = '```mermaid\ngraph LR\nA --> B --> C --> D --> E\n```'
    const mounted = await mount(source, 100, false, 30)
    try {
      const scroll = mounted.collect().find(node => node instanceof ScrollBoxRenderable) as
        | ScrollBoxRenderable
        | undefined
      expect(scroll).toBeDefined()
      expect(scroll!.viewport.width).toBeLessThanOrEqual(30)
      expect(scroll!.scrollWidth).toBeGreaterThan(scroll!.viewport.width)
      expect(scroll!.horizontalScrollBar.visible).toBe(true)
    } finally {
      mounted.probe.destroy()
    }
  })
})
