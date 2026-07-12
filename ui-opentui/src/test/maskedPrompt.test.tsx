import { ThemeProvider } from '../view/theme.tsx'
import { describe, expect, test } from 'vitest'

import {
  MaskedPrompt,
  maskedEdit,
  maskedGraphemes,
  maskedInsert,
  type MaskedEditorState
} from '../view/prompts/maskedPrompt.tsx'
import { createSessionStore } from '../logic/store.ts'
import { renderProbe } from './lib/render.ts'

const theme = createSessionStore().state.theme

function state(text: string, cursor = maskedGraphemes(text).length): MaskedEditorState {
  return { graphemes: maskedGraphemes(text), cursor }
}

async function mount(onSubmit: (value: string) => void = () => {}, onCancel: () => void = () => {}) {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => theme}>
        <MaskedPrompt icon="🔐" label="password required" onSubmit={onSubmit} onCancel={onCancel} />
      </ThemeProvider>
    ),
    { height: 10, kittyKeyboard: true, width: 50 }
  )
}

describe('masked editor model', () => {
  test('inserts a multi-character sequence at the cursor and strips controls', () => {
    expect(maskedInsert(state('ab', 1), 'XY\nZ')).toEqual(state('aXYZb', 4))
  })

  test('moves and deletes by Unicode grapheme instead of UTF-16 code unit', () => {
    const family = '👨‍👩‍👧‍👦'
    const combining = 'é'
    expect(maskedGraphemes(`A${family}${combining}`)).toEqual(['A', family, combining])

    const original = state(`A${family}${combining}`, 2)
    expect(maskedEdit(original, 'backspace')).toEqual(state(`A${combining}`, 1))
    expect(maskedEdit(original, 'delete')).toEqual(state(`A${family}`, 2))
    expect(maskedEdit(maskedEdit(original, 'home'), 'right')).toEqual(state(`A${family}${combining}`, 1))
    expect(maskedEdit(maskedEdit(original, 'end'), 'left')).toEqual(state(`A${family}${combining}`, 2))
  })
})

describe('MaskedPrompt', () => {
  test('supports cursor-aware paste and submits the real value without rendering it', async () => {
    let submitted: string | undefined
    const h = await mount(value => (submitted = value))
    try {
      await h.keys.typeText('ab')
      h.keys.pressArrow('left')
      h.renderer.keyInput.processPaste(new TextEncoder().encode('👩‍💻Z'))
      await h.settle()

      const frame = h.frame()
      expect(frame).toContain('***▍*')
      expect(frame).not.toContain('ab')
      expect(frame).not.toContain('👩‍💻Z')

      h.keys.pressEnter()
      await h.settle()
      expect(submitted).toBe('a👩‍💻Zb')
    } finally {
      h.destroy()
    }
  })

  test('handles home/end/delete/backspace and cancel', async () => {
    let submitted: string | undefined
    let cancelled = false
    const h = await mount(
      value => (submitted = value),
      () => (cancelled = true)
    )
    try {
      await h.keys.typeText('abcd')
      h.keys.pressKey('HOME')
      h.keys.pressKey('DELETE')
      h.keys.pressKey('END')
      h.keys.pressKey('BACKSPACE')
      await h.settle()
      h.keys.pressEnter()
      await h.settle()
      expect(submitted).toBe('bc')

      h.keys.pressEscape()
      await h.settle()
      expect(cancelled).toBe(true)
    } finally {
      h.destroy()
    }
  })
})
