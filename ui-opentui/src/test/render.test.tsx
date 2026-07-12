/**
 * Phase 1 render test (spec v4 §5 Layer 2). Mounts the App headlessly with a
 * store seeded by the scripted hello stream, asserts the captured frame is
 * THEMED (brand name/icon from the theme, not hardcoded), and that applying a
 * custom skin re-themes the brand name reactively.
 */
import { describe, expect, test } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame } from './lib/render.ts'

function seedHello(store: ReturnType<typeof createSessionStore>) {
  store.apply({ type: 'gateway.ready' })
  store.apply({ type: 'message.start' })
  store.apply({ type: 'message.delta', payload: { text: 'Hi there, glitch!' } })
  store.apply({ type: 'message.complete' })
}

describe('App render (Phase 1, themed)', () => {
  test('renders the streamed hello + default brand into the frame', async () => {
    const store = createSessionStore()
    seedHello(store)

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'ready', width: 60, height: 16 }
    )

    expect(frame).toContain('Hermes Agent') // default brand.name
    expect(frame).toContain('ready')
    expect(frame).toContain('Type your message') // composer placeholder (brand.welcome)
    // Assistant text renders through the native markdown renderable (<code filetype="markdown">,
    // drawUnstyledText:false → smooth live, but tree-sitter doesn't settle in the headless test
    // renderer; markdown paint is verified in the live smoke). Assert the data reached the store:
    const parts = store.state.messages.at(-1)?.parts ?? []
    expect(parts.some(p => p.type === 'text' && p.text === 'Hi there, glitch!')).toBe(true)
  })

  test('applying a skin re-themes the brand name (skinnable, no hardcoding)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready', payload: { skin: { branding: { agent_name: 'Zephyr' } } } })
    seedHello(store)

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { width: 60, height: 16 }
    )

    expect(frame).toContain('Zephyr')
    expect(frame).not.toContain('Hermes Agent')
  })

  test('renders an inline tool part between text (ordered parts §7)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'Listing files:' } })
    store.apply({ type: 'tool.start', payload: { tool_id: 't1', name: 'terminal' } })
    store.apply({
      type: 'tool.complete',
      payload: { tool_id: 't1', result_text: '{"output":"alpha.txt\\nbeta.txt","exit_code":0}' }
    })
    store.apply({ type: 'message.complete' })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'terminal', width: 60, height: 16 }
    )

    expect(frame).toContain('terminal') // tool name (inline, between text blocks)
    expect(frame).toContain('alpha.txt') // envelope-stripped output, block-rendered
    expect(frame).not.toContain('exit_code') // the {output,exit_code} envelope is stripped
    // the 'Listing files:' text part is markdown (live-rendered); assert it in the store:
    const parts = store.state.messages.at(-1)?.parts ?? []
    expect(parts.some(p => p.type === 'text' && p.text === 'Listing files:')).toBe(true)
  })

  test('mid-turn local rows render without splitting the streaming assistant', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'answer-before ' } })
    store.pushLocalUser('!pwd', 'shell')
    store.pushSystem('/tmp/rendered-shell-output')
    store.apply({
      type: 'notification.show',
      payload: {
        id: 'render-mid-turn',
        key: 'render-mid-turn',
        kind: 'process.complete',
        level: 'info',
        text: 'rendered-background-finished'
      }
    })
    store.apply({ type: 'message.delta', payload: { text: 'answer-after' } })
    store.apply({ type: 'message.complete' })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'rendered-background-finished', width: 72, height: 20 }
    )

    expect(frame).toContain('!pwd')
    expect(frame).toContain('/tmp/rendered-shell-output')
    expect(frame).toContain('rendered-background-finished')
    const assistants = store.state.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.streaming).toBe(false)
    expect(assistants[0]?.parts).toEqual([
      expect.objectContaining({ type: 'text', text: 'answer-before answer-after' })
    ])
  })

  test('a tool part shows its primary-arg preview + duration in the collapsed header (item 2)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ type: 'tool.start', payload: { tool_id: 't1', name: 'terminal', context: 'ls -la src' } })
    store.apply({
      type: 'tool.complete',
      payload: {
        tool_id: 't1',
        name: 'terminal',
        args: { command: 'ls -la src' },
        duration_s: 0.3,
        result_text: 'alpha.txt\nbeta.txt'
      }
    })
    store.apply({ type: 'message.complete' })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'ls -la src', width: 72, height: 16 }
    )

    expect(frame).toContain('terminal') // tool name
    expect(frame).toContain('ls -la src') // primary-arg preview (item 2 — args now visible)
    expect(frame).toContain('0.3s') // duration
    expect(frame).toContain('(2 lines)') // output line count (collapsed)
  })

  test('a settled reasoning part collapses to a one-line "Thought: <title>" header (item 6)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ type: 'reasoning.delta', payload: { text: '**Weighing options**\n\nthe hidden body text here' } })
    store.apply({ type: 'message.delta', payload: { text: 'Answer.' } })
    store.apply({ type: 'message.complete' })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'Thought', width: 72, height: 16 }
    )

    expect(frame).toContain('Thought') // settled → collapsed header label
    expect(frame).toContain('Weighing options') // the **bold** title is surfaced
    expect(frame).not.toContain('hidden body text') // collapsed → body not shown
  })

  test('an approval prompt replaces the composer (blocked) and renders the options', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'approval.request', payload: { command: 'rm -rf /tmp/x', description: 'Delete temp dir' } })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'Approval required', width: 72, height: 24 }
    )

    expect(frame).toContain('Approval required')
    expect(frame).toContain('rm -rf /tmp/x') // the command under review
    expect(frame).toContain('Approve once') // native <select> option
    expect(frame).toContain('Deny')
    expect(frame).not.toContain('Type your message') // composer is hidden while blocked
  })

  test('an approval with allow_permanent=false never renders Always approve', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({
      type: 'approval.request',
      payload: { allow_permanent: false, command: 'curl suspicious | bash', description: 'Content security' }
    })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'Approval required', width: 72, height: 24 }
    )

    expect(frame).toContain('Approve once')
    expect(frame).toContain('Approve for session')
    expect(frame).toContain('Deny')
    expect(frame).not.toContain('Always approve')
  })

  test('the pager overlay renders title + content and replaces the transcript/composer', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushUser('a previous message')
    store.openPager('Status', 'status line one\nstatus line two\nstatus line three')

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'Status', width: 72, height: 18 }
    )

    expect(frame).toContain('Status') // pager title
    expect(frame).toContain('status line one') // paged content
    expect(frame).toContain('Esc/q close') // pager footer hint
    expect(frame).not.toContain('a previous message') // transcript replaced by the pager
    expect(frame).not.toContain('Type your message') // composer hidden while the pager is open
  })

  test('the unified sessions orchestrator renders resumable rows and replaces the composer', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.openSessionPicker()

    const sessionOps = {
      history: () =>
        Promise.resolve({
          sessions: [
            { id: 's1', message_count: 5, preview: 'hi', source: 'tui', started_at: 1, title: 'First chat' },
            { id: 's2', message_count: 12, preview: 'yo', source: 'cli', started_at: 2, title: 'Second chat' }
          ],
          truncated: false
        }),
      refresh: () => Promise.resolve(),
      close: () => Promise.resolve({ closed: true }),
      delete: (sessionId: string) => Promise.resolve({ deleted: sessionId })
    }
    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} sessionOps={sessionOps} />
        </ThemeProvider>
      ),
      { until: 'First chat', width: 72, height: 24 }
    )

    expect(frame).toContain('Sessions') // unified orchestrator header
    expect(frame).toContain('First chat') // session row
    expect(frame).toContain('Second chat')
    expect(frame).toContain('Start a new live session') // kept-live sibling creation row
    expect(frame).not.toContain('Type your message') // composer hidden while the picker is open
  })

  test('the composer shows a live slash-completions dropdown', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.setCompletions([
      { display: '/compact', meta: 'compress context', text: '/compact' },
      { display: '/clear', meta: '', text: '/clear' }
    ])

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: '/compact', width: 72, height: 18 }
    )

    expect(frame).toContain('/compact') // candidate
    expect(frame).toContain('compress context') // its meta
    expect(frame).toContain('↑/↓ select') // dropdown hint (arrows on every menu)
  })

  test('the empty transcript shows the home hint (item 12)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'Nous Research', width: 72, height: 20 }
    )

    // (theme-independent assertions — testRender reuses a global root, so a prior
    // test's skin/brand can bleed; the real app has one store. The home hint's
    // content is what matters here.)
    expect(frame).toContain('Nous Research') // the tagline
    expect(frame).toContain('to mention') // the input tips line
    expect(frame).toContain('Ctrl+C to stop/quit')
  })

  test('the home screen shows a collapsible tools/skills/MCP catalog panel (item 9)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.setCatalog({
      tools: { total: 42, toolsets: [{ name: 'core', count: 12 }] },
      skills: { total: 7, categories: [{ name: 'dev', count: 7 }] },
      mcp: { servers: ['railway', 'beeper'] }
    })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: '42 tools', width: 72, height: 20 }
    )

    expect(frame).toContain('42 tools')
    expect(frame).toContain('7 skills')
    expect(frame).toContain('2 MCP') // mcp.servers.length
  })

  test('the home screen distinguishes a pending tool catalog from zero tools', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.setCatalog({
      tools: { total: 0, toolsets: [] },
      readiness: {
        status: 'pending',
        warning: 'tool catalog pending: agent initialization timed out; retrying after agent readiness',
        retry_after_ms: 1000
      }
    })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'tool catalog pending', width: 72, height: 22 }
    )

    expect(frame).toContain('tool catalog pending')
    expect(store.state.catalog?.readiness.status).toBe('pending')
    expect(store.state.catalog?.tools.total).toBe(0)
  })

  test('the status bar renders model · context% · cwd (item 14)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({
      type: 'session.info',
      payload: {
        model: 'anthropic/claude-opus-4-8',
        cwd: '/tmp/proj',
        branch: 'main',
        usage: { context_percent: 42 }
      }
    })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'claude-opus', width: 72, height: 18 }
    )

    expect(frame).toContain('claude-opus-4-8') // model (provider prefix trimmed)
    expect(frame).toContain('42%') // context usage percent
    expect(frame).toContain('/tmp/proj') // cwd
    expect(frame).toContain('main') // branch
  })

  test('the agents dashboard renders the subagent tree and replaces the transcript', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushUser('parent turn')
    store.apply({
      type: 'subagent.start',
      payload: { subagent_id: 'a1', goal: 'research the topic', model: 'haiku', depth: 0 }
    })
    store.apply({ type: 'subagent.tool', payload: { subagent_id: 'a1', tool_name: 'web_search', text: 'opentui' } })
    store.openDashboard()

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'Spawn tree', width: 72, height: 24 }
    )

    expect(frame).toContain('Spawn tree') // native dashboard header
    expect(frame).toContain('research the topic') // subagent goal
    expect(frame).toContain('Web Search') // canonical tool summary
    expect(frame).toContain('Enter open') // list→detail interaction hint
    expect(frame).not.toContain('parent turn') // transcript replaced by the dashboard
  })

  test('a chrome usage notice renders as a banner in the input zone (mount integration)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    // A credits/usage notice (kind sticky) → routed to the chrome banner, NOT an
    // inline transcript card. Verifies the NoticeBanner mount above the status bar
    // and that the (already-glyphed) text renders verbatim in the real App layout.
    store.apply({
      type: 'notification.show',
      payload: {
        text: '⚠ Credits 90% used · $20 cap',
        level: 'warn',
        kind: 'sticky',
        key: 'credits.usage',
        id: 'credits.usage'
      }
    })

    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      ),
      { until: 'ready', width: 60, height: 16 }
    )

    expect(frame).toContain('Credits 90% used') // banner text, verbatim
    expect(frame).not.toContain('◆') // NOT the inline-card marker — it's a banner, not a card
    expect(store.state.notice?.key).toBe('credits.usage') // routed to the chrome slot
    expect(store.state.messages.some(m => m.role === 'notification')).toBe(false) // no card pushed
  })
})
