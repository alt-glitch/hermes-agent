/**
 * Widget runtime behavior — hooks, effects, timer cleanup, crash isolation.
 * Pure logic tests (no renderer): the instance resolves h() trees into RNode
 * descriptors and re-renders on hook updates.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

import { DARK_THEME } from '../logic/theme.ts'
import { Box, h, Text } from '../widgets/element.ts'
import { useEffect, useState, WidgetInstance, type RBox, type RNode, type RText } from '../widgets/runtime.ts'
import type { WidgetApp, WidgetRenderCtx } from '../widgets/types.ts'

const ctx = (state: unknown = {}): WidgetRenderCtx<unknown> => ({ cols: 80, rows: 24, state, t: DARK_THEME })

const app = (render: (c: WidgetRenderCtx<never>) => unknown): WidgetApp<never> =>
  ({
    help: 'test',
    id: 'test',
    init: () => ({}),
    mode: 'ambient',
    reduce: (s: never) => s,
    render
  }) as unknown as WidgetApp<never>

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function textOf(node: RNode): string {
  if (node.kind === 'text') return node.spans.map(s => s.text).join('')
  if (node.kind === 'box') return node.children.map(textOf).join('\n')
  return `⚠ ${node.message}`
}

let disposeQueue: WidgetInstance[] = []
afterEach(() => {
  for (const instance of disposeQueue) instance.dispose()
  disposeQueue = []
  vi.useRealTimers()
})

const make = (a: WidgetApp<never>): WidgetInstance => {
  const instance = new WidgetInstance(a)
  disposeQueue.push(instance)
  return instance
}

describe('widget runtime', () => {
  test('resolves a box/text tree with styled spans', () => {
    const instance = make(
      app(() =>
        h(
          Box,
          { flexDirection: 'column', paddingX: 2 },
          h(Text, { bold: true, color: '#DAA520' }, 'label'),
          h(Text, { color: '#FFF8DC' }, 'value ', 42)
        )
      )
    )
    instance.render(ctx())
    const tree = instance.tree() as RBox
    expect(tree.kind).toBe('box')
    expect(tree.style['paddingLeft']).toBe(2)
    expect(tree.style['paddingRight']).toBe(2)
    const [label, value] = tree.children as [RText, RText]
    expect(label.spans).toEqual([{ bold: true, fg: '#DAA520', text: 'label' }])
    expect(value.spans.map(s => s.text).join('')).toBe('value 42')
  })

  test('nested Text merges styles into spans (child wins)', () => {
    const instance = make(
      app(() => h(Text, { color: '#111111' }, 'a', h(Text, { bold: true }, 'b'), h(Text, { color: '#222222' }, 'c')))
    )
    instance.render(ctx())
    const tree = instance.tree() as RText
    expect(tree.spans).toEqual([
      { fg: '#111111', text: 'a' },
      { bold: true, fg: '#111111', text: 'b' },
      { fg: '#222222', text: 'c' }
    ])
  })

  test('useState in a component re-renders on setState (coalesced on a microtask)', async () => {
    let bump: (() => void) | undefined
    function Counter() {
      const [n, setN] = useState(0)
      bump = () => setN(v => v + 1)
      return h(Text, null, `n=${n}`)
    }
    const instance = make(app(() => h(Counter, null)))
    instance.render(ctx())
    expect(textOf(instance.tree())).toBe('n=0')
    bump?.()
    bump?.()
    await flushMicrotasks()
    expect(textOf(instance.tree())).toBe('n=2')
  })

  test('useEffect runs post-render, respects deps, and cleans up on unmount', async () => {
    const log: string[] = []
    function Child(props: Record<string, unknown>) {
      useEffect(() => {
        log.push(`mount:${String(props['tag'])}`)
        return () => log.push(`clean:${String(props['tag'])}`)
      }, [props['tag']])
      return h(Text, null, 'child')
    }
    const instance = make(
      app(c => {
        const s = c.state as { show: boolean; tag: string }
        return s.show ? h(Child, { tag: s.tag }) : h(Text, null, 'empty')
      })
    )
    instance.render(ctx({ show: true, tag: 'a' }))
    expect(log).toEqual(['mount:a'])
    instance.render(ctx({ show: true, tag: 'a' })) // same deps → no re-run
    expect(log).toEqual(['mount:a'])
    instance.render(ctx({ show: true, tag: 'b' })) // deps change → clean + re-run
    expect(log).toEqual(['mount:a', 'clean:a', 'mount:b'])
    instance.render(ctx({ show: false, tag: 'b' })) // unmount → cleanup
    expect(log).toEqual(['mount:a', 'clean:a', 'mount:b', 'clean:b'])
  })

  test('the shipped-template timer pattern ticks and dispose() clears the interval', async () => {
    vi.useFakeTimers()
    let ticks = 0
    function Clock() {
      const [now, setNow] = useState(0)
      useEffect(() => {
        const id = setInterval(() => {
          ticks += 1
          setNow(v => v + 1)
        }, 1000)
        return () => clearInterval(id)
      }, [])
      return h(Text, null, `t=${now}`)
    }
    const instance = make(app(() => h(Clock, null)))
    instance.render(ctx())
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks()
    expect(textOf(instance.tree())).toBe('t=2')
    instance.dispose()
    expect(vi.getTimerCount()).toBe(0) // cleanup ran — no leaked interval
    await vi.advanceTimersByTimeAsync(5000)
    expect(ticks).toBe(2)
  })

  test('a throwing render yields an error node, not an exception', () => {
    const instance = make(
      app(() => {
        throw new Error('widget exploded')
      })
    )
    expect(() => instance.render(ctx())).not.toThrow()
    const tree = instance.tree()
    expect(tree.kind).toBe('error')
    expect(textOf(tree)).toContain('widget exploded')
  })

  test('a throwing effect is contained and the tree still paints', () => {
    function Bad() {
      useEffect(() => {
        throw new Error('effect exploded')
      }, [])
      return h(Text, null, 'still here')
    }
    const instance = make(app(() => h(Bad, null)))
    expect(() => instance.render(ctx())).not.toThrow()
    expect(textOf(instance.tree())).toBe('still here')
  })

  test('a late setState after dispose() cannot resurrect the widget', async () => {
    let bump: (() => void) | undefined
    function Counter() {
      const [n, setN] = useState(0)
      bump = () => setN(v => v + 1)
      return h(Text, null, `n=${n}`)
    }
    const instance = make(app(() => h(Counter, null)))
    instance.render(ctx())
    instance.dispose()
    bump?.() // late async resolution (e.g. a fetch) after close
    await flushMicrotasks()
    expect(instance.isDisposed()).toBe(true)
    expect(textOf(instance.tree())).toBe('') // stays inert
  })

  test('a runaway setState loop freezes the widget fail-closed', async () => {
    function Spinner() {
      const [n, setN] = useState(0)
      setN(n + 1) // unconditional set during render — the pathological loop
      return h(Text, null, `n=${n}`)
    }
    const instance = make(app(() => h(Spinner, null)))
    instance.render(ctx())
    for (let i = 0; i < 400; i += 1) await Promise.resolve()
    const tree = instance.tree()
    expect(tree.kind).toBe('error')
    expect(textOf(tree)).toContain('frozen')
  })
})
