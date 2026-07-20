/**
 * Store test (spec v4 §5 Layer 3). Pure data behavior of the reducer: skin →
 * theme, LRU dedup, hydrate-while-buffering (Phase 1); and the Phase 2b ordered
 * `parts[]` model — text/tool interleave in one turn, tool start↔complete matched
 * by id and updated IN PLACE, `{output,exit_code}` envelope stripped.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

import { approvalChoices } from '../logic/approval.ts'
import { DEFAULT_THEME } from '../logic/theme.ts'
import { createSessionStore, startupCatalogRetryDelay, type Message } from '../logic/store.ts'

describe('session store — theming / dedup / hydrate (Phase 1)', () => {
  test('gateway.ready{skin} re-themes; default before', () => {
    const store = createSessionStore()
    expect(store.state.theme.brand.name).toBe(DEFAULT_THEME.brand.name)
    store.apply({
      type: 'gateway.ready',
      payload: { skin: { branding: { agent_name: 'Zephyr' }, colors: { ui_primary: '#123456' } } }
    })
    expect(store.state.ready).toBe(true)
    expect(store.state.theme.brand.name).toBe('Zephyr')
    expect(store.state.theme.color.primary).toBe('#123456')
  })

  test('skin.changed updates the theme live', () => {
    const store = createSessionStore()
    store.apply({ type: 'skin.changed', payload: { branding: { agent_name: 'Aurora' } } })
    expect(store.state.theme.brand.name).toBe('Aurora')
  })

  test('skin survives /clear and resume (theme is NOT a session-scoped slice)', () => {
    const store = createSessionStore()
    store.apply({
      type: 'skin.changed',
      payload: { branding: { agent_name: 'Aurora' }, colors: { ui_primary: '#abcdef' } }
    })
    store.clearTranscript()
    expect(store.state.theme.brand.name).toBe('Aurora')
    expect(store.state.theme.color.primary).toBe('#abcdef')
    // resume path (commitSnapshot) must also preserve the active skin
    store.commitSnapshot([])
    expect(store.state.theme.brand.name).toBe('Aurora')
    expect(store.state.theme.color.primary).toBe('#abcdef')
  })

  test('skin spinner + tool_emojis flow onto the theme (B wire-up)', () => {
    const store = createSessionStore()
    store.apply({
      type: 'skin.changed',
      payload: {
        spinner: { thinking_faces: ['(a)', '(b)'], wings: [['<', '>']], thinking_verbs: ['forging'] },
        tool_emojis: { terminal: '⚔' }
      }
    })
    expect(store.state.theme.spinner.thinkingFaces).toEqual(['(a)', '(b)'])
    expect(store.state.theme.spinner.wings).toEqual([['<', '>']])
    expect(store.state.theme.toolEmojis.terminal).toBe('⚔')
  })

  test('ui_bg sets theme.color.bg; default stays transparent (D root-canvas opt-in)', () => {
    const store = createSessionStore()
    expect(store.state.theme.color.bg).toBe('transparent')
    store.apply({ type: 'skin.changed', payload: { colors: { ui_bg: '#0A0A0A' } } })
    expect(store.state.theme.color.bg).toBe('#0A0A0A')
  })

  test('LRU dedup: duplicate(id) returns false once, true after', () => {
    const store = createSessionStore()
    expect(store.duplicate('evt-1')).toBe(false)
    expect(store.duplicate('evt-1')).toBe(true)
    expect(store.duplicate(undefined)).toBe(false) // no id → never deduped
  })

  test('hydrate replaces history, then replays events buffered mid-hydrate', () => {
    const store = createSessionStore()
    const snapshot: Message[] = [
      { role: 'user', text: 'old q' },
      { role: 'assistant', text: 'old a' }
    ]
    // Simulate a live event arriving DURING hydrate by emitting inside loadSnapshot.
    let emittedDuring = false
    store.hydrate(() => {
      if (!emittedDuring) {
        emittedDuring = true
        store.apply({ type: 'message.start' })
        store.apply({ type: 'message.delta', payload: { text: 'live!' } })
      }
      return snapshot
    })
    // snapshot (2) + the buffered live assistant turn (1) replayed after
    expect(store.state.messages.length).toBe(3)
    expect(store.state.messages[0]!.text).toBe('old q')
    // the streamed assistant text now lives in an ordered text part
    expect(store.state.messages[2]!.parts?.[0]).toMatchObject({ type: 'text', text: 'live!' })
  })
})

describe('session store — correlated steer notices', () => {
  test('removes only the steer acknowledged by message.complete', () => {
    const store = createSessionStore()
    store.pushPendingSteer('steer-a', 'steer queued: a')
    store.pushPendingSteer('steer-b', 'steer queued: b')

    store.apply({ type: 'message.complete', payload: { client_submission_ids: ['steer-a'] } })

    expect(store.state.messages.map(message => message.text)).toEqual(['steer queued: b'])
  })

  test('removes promoted steers on correlated message.start and terminal errors', () => {
    const store = createSessionStore()
    store.pushPendingSteer('promoted', 'steer queued: promoted')
    store.apply({ type: 'message.start', payload: { client_submission_ids: ['promoted'] } })
    expect(store.state.messages.some(message => message.steerSubmissionId === 'promoted')).toBe(false)

    store.pushPendingSteer('failed', 'steer queued: failed')
    store.apply({ type: 'error', payload: { client_submission_ids: ['failed'], message: 'turn failed' } })
    expect(store.state.messages.some(message => message.steerSubmissionId === 'failed')).toBe(false)
    expect(store.state.messages.at(-1)?.text).toBe('error: turn failed')
  })

  test('does not resurrect a notice when completion wins the RPC-response race', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.complete', payload: { client_submission_ids: ['fast-steer'] } })
    store.pushPendingSteer('fast-steer', 'must not appear')
    expect(store.state.messages).toEqual([])
  })
})

describe('session store — ordered parts (Phase 2b)', () => {
  test('interleaves text → tool → text as ordered parts in one assistant turn', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'before ' } })
    store.apply({ type: 'tool.start', payload: { tool_id: 't1', name: 'terminal' } })
    // result_text is the {output,exit_code} JSON envelope — the store strips it.
    store.apply({
      type: 'tool.complete',
      payload: { tool_id: 't1', result_text: '{"output":"hello\\nworld","exit_code":0}' }
    })
    store.apply({ type: 'message.delta', payload: { text: 'after' } })
    store.apply({ type: 'message.complete' })

    const msg = store.state.messages.at(-1)!
    expect(msg.role).toBe('assistant')
    expect(msg.streaming).toBe(false)
    const parts = msg.parts ?? []
    expect(parts.map(p => p.type)).toEqual(['text', 'tool', 'text'])
    expect(parts[0]).toMatchObject({ type: 'text', text: 'before ' })
    expect(parts[2]).toMatchObject({ type: 'text', text: 'after' })
    const tool = parts[1]!
    if (tool.type === 'tool') {
      expect(tool.state).toBe('complete')
      expect(tool.name).toBe('terminal')
      expect(tool.resultText).toBe('hello\nworld') // envelope stripped
      expect(tool.lineCount).toBe(2)
    } else {
      throw new Error('expected a tool part at index 1')
    }
  })

  test('seals interim commentary and keeps a distinct terminal reply', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'interim answer' } })
    store.apply({ type: 'message.interim', payload: { text: 'interim answer', already_streamed: true } })
    store.apply({ type: 'message.delta', payload: { text: 'final answer' } })
    store.apply({ type: 'message.complete', payload: { text: 'final answer' } })

    const assistants = store.state.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants.map(message => message.parts?.find(part => part.type === 'text')?.text)).toEqual([
      'interim answer',
      'final answer'
    ])
    expect(assistants.every(message => message.streaming === false)).toBe(true)
  })

  test('settles a previewed final onto its interim without a duplicate bubble', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'same reply' } })
    store.apply({ type: 'message.interim', payload: { text: 'same reply', already_streamed: true } })
    store.apply({ type: 'message.complete', payload: { text: 'same reply plus tail', response_previewed: true } })

    const assistants = store.state.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.parts?.find(part => part.type === 'text')?.text).toBe('same reply plus tail')
    expect(assistants[0]?.streaming).toBe(false)
  })

  test('drops a post-interim streaming duplicate when the final was previewed', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.interim', payload: { text: 'preview', already_streamed: true } })
    store.apply({ type: 'message.delta', payload: { text: ' plus tail' } })
    store.apply({ type: 'message.complete', payload: { text: 'preview plus tail', response_previewed: true } })

    const assistants = store.state.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.parts?.find(part => part.type === 'text')?.text).toBe('preview plus tail')
  })

  test('keeps one live assistant across mid-turn shell and notification rows', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'before ' } })

    // Local activity is visible transcript chrome, but it does not end or own
    // the model turn that started above.
    store.pushLocalUser('!pwd', 'shell')
    store.pushSystem('/tmp/hermes-shell-output')
    store.apply({
      type: 'notification.show',
      payload: {
        id: 'bg-mid-turn',
        key: 'bg-mid-turn',
        kind: 'process.complete',
        level: 'info',
        text: 'background-mid-turn-finished'
      }
    })

    store.apply({ type: 'tool.start', payload: { tool_id: 't-mid', name: 'terminal' } })
    store.apply({ type: 'tool.complete', payload: { tool_id: 't-mid', result_text: 'tool finished' } })
    store.apply({ type: 'message.delta', payload: { text: 'after' } })
    store.apply({ type: 'message.complete' })

    const assistants = store.state.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.streaming).toBe(false)
    expect(assistants[0]?.parts?.map(part => part.type)).toEqual(['text', 'tool', 'text'])
    expect(assistants[0]?.parts?.[0]).toMatchObject({ type: 'text', text: 'before ' })
    expect(assistants[0]?.parts?.[1]).toMatchObject({ type: 'tool', id: 't-mid', state: 'complete' })
    expect(assistants[0]?.parts?.[2]).toMatchObject({ type: 'text', text: 'after' })
    expect(store.state.messages.some(message => message.role === 'assistant' && message.streaming)).toBe(false)
    expect(store.state.messages.map(message => message.role)).toEqual(['assistant', 'user', 'system', 'notification'])
  })

  test('message.complete with text but NO prior start creates the turn (complete-only gateway; no drop)', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    // no message.start / no deltas — straight to complete with the full text
    store.apply({ type: 'message.complete', payload: { text: 'The whole answer.' } })
    const msg = store.state.messages.at(-1)!
    expect(msg.role).toBe('assistant')
    expect(msg.streaming).toBe(false)
    expect(msg.parts?.some(p => p.type === 'text' && p.text === 'The whole answer.')).toBe(true)
  })

  test('message.complete with no live turn and no text does NOT create an empty bubble', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.complete', payload: {} })
    expect(store.state.messages.filter(m => m.role === 'assistant')).toHaveLength(0)
  })

  test('tool.complete updates the running tool part IN PLACE (not a new row)', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'tool.start', payload: { tool_id: 'x', name: 'read_file' } })
    expect(store.state.messages.at(-1)!.parts).toHaveLength(1)
    expect(store.state.messages.at(-1)!.parts![0]).toMatchObject({ type: 'tool', state: 'running', name: 'read_file' })

    store.apply({ type: 'tool.complete', payload: { tool_id: 'x', summary: 'read 42 lines' } })
    const parts = store.state.messages.at(-1)!.parts!
    expect(parts).toHaveLength(1) // updated in place — NOT appended as a separate row
    const tool = parts[0]!
    if (tool.type === 'tool') {
      expect(tool.state).toBe('complete')
      expect(tool.summary).toBe('read 42 lines')
    } else {
      throw new Error('expected a tool part')
    }
  })

  test('captures tool args: context→argsPreview, args→argsText, duration, omitted note (item 2)', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'tool.start', payload: { tool_id: 'a', name: 'terminal', context: 'ls -la src' } })
    store.apply({
      type: 'tool.complete',
      payload: {
        tool_id: 'a',
        name: 'terminal',
        args: { command: 'ls -la src' },
        duration_s: 0.34,
        result_text: '[showing verbose tail; omitted 3 lines / 90 chars]\nfile1\nfile2'
      }
    })
    const tool = store.state.messages.at(-1)!.parts![0]!
    if (tool.type !== 'tool') throw new Error('expected a tool part')
    expect(tool.argsPreview).toBe('ls -la src') // primary-arg preview shown in the header (NOT overwritten)
    expect(tool.argsText).toContain('"command"') // full args JSON for the expanded view
    expect(tool.duration).toBe(0.34)
    expect(tool.omittedNote).toBe('3 lines / 90 chars') // tidy note; raw label stripped
    expect(tool.resultText).toBe('file1\nfile2') // clean body (label peeled)
    expect(tool.lineCount).toBe(2)
  })

  test('tool.complete captures structured args into part.args (renderer registry feed)', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'tool.start', payload: { tool_id: 'a', name: 'mcp_lookup' } })
    store.apply({
      type: 'tool.complete',
      payload: { tool_id: 'a', args: { query: 'hermes', options: { depth: 2 } }, result_text: 'ok' }
    })
    const tool = store.state.messages.at(-1)!.parts![0]!
    if (tool.type !== 'tool') throw new Error('expected a tool part')
    expect(tool.args).toEqual({ query: 'hermes', options: { depth: 2 } }) // full structured dict
    expect(tool.argsText).toContain('"query"') // stringified fallback still kept
  })

  test('derives resultText from the raw `result` when result_text is absent (non-verbose sessions)', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'tool.start', payload: { tool_id: 'nv', name: 'terminal' } })
    // non-verbose: no result_text — only the raw envelope-string `result`
    store.apply({
      type: 'tool.complete',
      payload: { tool_id: 'nv', result: '{"output":"hi there\\nline two","exit_code":0,"error":null}' }
    })
    const tool = store.state.messages.at(-1)!.parts![0]!
    if (tool.type !== 'tool') throw new Error('expected a tool part')
    expect(tool.resultText).toBe('hi there\nline two') // envelope stripped, same pipeline
    expect(tool.lineCount).toBe(2)
  })

  test('an object `result` is unwrapped too; result_text keeps precedence when present', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'tool.start', payload: { tool_id: 'o1', name: 'terminal' } })
    store.apply({ type: 'tool.complete', payload: { tool_id: 'o1', result: { output: 'obj out', exit_code: 0 } } })
    store.apply({ type: 'tool.start', payload: { tool_id: 'o2', name: 'terminal' } })
    store.apply({
      type: 'tool.complete',
      payload: { tool_id: 'o2', result: 'raw fallback', result_text: 'verbose text' }
    })

    const parts = store.state.messages.at(-1)!.parts!
    const first = parts[0]!
    const second = parts[1]!
    if (first.type !== 'tool' || second.type !== 'tool') throw new Error('expected tool parts')
    expect(first.resultText).toBe('obj out') // object envelope → its output
    expect(second.resultText).toBe('verbose text') // result_text still wins when sent
  })

  test('setCatalog maps the loose startup.catalog response defensively (item 9)', () => {
    const store = createSessionStore()
    store.setCatalog({
      tools: {
        total: 42,
        toolsets: [
          { name: 'core', count: 12, enabled: true, tools: ['a', 'b', 3] },
          { name: 'off', count: 5, enabled: false, tools: [] },
          { name: '', count: 1 }
        ]
      },
      skills: { total: 7, categories: [{ name: 'dev', count: 7 }] },
      mcp: { servers: ['railway', 123, 'beeper'] },
      junk: 'ignored'
    })
    const c = store.state.catalog!
    expect(c.tools.total).toBe(42)
    expect(c.tools.toolsets).toEqual([
      { name: 'core', count: 12, enabled: true, tools: ['a', 'b'] }, // non-string tool dropped
      { name: 'off', count: 5, enabled: false, tools: [] } // enabled flag preserved
    ]) // nameless entry dropped
    expect(c.skills.total).toBe(7)
    expect(c.mcp.servers).toEqual(['railway', 'beeper']) // non-string dropped
    expect(c.readiness).toEqual({ status: 'ready', retryAfterMs: undefined, warning: undefined })
  })

  test('setCatalog leaves the catalog unset on garbage / non-object input (decode → none)', () => {
    const store = createSessionStore()
    expect(store.state.catalog).toBeUndefined()
    store.setCatalog('not an object')
    expect(store.state.catalog).toBeUndefined()
    store.setCatalog(null)
    expect(store.state.catalog).toBeUndefined()
    store.setCatalog(42)
    expect(store.state.catalog).toBeUndefined()
  })

  test('setCatalog accepts a sparse but well-shaped catalog (absent sections default empty)', () => {
    const store = createSessionStore()
    store.setCatalog({ tools: { total: 3, toolsets: [{ name: 'core', count: 3, tools: ['a'] }] } })
    const c = store.state.catalog!
    expect(c.tools.total).toBe(3)
    expect(c.tools.toolsets).toEqual([{ name: 'core', count: 3, enabled: true, tools: ['a'] }]) // enabled defaults on
    expect(c.skills).toEqual({ total: 0, categories: [] }) // absent section → empty
    expect(c.mcp.servers).toEqual([])
  })

  test('startup catalog pending metadata retries boundedly; ready/failed stop', () => {
    const store = createSessionStore()
    const pending = store.setCatalog({
      tools: { total: 0, toolsets: [] },
      readiness: {
        status: 'pending',
        warning: '  tool catalog still loading  ',
        retry_after_ms: 1000
      }
    })
    expect(pending?.readiness).toEqual({
      status: 'pending',
      retryAfterMs: 1000,
      warning: 'tool catalog still loading'
    })
    expect(startupCatalogRetryDelay(pending)).toBe(1000)

    const tooFast = store.setCatalog({ readiness: { status: 'pending', retry_after_ms: 1 } })
    expect(startupCatalogRetryDelay(tooFast)).toBe(250)
    const tooSlow = store.setCatalog({ readiness: { status: 'pending', retry_after_ms: 60_000 } })
    expect(startupCatalogRetryDelay(tooSlow)).toBe(30_000)
    expect(startupCatalogRetryDelay(store.setCatalog({ readiness: { status: 'ready' } }))).toBeUndefined()
    expect(
      startupCatalogRetryDelay(
        store.setCatalog({ readiness: { status: 'failed', warning: 'agent init failed', retry_after_ms: 1000 } })
      )
    ).toBeUndefined()
  })

  test('reasoning.delta accumulates into a reasoning part', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'reasoning.delta', payload: { text: 'thinking ' } })
    store.apply({ type: 'reasoning.delta', payload: { text: 'hard' } })
    const parts = store.state.messages.at(-1)!.parts ?? []
    expect(parts[0]).toMatchObject({ type: 'reasoning', text: 'thinking hard' })
  })

  test('thinking.delta (kaomoji face) → transient status, NOT a transcript part; complete clears it', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'thinking.delta', payload: { text: '(´･_･`) formulating...' } })
    expect(store.state.status).toBe('(´･_･`) formulating...')
    expect(store.state.messages.at(-1)!.parts ?? []).toHaveLength(0) // no reasoning row from the face
    store.apply({ type: 'message.delta', payload: { text: 'Hi!' } })
    store.apply({ type: 'message.complete' })
    expect(store.state.status).toBeUndefined() // cleared when the turn ends
    // only the real reply text part remains — the face never entered the transcript
    expect((store.state.messages.at(-1)!.parts ?? []).map(p => p.type)).toEqual(['text'])
  })

  test('status.update also drives the transient status line', () => {
    const store = createSessionStore()
    store.apply({ type: 'status.update', payload: { kind: 'tool', text: 'running terminal…' } })
    expect(store.state.status).toBe('running terminal…')
  })

  test('reasoning.available and message.complete reasoning are fallback-only without duplication', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'reasoning.delta', payload: { text: 'streamed thought' } })
    store.apply({ type: 'reasoning.available', payload: { text: 'fallback thought' } })
    store.apply({ type: 'message.complete', payload: { reasoning: 'completion thought', text: 'answer' } })
    const reasoning = store.state.messages
      .find(message => message.role === 'assistant')
      ?.parts?.filter(part => part.type === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect(reasoning?.[0]).toMatchObject({ text: 'streamed thought' })
  })

  test('completion-only reasoning creates one ordered settled reasoning part before answer text', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.complete', payload: { reasoning: 'recovered thought', text: 'final answer' } })
    const assistant = store.state.messages.at(-1)
    expect(assistant?.streaming).toBe(false)
    expect(assistant?.parts).toMatchObject([
      { type: 'reasoning', text: 'recovered thought' },
      { type: 'text', text: 'final answer' }
    ])
  })

  test('completion fallback reasoning never repeats the visible final answer', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'same answer' } })
    store.apply({ type: 'message.complete', payload: { reasoning: 'same answer', text: 'same answer' } })
    expect(store.state.messages.at(-1)?.parts).toMatchObject([{ type: 'text', text: 'same answer' }])
  })

  test('distinct completion fallback reasoning is ordered before streamed answer text', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'final answer' } })
    store.apply({ type: 'message.complete', payload: { reasoning: 'genuine thought', text: 'final answer' } })
    expect(store.state.messages.at(-1)?.parts).toMatchObject([
      { type: 'reasoning', text: 'genuine thought' },
      { type: 'text', text: 'final answer' }
    ])
  })

  test('MoA references stay as distinct ordered visible parts; aggregation is status-only', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({
      type: 'moa.reference',
      payload: { count: 2, index: 1, label: 'provider/model-a', text: 'Alpha answer' }
    })
    store.apply({
      type: 'moa.reference',
      payload: { count: 2, index: 2, label: 'provider/model-b', text: 'Beta answer' }
    })
    const before = store.state.messages.at(-1)?.parts?.length
    if (before === undefined) throw new Error('expected MoA parts')
    store.apply({ type: 'moa.aggregating', payload: { aggregator: 'provider/model-z' } })
    expect(store.state.messages.at(-1)?.parts).toHaveLength(before)
    expect(store.state.status).toBe('aggregating with provider/model-z…')
    expect(store.state.messages.at(-1)?.parts).toMatchObject([
      { type: 'moa', text: expect.stringContaining('Reference 1/2 — provider/model-a') },
      { type: 'moa', text: expect.stringContaining('Reference 2/2 — provider/model-b') }
    ])
  })

  test('bounds MoA reference count, per-reference text, and total chars across many turns', () => {
    const store = createSessionStore()
    for (let turn = 0; turn < 24; turn++) {
      store.apply({ type: 'message.start' })
      for (let index = 0; index < 24; index++) {
        store.apply({
          type: 'moa.reference',
          payload: { index: index + 1, label: `model-${index}`, text: 'x'.repeat(12_000) }
        })
      }
      store.apply({ type: 'message.complete', payload: { text: `answer-${turn}` } })
    }
    const assistants = store.state.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(24)
    for (const assistant of assistants) {
      const references = assistant.parts?.filter(part => part.type === 'moa') ?? []
      expect(references.length).toBeLessThanOrEqual(16)
      expect(references.every(reference => reference.text.length < 8_300)).toBe(true)
      expect(references.reduce((total, reference) => total + reference.text.length, 0)).toBeLessThanOrEqual(65_536)
    }
    const retained = assistants.reduce(
      (total, assistant) =>
        total + (assistant.parts ?? []).reduce((sum, part) => sum + (part.type === 'moa' ? part.text.length : 0), 0),
      0
    )
    expect(retained).toBeLessThanOrEqual(524_288)
    expect(assistants.at(-1)?.parts?.some(part => part.type === 'moa')).toBe(true)
  })

  test('tool.progress updates the newest matching running tool and tool.generating updates status', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'tool.start', payload: { context: 'initial', name: 'browser', tool_id: 'b1' } })
    store.apply({ type: 'tool.start', payload: { context: 'other', name: 'terminal', tool_id: 't1' } })
    store.apply({ type: 'tool.progress', payload: { name: 'browser', preview: 'loaded hero cards' } })
    store.apply({ type: 'tool.generating', payload: { name: 'image' } })
    const tools = store.state.messages.at(-1)?.parts?.filter(part => part.type === 'tool') ?? []
    expect(tools[0]).toMatchObject({ id: 'b1', argsPreview: 'initial', progressPreview: 'loaded hero cards' })
    expect(tools[1]).toMatchObject({ id: 't1', argsPreview: 'other' })
    expect(store.state.status).toBe('drafting image…')
    store.apply({ type: 'tool.complete', payload: { name: 'browser', summary: 'done', tool_id: 'b1' } })
    expect(tools[0]).toMatchObject({ id: 'b1', argsPreview: 'initial', state: 'complete' })
    expect(tools[0]?.progressPreview).toBeUndefined()
  })

  test('message.complete final text is authoritative while preserving non-text ordered parts', () => {
    const corrected = createSessionStore()
    corrected.apply({ type: 'message.start' })
    corrected.apply({ type: 'message.delta', payload: { text: 'before partial' } })
    corrected.apply({ type: 'tool.start', payload: { name: 'terminal', tool_id: 't-final' } })
    corrected.apply({ type: 'tool.complete', payload: { name: 'terminal', summary: 'done', tool_id: 't-final' } })
    corrected.apply({ type: 'message.delta', payload: { text: ' stale tail' } })
    corrected.apply({ type: 'message.complete', payload: { text: 'correct final answer' } })
    const parts = corrected.state.messages.at(-1)?.parts ?? []
    expect(parts.filter(part => part.type === 'tool')).toHaveLength(1)
    expect(parts.filter(part => part.type === 'text')).toMatchObject([{ text: 'correct final answer' }])

    const expanded = createSessionStore()
    expanded.apply({ type: 'message.start' })
    expanded.apply({ type: 'message.delta', payload: { text: 'hello' } })
    expanded.apply({ type: 'message.complete', payload: { text: 'hello world' } })
    expect(expanded.state.messages.at(-1)?.parts).toMatchObject([{ type: 'text', text: 'hello world' }])
  })

  test('typed status restore is latest-wins and uses exact 6s goal / 4s activity windows', () => {
    vi.useFakeTimers()
    try {
      const store = createSessionStore()
      store.apply({ type: 'status.update', payload: { kind: 'goal', text: '✓ shipped' } })
      vi.advanceTimersByTime(5_999)
      expect(store.state.status).toBe('✓ goal complete')
      vi.advanceTimersByTime(1)
      expect(store.state.status).toBeUndefined()

      store.apply({ type: 'status.update', payload: { kind: 'warn', text: 'first warning' } })
      vi.advanceTimersByTime(3_000)
      store.apply({ type: 'status.update', payload: { kind: 'error', text: 'newest error' } })
      vi.advanceTimersByTime(1_001)
      expect(store.state.status).toBe('newest error')
      vi.advanceTimersByTime(2_999)
      expect(store.state.status).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  test('status restore timers cannot clear newer turn, session, or gateway teardown state', () => {
    vi.useFakeTimers()
    try {
      const turn = createSessionStore()
      turn.apply({ type: 'status.update', payload: { kind: 'warn', text: 'old warning' } })
      turn.apply({ type: 'message.start' })
      turn.setStatus('new turn status')
      vi.advanceTimersByTime(5_000)
      expect(turn.state.status).toBe('new turn status')

      const session = createSessionStore()
      session.apply({ type: 'status.update', payload: { kind: 'warn', text: 'old warning' } })
      session.adoptFreshSession('new-session', {})
      session.setStatus('new session status')
      vi.advanceTimersByTime(5_000)
      expect(session.state.status).toBe('new session status')

      const gateway = createSessionStore()
      gateway.apply({ type: 'status.update', payload: { kind: 'warn', text: 'old warning' } })
      gateway.apply({ type: 'gateway.exited' })
      vi.advanceTimersByTime(5_000)
      expect(gateway.state.status).toBe('gateway exited')
    } finally {
      vi.useRealTimers()
    }
  })

  test('browser progress and typed goal/compression/warn/error statuses persist with duplicate activity bounded', () => {
    const store = createSessionStore()
    store.apply({ type: 'browser.progress', payload: { message: '  browser authenticated  ' } })
    store.apply({ type: 'browser.progress', payload: { message: '   ' } })
    store.apply({ type: 'status.update', payload: { kind: 'goal', text: '✓ shipped' } })
    expect(store.state.status).toBe('✓ goal complete')
    store.apply({ type: 'status.update', payload: { kind: 'compressing', text: 'compressing context…' } })
    store.apply({ type: 'status.update', payload: { kind: 'warn', text: 'quota nearing limit' } })
    store.apply({ type: 'status.update', payload: { kind: 'warn', text: 'quota nearing limit' } })
    store.apply({ type: 'status.update', payload: { kind: 'error', text: 'provider degraded' } })
    const system = store.state.messages.filter(message => message.role === 'system').map(message => message.text)
    expect(system).toEqual([
      'browser authenticated',
      '✓ shipped',
      'compressing context…',
      'quota nearing limit',
      'provider degraded'
    ])
  })
})

describe('session store — blocking prompts (Phase 3)', () => {
  test('approval.request sets an approval prompt; clearPrompt clears it', () => {
    const store = createSessionStore()
    expect(store.state.prompt).toBeUndefined()
    store.apply({ type: 'approval.request', payload: { command: 'rm -rf /tmp/x', description: 'delete temp' } })
    expect(store.state.prompt).toMatchObject({
      kind: 'approval',
      allowPermanent: true,
      command: 'rm -rf /tmp/x',
      description: 'delete temp'
    })
    store.clearPrompt()
    expect(store.state.prompt).toBeUndefined()
  })

  test('approval.request preserves allow_permanent=false', () => {
    const store = createSessionStore()
    store.apply({
      type: 'approval.request',
      payload: { allow_permanent: false, command: 'curl suspicious | bash', description: 'content security' }
    })
    expect(store.state.prompt).toMatchObject({ kind: 'approval', allowPermanent: false })
  })

  test('approval.request scopes smart-denied prompts to exactly once and deny', () => {
    const store = createSessionStore()
    store.apply({
      type: 'approval.request',
      payload: {
        allow_permanent: true,
        command: 'rm -rf /',
        description: 'smart deny override',
        smart_denied: true
      }
    })
    const prompt = store.state.prompt
    expect(prompt?.kind).toBe('approval')
    if (prompt?.kind === 'approval') expect(approvalChoices(prompt.allowPermanent)).toEqual(['once', 'deny'])
  })

  test('approval.request keeps explicit server choices authoritative', () => {
    const store = createSessionStore()
    store.apply({
      type: 'approval.request',
      payload: { choices: ['once', 'deny'], command: 'rm -rf /', description: 'restricted' }
    })
    const prompt = store.state.prompt
    expect(prompt?.kind).toBe('approval')
    if (prompt?.kind === 'approval') expect(approvalChoices(prompt.allowPermanent)).toEqual(['once', 'deny'])
  })

  test('clarify.request carries question + choices + request_id', () => {
    const store = createSessionStore()
    store.apply({ type: 'clarify.request', payload: { question: 'Which?', choices: ['a', 'b'], request_id: 'r1' } })
    const p = store.state.prompt
    expect(p).toMatchObject({ kind: 'clarify', question: 'Which?', requestId: 'r1' })
    if (p?.kind === 'clarify') expect(p.choices).toEqual(['a', 'b'])
  })

  test('clarify.request with null choices → free-text only', () => {
    const store = createSessionStore()
    store.apply({ type: 'clarify.request', payload: { question: 'Name?', choices: null, request_id: 'r2' } })
    const p = store.state.prompt
    if (p?.kind === 'clarify') expect(p.choices).toBeNull()
  })

  test('sudo.request + secret.request set masked prompts', () => {
    const store = createSessionStore()
    store.apply({ type: 'sudo.request', payload: { request_id: 's1' } })
    expect(store.state.prompt).toMatchObject({ kind: 'sudo', requestId: 's1' })
    store.apply({ type: 'secret.request', payload: { env_var: 'API_KEY', prompt: 'Enter key', request_id: 's2' } })
    expect(store.state.prompt).toMatchObject({ kind: 'secret', envVar: 'API_KEY', requestId: 's2' })
  })

  test('sensitive expiry clears only the matching active prompt', () => {
    const store = createSessionStore()

    store.apply({ type: 'secret.request', payload: { env_var: 'NEW_KEY', prompt: 'Enter key', request_id: 'new' } })
    store.apply({ type: 'secret.expire', payload: { request_id: 'old' } })
    expect(store.state.prompt).toMatchObject({ kind: 'secret', requestId: 'new' })
    store.apply({ type: 'secret.expire', payload: { request_id: 'new' } })
    expect(store.state.prompt).toBeUndefined()

    store.apply({ type: 'sudo.request', payload: { request_id: 'sudo-new' } })
    store.apply({ type: 'sudo.expire', payload: { request_id: 'sudo-old' } })
    expect(store.state.prompt).toMatchObject({ kind: 'sudo', requestId: 'sudo-new' })
    store.apply({ type: 'sudo.expire', payload: { request_id: 'sudo-new' } })
    expect(store.state.prompt).toBeUndefined()
  })
})

describe('session store — subagents (Phase 5e agents dashboard)', () => {
  test('subagent.* events build + update a subagent by id', () => {
    const store = createSessionStore()
    store.apply({
      type: 'subagent.start',
      payload: { subagent_id: 'a1', goal: 'research X', model: 'haiku', depth: 1 }
    })
    expect(store.state.subagents).toHaveLength(1)
    expect(store.state.subagents[0]).toMatchObject({ id: 'a1', goal: 'research X', status: 'running', depth: 1 })

    store.apply({ type: 'subagent.tool', payload: { subagent_id: 'a1', tool_name: 'web_search' } })
    expect(store.state.subagents[0]).toMatchObject({ status: 'running', lastTool: 'web_search' })

    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a1', summary: 'found it' } })
    expect(store.state.subagents).toHaveLength(1) // updated in place
    expect(store.state.subagents[0]).toMatchObject({ status: 'completed', summary: 'found it' })
  })

  test('accumulates a live trace per subagent (item 15) + transient thought', () => {
    const store = createSessionStore()
    store.apply({ type: 'subagent.start', payload: { subagent_id: 'a1', goal: 'crunch data' } })
    store.apply({ type: 'subagent.thinking', payload: { subagent_id: 'a1', text: 'considering options' } })
    store.apply({ type: 'subagent.tool', payload: { subagent_id: 'a1', tool_name: 'web_search', text: 'opentui' } })
    store.apply({ type: 'subagent.progress', payload: { subagent_id: 'a1', text: 'found 3 hits' } })
    store.apply({ type: 'subagent.complete', payload: { subagent_id: 'a1', summary: 'done crunching' } })
    const sa = store.state.subagents[0]!
    // thinking text is transient (not in the trace), the rest is a concise TYPED log
    expect(sa.thought).toBe('considering options')
    expect(sa.trace).toEqual([
      { kind: 'start', text: 'crunch data' },
      { kind: 'tool', text: 'Web Search("opentui")' },
      { kind: 'progress', text: 'found 3 hits' },
      { kind: 'summary', text: 'done crunching' }
    ])
  })

  test('subagent.text per-token frames COALESCE into ONE growing reply trace entry', () => {
    const store = createSessionStore()
    store.apply({ type: 'subagent.start', payload: { subagent_id: 'a1', goal: 'answer' } })
    // two consecutive per-token mirrors for the same subagent
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: 'Hello' } })
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: ', world' } })
    const sa = store.state.subagents[0]!
    // grows by ONE (the reply), not two — the start entry + one coalesced reply
    expect(sa.trace).toHaveLength(2)
    expect(sa.trace![1]).toEqual({ kind: 'reply', text: 'Hello, world' })
    expect(sa.status).toBe('running')
    // a non-reply entry between two text frames breaks coalescing → a fresh reply line
    store.apply({ type: 'subagent.progress', payload: { subagent_id: 'a1', text: 'mid' } })
    store.apply({ type: 'subagent.text', payload: { subagent_id: 'a1', text: 'again' } })
    expect(sa.trace).toHaveLength(4)
    expect(sa.trace![3]).toEqual({ kind: 'reply', text: 'again' })
  })

  test('clearTranscript also clears subagents', () => {
    const store = createSessionStore()
    store.apply({ type: 'subagent.start', payload: { subagent_id: 'a1', goal: 'g' } })
    store.clearTranscript()
    expect(store.state.subagents).toHaveLength(0)
  })
})

describe('session store — session chrome / status bar (item 14)', () => {
  test('session.info populates model/effort/cwd/branch and nested usage context', () => {
    const store = createSessionStore()
    store.apply({
      type: 'session.info',
      payload: {
        model: 'anthropic/claude-opus-4-8',
        reasoning_effort: 'high',
        fast: true,
        cwd: '/home/x/proj',
        branch: 'main',
        running: false,
        usage: { context_used: 42000, context_max: 200000, context_percent: 21 }
      }
    })
    const info = store.state.info
    expect(info.model).toBe('anthropic/claude-opus-4-8')
    expect(info.effort).toBe('high')
    expect(info.fast).toBe(true)
    expect(info.cwd).toBe('/home/x/proj')
    expect(info.branch).toBe('main')
    expect(info.contextPercent).toBe(21)
    expect(info.contextMax).toBe(200000)
  })

  test('session.info round-trips the inference `provider` field (Port #1 compat)', () => {
    const store = createSessionStore()
    store.apply({
      type: 'session.info',
      payload: { model: 'anthropic/claude-opus-4-8', provider: 'openrouter', reasoning_effort: 'high' }
    })
    const info = store.state.info
    expect(info.model).toBe('anthropic/claude-opus-4-8')
    expect(info.provider).toBe('openrouter')
    expect(info.effort).toBe('high')
  })

  test('session.info keeps a CUSTOM provider name verbatim (never collapsed to "custom")', () => {
    // Upstream added custom-provider session persistence; the engine boundary
    // must surface the gateway's exact provider slug (e.g. a `custom:<name>`
    // registered backend) rather than flattening it to the bare dialect word
    // "custom". infoPatchFrom passes `d.provider` straight through, so whatever
    // the gateway sends round-trips unchanged.
    const store = createSessionStore()
    store.apply({
      type: 'session.info',
      payload: { model: 'my-local-llm', provider: 'custom:lab-proxy' }
    })
    expect(store.state.info.provider).toBe('custom:lab-proxy')
    // a later partial patch that omits provider must not wipe it (merge, not replace).
    store.applyInfo({ branch: 'main' })
    expect(store.state.info.provider).toBe('custom:lab-proxy')
  })

  test('session.info mcp count = CONNECTED servers, not configured-but-disabled ones', () => {
    const store = createSessionStore()
    store.apply({
      type: 'session.info',
      payload: {
        model: 'gpt-5.4',
        // two configured servers; only one is connected (e.g. a disabled `linear`
        // alongside a connected `nous-support`). The bar's `mcp: N` must read the
        // CONNECTED count (1), never the configured total (2) — mirroring the
        // classic CLI banner (`sum(s.connected)`) and the Ink SessionPanel headline.
        mcp_servers: [
          { name: 'nous-support', transport: 'http', connected: true, tools: ['a', 'b'] },
          { name: 'linear', transport: 'stdio', connected: false, tools: [] }
        ]
      }
    })
    expect(store.state.info.mcpServers).toBe(1)
  })

  test('session.info mcp count is 0 when no servers are connected (segment drops)', () => {
    const store = createSessionStore()
    store.apply({
      type: 'session.info',
      payload: {
        model: 'gpt-5.4',
        mcp_servers: [{ name: 'linear', transport: 'stdio', connected: false, tools: [] }]
      }
    })
    // all configured servers disabled → connected count 0 (statusBar drops `mcp:` when n <= 0).
    expect(store.state.info.mcpServers).toBe(0)
  })

  test('session.info reads context from TOP-LEVEL fields when there is no nested usage', () => {
    const store = createSessionStore()
    store.apply({
      type: 'session.info',
      payload: { model: 'gpt-5.4', context_used: 1000, context_max: 8000, context_percent: 13, compressions: 2 }
    })
    const info = store.state.info
    expect(info.model).toBe('gpt-5.4')
    expect(info.contextUsed).toBe(1000)
    expect(info.contextMax).toBe(8000)
    expect(info.contextPercent).toBe(13)
    expect(info.compressions).toBe(2)
  })

  test('session.info prefers nested usage.context_* over the top-level fallback', () => {
    const store = createSessionStore()
    store.apply({
      type: 'session.info',
      payload: { context_percent: 5, usage: { context_percent: 88 } }
    })
    expect(store.state.info.contextPercent).toBe(88) // nested wins
  })

  test('session.info with a malformed payload does NOT crash and leaves chrome untouched (decode → none)', () => {
    const store = createSessionStore()
    store.applyInfo({ model: 'opus', cwd: '/p' })
    // a wrong-typed field (model: number) fails the schema → empty patch, prior info survives
    store.apply({ type: 'session.info', payload: { model: 123, usage: 'nope' } })
    expect(store.state.info).toMatchObject({ model: 'opus', cwd: '/p' })
  })

  test('session.info with a partial payload only patches the present fields', () => {
    const store = createSessionStore()
    store.applyInfo({ model: 'opus', branch: 'main', running: true })
    store.apply({ type: 'session.info', payload: { branch: 'dev' } }) // only branch present
    expect(store.state.info).toMatchObject({ model: 'opus', branch: 'dev', running: true })
  })

  test('session.info project identity survives partial patches and explicit null clears it', () => {
    const store = createSessionStore()
    store.applyInfo({
      cwd: '/work/hermes',
      project: { id: 'p1', name: 'Hermes Agent', primary_path: '/work/hermes', slug: 'hermes-agent' }
    })
    expect(store.state.info.projectName).toBe('Hermes Agent')
    store.applyInfo({ branch: 'main' })
    expect(store.state.info.projectName).toBe('Hermes Agent')
    store.applyInfo({ project: null })
    expect(store.state.info.projectName).toBeNull()
  })

  test('message.start sets running, message.complete clears it + refreshes usage', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    expect(store.state.info.running).toBe(true)
    store.apply({ type: 'message.delta', payload: { text: 'hi' } })
    store.apply({ type: 'message.complete', payload: { usage: { context_percent: 33 } } })
    expect(store.state.info.running).toBe(false)
    expect(store.state.info.contextPercent).toBe(33)
  })

  test('applyInfo merges a session.create info patch without clobbering prior fields', () => {
    const store = createSessionStore()
    store.applyInfo({ model: 'gpt-5.4', cwd: '/tmp' })
    store.applyInfo({ branch: 'dev' }) // partial patch — model/cwd must survive
    expect(store.state.info).toMatchObject({ model: 'gpt-5.4', cwd: '/tmp', branch: 'dev' })
  })

  test('setHint sets/clears the transient composer hint (Ctrl+C again to quit — item 11)', () => {
    const store = createSessionStore()
    expect(store.state.hint).toBeUndefined()
    store.setHint('Ctrl+C again to quit')
    expect(store.state.hint).toBe('Ctrl+C again to quit')
    store.setHint(undefined)
    expect(store.state.hint).toBeUndefined()
  })
})

describe('session store — gateway lifecycle / transport errors (auto-heal foundations)', () => {
  test('gateway.exited clears the frozen running spinner AND pushes a system notice', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    expect(store.state.info.running).toBe(true) // a turn is in flight
    store.apply({ type: 'gateway.exited' })
    // THE key bug fix: the spinner is cleared even though no message.complete arrived.
    expect(store.state.info.running).toBe(false)
    expect(store.isTurnInFlight()).toBe(false)
    // Neutral status — "recovering…" now comes from gateway.recovering only.
    expect(store.state.status).toBe('gateway exited')
    const sys = store.state.messages.filter(m => m.role === 'system')
    expect(sys).toHaveLength(1)
    expect(sys[0]!.text).toContain('in-flight reply was lost')
    expect(store.state.messages.some(message => message.role === 'assistant')).toBe(false)
  })

  test('gateway.exited retains a partial assistant as settled even if recovery exhausts', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'partial before crash' } })

    store.apply({ type: 'gateway.exited', payload: { reason: 'signal' } })

    const assistant = store.state.messages.find(message => message.role === 'assistant')
    expect(assistant).toMatchObject({ role: 'assistant', streaming: false })
    expect(assistant?.parts).toEqual([expect.objectContaining({ type: 'text', text: 'partial before crash' })])
    expect(store.isTurnInFlight()).toBe(false)
  })

  test('a pre-message.start error settles optimistic busy and releases the queue hook once', () => {
    const store = createSessionStore()
    const settled = vi.fn()
    store.registerTurnCompleteHandler(settled)
    store.applyInfo({ running: true })
    store.apply({ type: 'error', payload: { message: 'agent init failed' } })
    expect(store.state.info.running).toBe(false)
    expect(store.isTurnInFlight()).toBe(false)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  test('removes only the exact optimistic user row on pre-start rejection', () => {
    const store = createSessionStore()
    const committed = store.pushUser('committed')
    const optimistic = store.pushUser('not committed')
    store.pushSystem('local chrome after send')

    expect(store.removeClientMessage(optimistic)).toBe(true)
    expect(store.removeClientMessage(optimistic)).toBe(false)
    expect(store.state.messages.map(message => message.text)).toEqual(['committed', 'local chrome after send'])
    expect(store.state.messages[0]?.clientId).toBe(committed)
  })

  test('an error after message.start waits for authoritative session.info before draining', () => {
    const store = createSessionStore()
    const settled = vi.fn()
    store.registerTurnCompleteHandler(settled)
    store.apply({ type: 'message.start' })
    store.apply({ type: 'error', payload: { message: 'turn failed' } })
    expect(store.state.info.running).toBe(false)
    expect(store.isTurnInFlight()).toBe(true)
    expect(settled).not.toHaveBeenCalled()
    store.apply({ type: 'session.info', payload: { running: false } })
    expect(store.isTurnInFlight()).toBe(false)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  test('an error after start removes an empty streaming assistant row', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    expect(store.state.messages.at(-1)).toMatchObject({ role: 'assistant', streaming: true, text: '' })

    store.apply({ type: 'error', payload: { message: 'preflight failed' } })

    expect(store.state.messages.some(message => message.role === 'assistant')).toBe(false)
    expect(store.state.messages.at(-1)).toMatchObject({ role: 'system', text: 'error: preflight failed' })
  })

  test('an error after a partial delta retains a settled non-streaming assistant row', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'partial answer' } })

    store.apply({ type: 'error', payload: { message: 'stream failed' } })

    const assistant = store.state.messages.find(message => message.role === 'assistant')
    expect(assistant).toMatchObject({ role: 'assistant', streaming: false })
    expect(assistant?.parts).toEqual([expect.objectContaining({ type: 'text', text: 'partial answer' })])
    store.apply({ type: 'session.info', payload: { running: false } })
    expect(store.isTurnInFlight()).toBe(false)
  })

  test('gateway.exited enriches the notice with payload.reason when present', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.exited', payload: { reason: 'SIGKILL', code: 137 } })
    const sys = store.state.messages.filter(m => m.role === 'system')
    expect(sys[0]!.text).toContain('SIGKILL')
  })

  test('gateway.recovering reflects the attempt number in the status', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.recovering', payload: { attempt: 2 } })
    expect(store.state.status).toBe('gateway recovering (attempt 2)…')
  })

  test('gateway.stderr is collected (NOT pushed to transcript), surfaced on start_timeout', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.stderr', payload: { line: 'ModuleNotFoundError: no module foo' } })
    store.apply({ type: 'gateway.stderr', payload: { line: 'traceback line 2' } })
    // chatty stderr never floods the transcript on its own
    expect(store.state.messages).toHaveLength(0)
    // …but the tail is surfaced when the gateway fails to start
    store.apply({ type: 'gateway.start_timeout', payload: {} })
    const sys = store.state.messages.filter(m => m.role === 'system')
    expect(sys).toHaveLength(1)
    expect(sys[0]!.text).toContain('gateway failed to start')
    expect(sys[0]!.text).toContain('ModuleNotFoundError')
  })

  test('gateway.protocol_error and error are surfaced to the transcript', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.protocol_error', payload: { preview: '<garbled>' } })
    store.apply({ type: 'error', payload: { message: 'boom' } })
    const sys = store.state.messages.filter(m => m.role === 'system')
    expect(sys.map(m => m.text)).toEqual(['gateway protocol error: <garbled>', 'error: boom'])
  })

  test('gateway stderr startup tail marks pathological lines as truncated', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.stderr', payload: { line: 'x'.repeat(5000) } })
    store.apply({ type: 'gateway.start_timeout', payload: {} })
    expect(store.state.messages.at(-1)?.text).toMatch(/… \[truncated\]$/)
  })

  test('review.summary surfaces the self-improvement digest as a system line', () => {
    const store = createSessionStore()
    store.apply({
      type: 'review.summary',
      payload: { text: '💾 Self-improvement review: saved 1 skill, 2 memories' }
    })
    const sys = store.state.messages.filter(m => m.role === 'system')
    expect(sys).toHaveLength(1)
    expect(sys[0]!.text).toBe('💾 Self-improvement review: saved 1 skill, 2 memories')
  })

  test('review.summary with empty/missing text is ignored (no blank system line)', () => {
    const store = createSessionStore()
    store.apply({ type: 'review.summary', payload: { text: '   ' } })
    store.apply({ type: 'review.summary', payload: {} })
    store.apply({ type: 'review.summary' })
    expect(store.state.messages.filter(m => m.role === 'system')).toHaveLength(0)
  })
})

describe('session store — resume hydrate (Phase 4b)', () => {
  test('beginBuffer + commitSnapshot replaces history then replays events buffered across the resume', () => {
    const store = createSessionStore()
    store.beginBuffer()
    // a live event arrives DURING the (async) session.resume RPC
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'live during resume' } })
    // the snapshot commits afterwards
    store.commitSnapshot([{ role: 'user', text: 'old question' }])
    expect(store.state.messages).toHaveLength(2) // snapshot(1) + the replayed assistant turn(1)
    expect(store.state.messages[0]).toMatchObject({ role: 'user', text: 'old question' })
    expect(store.state.messages[1]!.parts?.[0]).toMatchObject({ type: 'text', text: 'live during resume' })
  })
})

describe('session store — rolling message cap (bounds the Yoga node high-water mark)', () => {
  const ENV_KEY = 'HERMES_TUI_MAX_MESSAGES'
  const WINDOWING_KEY = 'HERMES_TUI_WINDOWING'
  const prev = process.env[ENV_KEY]
  const prevWindowing = process.env[WINDOWING_KEY]
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prev
    if (prevWindowing === undefined) delete process.env[WINDOWING_KEY]
    else process.env[WINDOWING_KEY] = prevWindowing
  })

  test('caps the message array at the env-tuned MESSAGE_CAP, dropping the oldest (head)', () => {
    process.env[ENV_KEY] = '5'
    const store = createSessionStore()
    expect(store.messageCap).toBe(5)
    // push more than the cap; each distinct so we can tell which survived
    for (let i = 0; i < 55; i++) store.pushUser(`msg ${i}`)
    expect(store.state.messages).toHaveLength(5)
    expect(store.state.dropped).toBe(50) // head-sliced overflow is counted for the notice
    // the oldest 50 were sliced from the head; survivors are the last 5 (msg 50..54)
    expect(store.state.messages[0]!.text).toBe('msg 50')
    expect(store.state.messages.at(-1)!.text).toBe('msg 54')
  })

  test('pushSystem is also capped (head-dropped) at MESSAGE_CAP', () => {
    process.env[ENV_KEY] = '3'
    const store = createSessionStore()
    for (let i = 0; i < 10; i++) store.pushSystem(`sys ${i}`)
    expect(store.state.messages).toHaveLength(3)
    expect(store.state.messages[0]!.text).toBe('sys 7')
    expect(store.state.messages.at(-1)!.text).toBe('sys 9')
  })

  test('the in-flight streaming turn it opens at overflow SURVIVES the cap (head sliced, not tail)', () => {
    process.env[ENV_KEY] = '4'
    const store = createSessionStore()
    // fill to the cap with user rows so the next push overflows
    store.pushUser('u0')
    store.pushUser('u1')
    store.pushUser('u2')
    store.pushUser('u3') // array now at the cap (4): [u0, u1, u2, u3]
    expect(store.state.messages).toHaveLength(4)

    // message.start pushes the assistant turn as the LAST row (length 5) → head sliced to 4.
    // The freshly-pushed streaming turn is the tail, so it must NOT be the one evicted.
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'in flight' } })
    expect(store.state.messages).toHaveLength(4)
    expect(store.state.messages[0]!.text).toBe('u1') // 'u0' dropped from the head, not the tail turn
    const live = store.state.messages.at(-1)!
    expect(live.role).toBe('assistant')
    expect(live.streaming).toBe(true)
    expect(live.parts?.[0]).toMatchObject({ type: 'text', text: 'in flight' })
  })

  test('mid-turn local-row overflow cannot evict the active assistant identity', () => {
    process.env[ENV_KEY] = '3'
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'before ' } })

    for (let i = 0; i < 6; i++) store.pushSystem(`local ${i}`)
    store.apply({ type: 'message.delta', payload: { text: 'after' } })
    store.apply({ type: 'message.complete' })

    expect(store.state.messages).toHaveLength(3)
    expect(store.state.dropped).toBe(4)
    expect(store.state.messages.map(message => message.text)).toEqual(['', 'local 4', 'local 5'])
    const assistants = store.state.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.streaming).toBe(false)
    expect(assistants[0]?.parts).toEqual([expect.objectContaining({ type: 'text', text: 'before after' })])
  })

  test('message.start is capped: opening a turn beyond the cap drops the oldest', () => {
    process.env[ENV_KEY] = '2'
    const store = createSessionStore()
    store.pushUser('a')
    store.pushUser('b')
    store.apply({ type: 'message.start' }) // array would be 3 → trimmed to 2
    expect(store.state.messages).toHaveLength(2)
    expect(store.state.messages[0]!.text).toBe('b') // 'a' dropped from the head
    expect(store.state.messages.at(-1)!.role).toBe('assistant')
  })

  test('commitSnapshot caps an over-cap resume snapshot (oldest history dropped)', () => {
    process.env[ENV_KEY] = '3'
    const store = createSessionStore()
    const snapshot: Message[] = Array.from({ length: 8 }, (_, i) => ({ role: 'user', text: `h${i}` }))
    store.beginBuffer()
    store.commitSnapshot(snapshot)
    expect(store.state.messages).toHaveLength(3)
    expect(store.state.dropped).toBe(5) // 8 snapshot − 3 kept; resume SETS the count
    expect(store.state.messages[0]!.text).toBe('h5')
    expect(store.state.messages.at(-1)!.text).toBe('h7')
  })

  test('defaults to 3000 (windowed ceiling) when the env var is unset/invalid and windowing is on', () => {
    // With transcript windowing (the default) the mounted set is ~3 viewports
    // regardless of store size, so the scrollback ceiling is 3000 (#27 payoff).
    delete process.env[ENV_KEY]
    delete process.env[WINDOWING_KEY]
    const store = createSessionStore()
    expect(store.messageCap).toBe(3000)
    for (let i = 0; i < 3050; i++) store.pushUser(`m${i}`)
    expect(store.state.messages).toHaveLength(3000)
    expect(store.state.messages[0]!.text).toBe('m50') // oldest 50 dropped
  })

  test('HERMES_TUI_WINDOWING=0 keeps the handle-safe 1000 ceiling (every row mounts again)', () => {
    delete process.env[ENV_KEY]
    process.env[WINDOWING_KEY] = '0'
    const store = createSessionStore()
    expect(store.messageCap).toBe(1000)
    for (let i = 0; i < 1050; i++) store.pushUser(`m${i}`)
    expect(store.state.messages).toHaveLength(1000)
    expect(store.state.messages[0]!.text).toBe('m50')
  })

  test('env values ABOVE the ceiling are clamped to it (the native handle table binds, not memory)', () => {
    // @opentui/core's global handle registry holds 65,534 live objects and a
    // text renderable costs 3; ~47 handles/row on the realistic fixture means
    // ≳1,400 live MOUNTED rows crashes mid-mount ("Failed to create
    // SyntaxStyle"). Windowing bounds the mounted set (peak 31 measured), so
    // the windowed ceiling is 3000 stored rows; a 100000 "cap" still clamps.
    process.env[ENV_KEY] = '100000'
    delete process.env[WINDOWING_KEY]
    const store = createSessionStore()
    for (let i = 0; i < 3100; i++) store.pushUser(`m${i}`)
    expect(store.state.messages).toHaveLength(3000)
    expect(store.state.dropped).toBe(100)
    expect(store.state.messages[0]!.text).toBe('m100')
  })

  test('uncappedFixture bypasses the clamp (fixture materialization — store never mounted)', () => {
    delete process.env[ENV_KEY]
    const store = createSessionStore({ uncappedFixture: true })
    for (let i = 0; i < 1100; i++) store.pushUser(`m${i}`)
    expect(store.state.messages).toHaveLength(1100)
    expect(store.state.dropped).toBe(0)
  })

  test('clearTranscript empties messages AND the applied dedup set', () => {
    const store = createSessionStore()
    store.pushUser('x')
    // seed the dedup set with an id, then confirm it is now treated as seen
    expect(store.duplicate('seen-1')).toBe(false)
    expect(store.duplicate('seen-1')).toBe(true)

    store.clearTranscript()
    expect(store.state.messages).toHaveLength(0)
    // after clear the previously-seen id is processed again (the applied Set was cleared)
    expect(store.duplicate('seen-1')).toBe(false)
  })

  test('clearTranscript resets the dropped counter (the truncation notice clears)', () => {
    process.env[ENV_KEY] = '2'
    const store = createSessionStore()
    for (let i = 0; i < 5; i++) store.pushUser(`m${i}`) // 5 pushed, cap 2 → 3 dropped
    expect(store.state.dropped).toBe(3)
    store.clearTranscript()
    expect(store.state.dropped).toBe(0)
  })
})

describe('session store — todo panel snapshot + draft + /new info reset', () => {
  const todoComplete = (
    todos: Array<{ id: string; content: string; status: string }>,
    summary?: Record<string, number>
  ) =>
    ({
      type: 'tool.complete',
      payload: {
        tool_id: 't1',
        name: 'todo',
        args: { todos },
        result: { todos, ...(summary ? { summary } : {}) },
        duration_s: 0
      }
    }) as never

  test('captures latestTodos from a todo tool.complete (result.todos)', () => {
    const store = createSessionStore()
    store.apply(
      todoComplete(
        [
          { id: '0', content: 'a', status: 'completed' },
          { id: '1', content: 'b', status: 'in_progress' },
          { id: '2', content: 'c', status: 'pending' }
        ],
        { completed: 1, in_progress: 1, pending: 1, cancelled: 0 }
      )
    )
    const snap = store.state.latestTodos
    expect(snap).toBeDefined()
    expect(snap?.todos).toHaveLength(3)
    // list order is preserved (priority) — never re-sorted
    expect(snap?.todos.map(t => t.content)).toEqual(['a', 'b', 'c'])
    expect(snap?.counts).toEqual({ total: 3, completed: 1, in_progress: 1, pending: 1, cancelled: 0 })
  })

  test('a malformed/empty todo call does not clobber a good prior snapshot', () => {
    const store = createSessionStore()
    store.apply(todoComplete([{ id: '0', content: 'keep', status: 'pending' }]))
    expect(store.state.latestTodos?.todos).toHaveLength(1)
    store.apply(todoComplete([]))
    expect(store.state.latestTodos?.todos).toEqual([{ content: 'keep', status: 'pending' }])
  })

  test('latestTodos clears on clearTranscript (/new starts a fresh plan)', () => {
    const store = createSessionStore()
    store.apply(todoComplete([{ id: '0', content: 'x', status: 'pending' }]))
    expect(store.state.latestTodos).toBeDefined()
    store.clearTranscript()
    expect(store.state.latestTodos).toBeUndefined()
  })

  test('composerDraft persists via setComposerDraft', () => {
    const store = createSessionStore()
    expect(store.state.composerDraft).toBe('')
    store.setComposerDraft('half-typed message')
    expect(store.state.composerDraft).toBe('half-typed message')
    store.setComposerDraft('')
    expect(store.state.composerDraft).toBe('')
  })

  test('clearComposerDraft advances the native-textarea clear signal', () => {
    const store = createSessionStore()
    store.setComposerDraft('half-typed message')
    const before = store.state.composerClearVersion

    store.clearComposerDraft()

    expect(store.state.composerDraft).toBe('')
    expect(store.state.composerClearVersion).toBe(before + 1)
  })

  test('replaceComposerDraft advances the native-textarea replacement signal', () => {
    const store = createSessionStore()
    const before = store.state.composerReplaceVersion
    store.replaceComposerDraft('edit and resubmit')
    expect(store.state.composerDraft).toBe('edit and resubmit')
    expect(store.state.composerReplaceVersion).toBe(before + 1)
  })

  test('prefill cancels queue edit without deleting the queued row', () => {
    const store = createSessionStore()
    store.enqueuePrompt('/queued command')
    store.setQueueEditIndex(0)
    store.replaceComposerDraft('extension prefill')
    expect(store.state.queueEditIndex).toBeUndefined()
    expect(store.state.queuedPrompts).toEqual(['/queued command'])
    expect(store.state.composerDraft).toBe('extension prefill')
  })

  test('session adoption advances the native clear signal', () => {
    const store = createSessionStore()
    store.setComposerDraft('old-session draft')
    const before = store.state.composerClearVersion
    store.adoptFreshSession('sid-2')
    expect(store.state.composerDraft).toBe('')
    expect(store.state.composerClearVersion).toBe(before + 1)
  })

  test('busy-input mode mirrors config and survives session-owned reset', () => {
    const store = createSessionStore()
    expect(store.state.busyInputMode).toBe('queue')
    store.setBusyInputMode('steer')
    store.adoptFreshSession('sid-2', {}, 'db-2')
    expect(store.state.busyInputMode).toBe('steer')
  })

  test('late config hydration cannot overwrite a newer /busy command', () => {
    const store = createSessionStore()
    const revision = store.getBusyInputModeRevision()
    store.setBusyInputMode('queue')
    expect(store.hydrateBusyInputMode('interrupt', revision)).toBe(false)
    expect(store.state.busyInputMode).toBe('queue')

    const current = store.getBusyInputModeRevision()
    expect(store.hydrateBusyInputMode('steer', current)).toBe(true)
    expect(store.state.busyInputMode).toBe('steer')
  })

  test('late compact hydration cannot overwrite a newer /compact command', () => {
    const store = createSessionStore()
    const revision = store.getCompactRevision()
    store.setCompact(true)
    expect(store.hydrateCompact(false, revision)).toBe(false)
    expect(store.state.compact).toBe(true)

    const current = store.getCompactRevision()
    expect(store.hydrateCompact(false, current)).toBe(true)
    expect(store.state.compact).toBe(false)
  })

  test('late details hydration cannot overwrite a newer /details command', () => {
    const store = createSessionStore()
    const revision = store.getDetailsRevision()
    store.setDetailSection('tools', 'hidden')
    expect(store.hydrateDetails('expanded', { activity: 'expanded' }, revision)).toBe(false)
    expect(store.state.detailsSections).toEqual({ tools: 'hidden' })

    const current = store.getDetailsRevision()
    expect(store.hydrateDetails('expanded', { activity: 'collapsed' }, current)).toBe(true)
    expect(store.state.details).toBe('expanded')
    expect(store.state.detailsCommandOverride).toBe(false)
    expect(store.state.detailsSections).toEqual({ activity: 'collapsed' })
  })

  test('lastUserMessage + trimLastExchange mirror Ink trailing-exchange semantics', () => {
    const store = createSessionStore()
    store.pushSystem('intro')
    store.pushUser('first')
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.complete', payload: { text: 'answer' } })
    expect(store.lastUserMessage()).toBe('first')
    expect(store.trimLastExchange()).toBe(2)
    expect(store.state.messages).toEqual([{ role: 'system', text: 'intro' }])
    expect(store.trimLastExchange()).toBe(0)
  })

  test('trimLastExchange removes the exchange through trailing local chrome', () => {
    const store = createSessionStore()
    store.pushUser('retry me')
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.complete', payload: { text: 'old answer' } })
    store.pushSystem('fortune output')
    store.pushNotification({ id: 'n1', kind: 'background', level: 'info', text: 'background complete' })
    expect(store.trimLastExchange()).toBe(2)
    expect(store.state.messages.map(message => [message.role, message.text])).toEqual([
      ['system', 'fortune output'],
      ['notification', 'background complete']
    ])
  })

  test('durable undo/retry ignore trailing local shell activity', () => {
    const store = createSessionStore()
    store.pushUser('model prompt')
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.complete', payload: { text: 'model answer' } })
    store.pushLocalUser('!ls', 'shell')
    store.pushSystem('file.txt')

    expect(store.lastUserMessage()).toBe('model prompt')
    expect(store.trimLastExchange()).toBe(2)
    expect(store.state.messages.map(message => [message.role, message.text, message.localOnly])).toEqual([
      ['user', '!ls', 'shell'],
      ['system', 'file.txt', undefined]
    ])
  })

  test('clearTranscript zeroes the usage gauges but keeps session identity', () => {
    const store = createSessionStore()
    store.applyInfo({
      model: 'm',
      cwd: '/x',
      usage: { context_used: 84000, context_percent: 42, cost_usd: 0.5, compressions: 2 }
    } as never)
    expect(store.state.info.contextUsed).toBe(84000)
    store.clearTranscript()
    expect(store.state.info.contextUsed).toBeUndefined()
    expect(store.state.info.contextPercent).toBeUndefined()
    expect(store.state.info.costUsd).toBeUndefined()
    expect(store.state.info.compressions).toBeUndefined()
    expect(store.state.info.model).toBe('m')
    expect(store.state.info.cwd).toBe('/x')
  })

  test('pending images survive same-session clear/recovery and reset on detach', () => {
    const store = createSessionStore()
    const first = store.addPendingImage({
      height: 10,
      path: '/tmp/first.png',
      token_estimate: 12,
      width: 20
    })
    expect(first).toMatchObject({ id: 1, path: '/tmp/first.png', token: '[Image #1]' })
    expect(store.addPendingImage({ path: '/tmp/first.png' })).toEqual(first)

    store.clearTranscript()
    expect(store.state.pendingImages).toHaveLength(1)

    store.commitSnapshot([])
    expect(store.state.pendingImages).toHaveLength(1)

    store.detachSession()
    expect(store.state.pendingImages).toEqual([])
  })
})
