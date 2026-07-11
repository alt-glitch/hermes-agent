import { afterEach, describe, expect, test, vi } from 'vitest'

import { dailyFortune, fortuneFromScore, randomFortune } from '../logic/fortunes.ts'

afterEach(() => vi.restoreAllMocks())

describe('local fortunes (Ink parity)', () => {
  test('ordinary and legendary scores select the correct bags/glyphs', () => {
    expect(fortuneFromScore(1)).toBe('🔮 a tiny rename today prevents a huge bug tomorrow')
    expect(fortuneFromScore(20)).toBe('🌟 legendary drop: your diff teaches by itself')
  })

  test('daily fortune is stable for a session and local calendar date', () => {
    const day = new Date(2026, 6, 11, 9, 30)
    expect(dailyFortune('sid-42', day)).toBe(dailyFortune('sid-42', new Date(2026, 6, 11, 23, 59)))
    expect(dailyFortune(undefined, day)).toMatch(/^(?:🔮|🌟) /u)
  })

  test('random fortune uses Math.random and retains the corpus output shape', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1 / 0x7fffffff)
    expect(randomFortune()).toBe(fortuneFromScore(1))
  })
})
