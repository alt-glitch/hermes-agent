import { describe, expect, test } from 'vitest'

import { stripImageTokens } from '../logic/imageTokens.ts'

describe('stripImageTokens (Ink expandTokens image parity)', () => {
  test('drops each attached image token and one leading space before prompt.submit', () => {
    expect(stripImageTokens('look at [Image #1] and [Image #2] please', ['[Image #1]', '[Image #2]'])).toBe(
      'look at and please'
    )
    expect(stripImageTokens('[Image #1] what is this?', ['[Image #1]'])).toBe('what is this?')
    expect(stripImageTokens('describe\t[Image #1]', ['[Image #1]'])).toBe('describe')
  })

  test('an image-only prompt becomes empty text (the gateway supplies the caption)', () => {
    expect(stripImageTokens('[Image #1]', ['[Image #1]'])).toBe('')
  })

  test('leaves tokens without a live attachment and text without attachments untouched', () => {
    expect(stripImageTokens('keep [Image #3] literal', ['[Image #1]'])).toBe('keep [Image #3] literal')
    expect(stripImageTokens('  no images  ', [])).toBe('  no images  ')
  })
})
