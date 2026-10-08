/**
 * manage_connections card: wire decode, the pure reducer/phase table, the store
 * slice (event fold, settle lines, session reset, resume restore), and the
 * native card's keys against a recorded ops seam.
 */
import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import type { ConnectionRequestPayload, ConnectionTarget } from '../boundary/schema/Connection.ts'
import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'
import { decodeSessionResumeResponse } from '../boundary/schema/SessionOrchestratorResponses.ts'
import {
  ConnectionOpMemory,
  phaseOf,
  requestCard,
  unresolvedTargets,
  updateCard,
  verbOf
} from '../logic/connectionCard.ts'
import { actionExitBlocked } from '../logic/hotkeys.ts'
import { createSessionStore, type SessionStore } from '../logic/store.ts'
import { ConnectionCard, type ConnectionAnswer, type ConnectionCardOps } from '../view/prompts/connectionCard.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

const decode = Schema.decodeUnknownOption(GatewayEventSchema)

const target = (over: Partial<ConnectionTarget> = {}): ConnectionTarget => ({
  name: 'gmail',
  kind: 'connector',
  action: 'connect',
  state: 'pending',
  ...over
})

const request = (over: Partial<ConnectionRequestPayload> = {}): ConnectionRequestPayload => ({
  op_id: 'op-1',
  seq: 1,
  deadline_at: 2_000_000_000,
  timeout_seconds: 300,
  targets: [target()],
  ...over
})

const update = (seq: number, targets: ConnectionTarget[], settled = false) => ({
  op_id: 'op-1',
  seq,
  deadline_at: 2_000_000_000,
  settled,
  owner: { type: 'session', session_id: 's1' },
  targets
})

describe('connection wire decode', () => {
  test('decodes the gateway request payload shape, keeping unknown keys', () => {
    // Shape of ConnectionOperation.request_payload() for a managed connect.
    const event = decode({
      type: 'connection.request',
      session_id: 's1',
      payload: {
        op_id: 'op-1',
        seq: 2,
        deadline_at: 1_791_435_433.2,
        timeout_seconds: 300.0,
        tool_call_id: 'call_1',
        targets: [
          {
            name: 'gmail',
            kind: 'connector',
            action: 'connect',
            state: 'initiated',
            connect_url: 'https://connect.example/abc',
            connection_id: 'ca_1',
            attempt: 'a1'
          },
          {
            name: 'linear',
            kind: 'mcp',
            action: 'install',
            state: 'pending',
            required_env: [{ name: 'LINEAR_API_KEY', required: true, secret: true, default: '', prompt: null }]
          }
        ]
      }
    })
    expect(Option.isSome(event)).toBe(true)
    if (Option.isSome(event) && event.value.type === 'connection.request') {
      expect(event.value.payload.targets[0]?.connect_url).toBe('https://connect.example/abc')
      expect(event.value.payload.targets[1]?.required_env?.[0]?.secret).toBe(true)
    }
  })

  test('decodes a settled update and an unknown action verb', () => {
    const event = decode({ type: 'connection.update', payload: update(5, [target({ action: 'adopt' })], true) })
    expect(Option.isSome(event)).toBe(true)
    expect(verbOf('adopt')).toBe('Adopt')
  })

  test('resume snapshot carries pending_connection', () => {
    const decoded = decodeSessionResumeResponse({ session_id: 's1', messages: [], pending_connection: request() })
    expect(decoded?.pending_connection?.op_id).toBe('op-1')
  })
})

describe('connection reducer', () => {
  test('ignores older frames and reopening a settled or dismissed op', () => {
    const memory = new ConnectionOpMemory()
    const opened = requestCard(undefined, request({ seq: 3 }), memory)
    expect(requestCard(opened, request({ seq: 2, targets: [] }), memory)).toBe(opened)
    expect(updateCard(opened, update(3, []), memory).card).toBe(opened)
    const moved = updateCard(opened, update(4, [target({ state: 'initiated' })]), memory).card
    expect(moved?.targets[0]?.state).toBe('initiated')

    const settled = updateCard(moved, update(5, [target({ state: 'connected' })], true), memory)
    expect(settled.card).toBeUndefined()
    expect(settled.lines).toEqual(['gmail: connected'])
    expect(requestCard(undefined, request({ seq: 9 }), memory)).toBeUndefined()
  })

  test('settle for a dismissed op still reports; for an unseen op it is silent', () => {
    const memory = new ConnectionOpMemory()
    memory.markDismissed('op-1')
    expect(updateCard(undefined, update(2, [target({ state: 'skipped' })], true), memory).lines).toEqual([
      'gmail: skipped'
    ])
    const other = { ...update(2, [target({ state: 'not_connected' })], true), op_id: 'op-2' }
    expect(updateCard(undefined, other, memory).lines).toEqual([])
  })

  test('phase table', () => {
    expect(phaseOf(target())).toBe('form')
    expect(phaseOf(target({ state: 'initiated', connect_url: 'https://x' }))).toBe('browser')
    expect(phaseOf(target({ state: 'initiated' }))).toBe('working')
    expect(phaseOf(target({ state: 'failed' }))).toBe('retry')
    expect(
      phaseOf(target({ state: 'expired', required_env: [{ name: 'K', required: true, secret: true, default: '' }] }))
    ).toBe('form')
    expect(phaseOf(target({ state: 'connected', discovery_error: 'boom' }))).toBe('authorized')
    const card = { opId: 'op', seq: 1, deadlineAt: 0, targets: [target({ state: 'connected' }), target({ name: 'b' })] }
    expect(unresolvedTargets(card).map(t => t.name)).toEqual(['b'])
  })
})

describe('connection store slice', () => {
  test('folds events, writes settle lines, blocks action-exit, resets with the session', () => {
    const store = createSessionStore()
    store.apply({ type: 'connection.request', payload: request() })
    expect(store.state.connection?.opId).toBe('op-1')
    expect(actionExitBlocked(store.state)).toBe(true)

    store.apply({ type: 'connection.update', payload: update(2, [target({ state: 'skipped' })], true) })
    expect(store.state.connection).toBeUndefined()
    expect(JSON.stringify(store.state.messages)).toContain('gmail: skipped')

    store.apply({ type: 'connection.request', payload: request({ op_id: 'op-2' }) })
    store.adoptFreshSession('s2')
    expect(store.state.connection).toBeUndefined()
    store.restoreConnection(request({ op_id: 'op-3' }))
    expect(store.state.connection?.opId).toBe('op-3')
    store.dismissConnection('op-3')
    expect(store.state.connection).toBeUndefined()
    store.restoreConnection(request({ op_id: 'op-3', seq: 7 }))
    expect(store.state.connection).toBeUndefined()
  })
})

interface Recorded {
  responses: { opId: string; result: ConnectionAnswer }[]
  reconnects: string[]
  interrupts: number
  opened: string[]
}

async function mountCard(store: SessionStore, fail = false) {
  const rec: Recorded = { responses: [], reconnects: [], interrupts: 0, opened: [] }
  const ops: ConnectionCardOps = {
    respond: (opId, result) => {
      rec.responses.push({ opId, result })
      return fail ? Promise.reject(new Error('down')) : Promise.resolve({ status: 'ok', settled: false })
    },
    reconnect: name => {
      rec.reconnects.push(name)
      return Promise.resolve({})
    },
    interrupt: () => {
      rec.interrupts += 1
    },
    openUrl: url => {
      rec.opened.push(url)
      return true
    },
    dismiss: opId => store.dismissConnection(opId),
    isSettled: opId => store.connectionSettled(opId)
  }
  const h = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        {store.state.connection ? <ConnectionCard card={store.state.connection} ops={ops} /> : null}
      </ThemeProvider>
    ),
    { width: 90, height: 24, kittyKeyboard: true }
  )
  return { h, rec }
}

const storeWith = (payload: ConnectionRequestPayload): SessionStore => {
  const store = createSessionStore()
  store.apply({ type: 'connection.request', payload })
  return store
}

describe('ConnectionCard view', () => {
  test('browser phase paints the link; Enter opens it, Esc skips', async () => {
    const url = 'https://connect.example/gmail'
    const store = storeWith(request({ targets: [target({ state: 'initiated', connect_url: url })] }))
    const { h, rec } = await mountCard(store)
    try {
      const frame = h.frame()
      expect(frame).toContain('Connect gmail')
      expect(frame).toContain(url)
      expect(frame).toContain('Enter open in browser')
      h.keys.pressEnter()
      await h.settle()
      expect(rec.opened).toEqual([url])
      h.keys.pressEscape()
      await h.settle()
      expect(rec.responses).toEqual([{ opId: 'op-1', result: { targets: [{ name: 'gmail', status: 'skipped' }] } }])
      expect(h.frame()).toContain('Pending…')
    } finally {
      h.destroy()
    }
  })

  test('form: required secret blocks Connect, typed secret is masked and sent as env', async () => {
    const store = storeWith(
      request({
        targets: [
          target({
            name: 'linear',
            kind: 'mcp',
            action: 'install',
            required_env: [
              { name: 'LINEAR_API_KEY', required: true, secret: true, default: '', prompt: 'API key' },
              { name: 'LINEAR_TEAM', required: false, secret: false, default: 'eng' }
            ]
          })
        ]
      })
    )
    const { h, rec } = await mountCard(store)
    try {
      expect(h.frame()).toContain('Install linear')
      expect(h.frame()).toContain('API key *')
      expect(h.frame()).toContain('eng')
      // Jump to the selector and confirm with the field empty: no answer, focus returns.
      h.keys.pressTab()
      h.keys.pressTab()
      await h.settle()
      h.keys.pressEnter()
      await h.settle()
      expect(rec.responses).toEqual([])
      expect(h.frame()).toContain('API key is required.')

      await h.keys.typeText('sk-secret')
      await h.settle()
      expect(h.frame()).not.toContain('sk-secret')
      expect(h.frame()).toContain('*********')
      h.keys.pressEnter() // next field
      h.keys.pressEnter() // selector
      await h.settle()
      h.keys.pressEnter()
      await h.settle()
      expect(rec.responses).toEqual([
        {
          opId: 'op-1',
          result: {
            targets: [{ name: 'linear', status: 'approved', env: { LINEAR_API_KEY: 'sk-secret', LINEAR_TEAM: 'eng' } }]
          }
        }
      ])
    } finally {
      h.destroy()
    }
  })

  test('retry: Try again re-mints through connectors.connect; ←/→ then Enter skips', async () => {
    const store = storeWith(request({ targets: [target({ state: 'failed', detail: 'denied' })] }))
    const { h, rec } = await mountCard(store)
    try {
      expect(h.frame()).toContain('That did not work.')
      expect(h.frame()).toContain('denied')
      h.keys.pressEnter()
      await h.settle()
      expect(rec.reconnects).toEqual(['gmail'])
    } finally {
      h.destroy()
    }
    const second = storeWith(request({ targets: [target({ state: 'expired' })] }))
    const { h: h2, rec: rec2 } = await mountCard(second)
    try {
      h2.keys.pressArrow('right')
      await h2.settle()
      h2.keys.pressEnter()
      await h2.settle()
      expect(rec2.responses[0]?.result).toEqual({ targets: [{ name: 'gmail', status: 'skipped' }] })
    } finally {
      h2.destroy()
    }
  })

  test('Ctrl+C interrupts the turn; a failed answer shows a notice and re-enables the row', async () => {
    const store = storeWith(request({ targets: [target({ state: 'initiated' })] }))
    const { h, rec } = await mountCard(store, true)
    try {
      h.keys.pressCtrlC()
      await h.settle()
      expect(rec.interrupts).toBe(1)
      h.keys.pressEscape()
      await h.settle()
      await h.settle()
      expect(h.frame()).toContain('That answer did not reach Hermes.')
      expect(h.frame()).not.toContain('Pending…')
    } finally {
      h.destroy()
    }
  })

  test('authorized row continues; finishing card closes locally on Esc', async () => {
    const store = storeWith(request({ targets: [target({ state: 'connected', discovery_error: 'tools failed' })] }))
    const { h, rec } = await mountCard(store)
    try {
      expect(h.frame()).toContain('Authorized. Tools unavailable.')
      h.keys.pressEnter()
      await h.settle()
      expect(rec.responses[0]?.result).toEqual({ settled_by: 'continue' })
    } finally {
      h.destroy()
    }
    const done = storeWith(request({ targets: [target({ state: 'skipped' })] }))
    const { h: h2 } = await mountCard(done)
    try {
      expect(h2.frame()).toContain('Finishing…')
      h2.keys.pressEscape()
      await h2.settle()
      expect(done.state.connection).toBeUndefined()
    } finally {
      h2.destroy()
    }
  })
})
