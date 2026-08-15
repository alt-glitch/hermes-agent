import { describe, expect, it } from 'vitest'

import { applyTransforms, TRANSFORMS, type MarkdownTransform } from '../logic/markdownTransforms.ts'

describe('markdown transform pipeline', () => {
  it('applies transforms in registry order, feeding each the previous output', () => {
    const first: MarkdownTransform = text => `${text}1`
    const second: MarkdownTransform = text => `${text}2`
    const piped = [first, second].reduce<string>((text, transform) => transform(text, { streaming: false }), 'x')
    expect(piped).toBe('x12')
  })

  it('threads the streaming flag to every transform', () => {
    const seen: boolean[] = []
    const spy: MarkdownTransform = (text, context) => {
      seen.push(context.streaming)
      return text
    }
    spy('a', { streaming: true })
    spy('a', { streaming: false })
    expect(seen).toEqual([true, false])
  })

  it('converts Tier-A LaTeX via the math transform and is identity for plain prose', () => {
    expect(TRANSFORMS.length).toBeGreaterThan(0)
    expect(applyTransforms('Euler: $e^{i\\pi} + 1 = 0$', { streaming: false })).not.toContain('$')
    const prose = 'no math here'
    expect(applyTransforms(prose, { streaming: false })).toBe(prose)
  })
})
