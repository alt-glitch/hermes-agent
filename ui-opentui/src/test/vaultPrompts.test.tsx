/**
 * vault.save_login / vault.code server requests (Ink 5c975b9ed8): decoded against the contract,
 * opened as prompt cards, answered with ValueResult. The password is never rendered.
 */
import { describe, expect, test } from 'vitest'

import type { PromptReply, PromptResponseDisposition } from '../boundary/promptResponses.ts'
import { decodeServerRequest } from '../boundary/gateway/serverRequests.ts'
import { createSessionStore } from '../logic/store.ts'
import { promptNotification } from '../logic/termChrome.ts'
import { PromptOverlay } from '../view/prompts/promptOverlay.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

const theme = createSessionStore().state.theme
const ACCEPTED = { kind: 'accepted' } as const satisfies PromptResponseDisposition

function openRequest(store: ReturnType<typeof createSessionStore>, method: string, id: string, params: object) {
  const decoded = decodeServerRequest({ id, method, params: { session_id: 's', ...params }, respond: () => false })
  if (typeof decoded === 'string') throw new Error(`${method} ${id}: ${decoded}`)
  store.openPrompt(decoded.prompt)
}

async function mountOverlay(store: ReturnType<typeof createSessionStore>, sent: PromptReply[]) {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => theme}>
        <PromptOverlay
          store={store}
          onRespond={reply => {
            sent.push(reply)
            return Promise.resolve(ACCEPTED)
          }}
        />
      </ThemeProvider>
    ),
    { height: 24, kittyKeyboard: true, width: 80 }
  )
}

describe('vault server requests decode', () => {
  test('vault.save_login and vault.code are handled (not -32601) and answer {value}', () => {
    const answers: unknown[] = []
    const save = decodeServerRequest({
      id: 'save-1',
      method: 'vault.save_login',
      params: { session_id: 's', origin: 'https://github.com', site: 'github.com' },
      respond: result => (answers.push(result), true)
    })
    if (typeof save === 'string') throw new Error(save)
    expect(save.prompt).toEqual({
      kind: 'vaultSaveLogin',
      origin: 'https://github.com',
      site: 'github.com',
      requestId: 'save-1'
    })
    expect(save.respond({ value: '' })).toBe(true)
    // Not this method's result shape: nothing written.
    expect(save.respond({ choice: 'once' })).toBe(false)

    const code = decodeServerRequest({
      id: 'code-1',
      method: 'vault.code',
      params: { session_id: 's', site: null },
      respond: () => true
    })
    if (typeof code === 'string') throw new Error(code)
    expect(code.prompt).toEqual({ kind: 'vaultCode', site: '', hint: '', requestId: 'code-1' })
    expect(answers).toEqual([{ value: '' }])
  })

  test('a save-login frame missing the required origin is invalid-params; a blank site falls back to it', () => {
    expect(
      decodeServerRequest({
        id: 'x',
        method: 'vault.save_login',
        params: { session_id: 's', site: 'a' },
        respond: () => true
      })
    ).toBe('invalid-params')
    const decoded = decodeServerRequest({
      id: 'y',
      method: 'vault.save_login',
      params: { session_id: 's', origin: 'https://a.test', site: '' },
      respond: () => true
    })
    expect(typeof decoded !== 'string' && decoded.prompt).toMatchObject({ site: 'https://a.test' })
  })

  test('both kinds announce a specific terminal notification', () => {
    expect(promptNotification('vaultSaveLogin').body).not.toBe('is waiting for your input')
    expect(promptNotification('vaultCode').body).not.toBe('is waiting for your input')
  })
})

describe('PromptOverlay — vault save-login card', () => {
  test('identifier shown as typed, password masked, answer is JSON {identifier, password}', async () => {
    const store = createSessionStore()
    openRequest(store, 'vault.save_login', 'save-1', { origin: 'https://www.linkedin.com', site: 'www.linkedin.com' })
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      expect(h.frame()).toContain('Save your www.linkedin.com login')
      await h.keys.typeText('me@example.com')
      await h.settle()
      expect(h.frame()).toContain('me@example.com')
      h.keys.pressEnter()
      await h.settle()
      expect(h.frame()).toContain('Password for me@example.com')
      expect(sent).toEqual([])
      await h.keys.typeText('hunter2')
      await h.settle()
      expect(h.frame()).not.toContain('hunter2')
      expect(h.frame()).toContain('*******')
      h.keys.pressEnter()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual({
        kind: 'answer',
        requestId: 'save-1',
        result: { value: JSON.stringify({ identifier: 'me@example.com', password: 'hunter2' }) }
      })
      await expect.poll(() => store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('an empty identifier declines with an empty value', async () => {
    const store = createSessionStore()
    openRequest(store, 'vault.save_login', 'save-2', { origin: 'https://a.test', site: 'a.test' })
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      h.keys.pressEnter()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual({ kind: 'answer', requestId: 'save-2', result: { value: '' } })
      await expect.poll(() => store.state.prompt).toBeUndefined()
      expect(store.state.messages.some(m => m.text.includes('save-login prompt cancelled'))).toBe(true)
    } finally {
      h.destroy()
    }
  })

  test('Esc on the password step declines with an empty value (password never sent)', async () => {
    const store = createSessionStore()
    openRequest(store, 'vault.save_login', 'save-3', { origin: 'https://a.test', site: 'a.test' })
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      await h.keys.typeText('user')
      h.keys.pressEnter()
      await h.settle()
      await h.keys.typeText('pw')
      await h.settle()
      h.keys.pressEscape()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual({ kind: 'answer', requestId: 'save-3', result: { value: '' } })
    } finally {
      h.destroy()
    }
  })

  test('a request.cancel closes the card without a response', async () => {
    const store = createSessionStore()
    openRequest(store, 'vault.save_login', 'save-4', { origin: 'https://a.test', site: 'a.test' })
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      store.apply({ type: 'request.cancel', payload: { id: 'save-4', method: 'vault.save_login', reason: 'timeout' } })
      await expect.poll(() => store.state.prompt).toBeUndefined()
      expect(sent).toEqual([])
    } finally {
      h.destroy()
    }
  })
})

describe('PromptOverlay — vault verification-code card', () => {
  test('shows site and hint, the code as typed, and submits it trimmed', async () => {
    const store = createSessionStore()
    openRequest(store, 'vault.code', 'code-1', { site: 'github.com', hint: 'sent to •••42' })
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      expect(h.frame()).toContain('Verification code for github.com')
      expect(h.frame()).toContain('sent to •••42')
      await h.keys.typeText(' 123456 ')
      await h.settle()
      expect(h.frame()).toContain('123456')
      h.keys.pressEnter()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual({ kind: 'answer', requestId: 'code-1', result: { value: '123456' } })
      await expect.poll(() => store.state.prompt).toBeUndefined()
    } finally {
      h.destroy()
    }
  })

  test('Esc skips with an empty value', async () => {
    const store = createSessionStore()
    openRequest(store, 'vault.code', 'code-2', {})
    const sent: PromptReply[] = []
    const h = await mountOverlay(store, sent)
    try {
      expect(h.frame()).toContain('Verification code')
      h.keys.pressEscape()
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toEqual({ kind: 'answer', requestId: 'code-2', result: { value: '' } })
    } finally {
      h.destroy()
    }
  })
})
