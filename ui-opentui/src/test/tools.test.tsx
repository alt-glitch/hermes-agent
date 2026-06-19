/**
 * Tool renderer tests (Epics 2.2 + 2.4). Headless frames through the real App
 * tree: the registry's default renderer turns args into LABELED FIELDS — the
 * acceptance gate asserts NO raw JSON syntax (`{"` / `":`) ever reaches the
 * frame for tool parts, collapsed or expanded — delegate_task carries the
 * Ink-parity "(/agents to monitor)" hint, and the bash renderer shows the
 * command verbatim collapsed + the FULL output expanded (uncapped by default;
 * HERMES_TUI_TOOL_OUTPUT_LINES restores a cap).
 * Expansion goes through the REAL mouse path: mockMouse clicks the header row
 * (found by scanning the frame). The long-output cap is asserted at the Body
 * level (a tall frame would otherwise hide the trailing note).
 */
import { describe, expect, test, vi } from 'vitest'

import { createSessionStore, type ToolPartState } from '../logic/store.ts'
import { DEFAULT_THEME } from '../logic/theme.ts'
import { App } from '../view/App.tsx'
import { reasoningLabelStyle } from '../view/reasoningPart.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { toolNameStyle } from '../view/toolPart.tsx'
import { BashToolBody, commandFitsHeader, commandOf } from '../view/tools/bashTool.tsx'
import { diffOutputPlan, FileToolBody } from '../view/tools/fileTool.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

type Store = ReturnType<typeof createSessionStore>

/** Seed a settled assistant turn containing exactly the given tool call. */
function seedTool(store: Store, start: Record<string, unknown>, complete: Record<string, unknown>) {
  store.apply({ type: 'gateway.ready' })
  store.apply({ type: 'message.start' })
  store.apply({ type: 'tool.start', payload: start })
  store.apply({ type: 'tool.complete', payload: complete })
  store.apply({ type: 'message.complete' })
}

async function mountApp(store: Store, width = 80, height = 24): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} />
      </ThemeProvider>
    ),
    { width, height }
  )
}

/** Click the tool header row (the line containing `name`) to expand/collapse. */
async function clickHeader(probe: RenderProbe, name: string): Promise<void> {
  const frame = await probe.waitForFrame(f => f.includes(name))
  const rows = frame.split('\n')
  const y = rows.findIndex(line => line.includes(name))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = (rows[y] ?? '').indexOf(name)
  await probe.click(x, y)
}

describe('tool renderer registry — labeled-args default (Epic 2.2)', () => {
  test('an unmapped MCP-ish tool with nested args renders labeled fields, never raw JSON', async () => {
    const store = createSessionStore()
    seedTool(
      store,
      { tool_id: 'm1', name: 'mcp_lookup' },
      {
        tool_id: 'm1',
        name: 'mcp_lookup',
        args: {
          query: 'hermes agent',
          options: { depth: 2, mode: 'fast', cache: true },
          limit: 5
        },
        duration_s: 0.4,
        result_text: 'one result found'
      }
    )

    const probe = await mountApp(store)
    try {
      // collapsed: header only, and already no JSON syntax anywhere
      const collapsed = await probe.waitForFrame(f => f.includes('mcp_lookup'))
      expect(collapsed).not.toContain('{"')
      expect(collapsed).not.toContain('":')

      await clickHeader(probe, 'mcp_lookup')
      const expanded = await probe.waitForFrame(f => f.includes('query'))
      // labeled key → value rows (string verbatim, number via String)
      expect(expanded).toContain('query')
      expect(expanded).toContain('hermes agent')
      expect(expanded).toContain('limit')
      expect(expanded).toContain('5')
      // nested object summarized, not dumped
      expect(expanded).toContain('options')
      expect(expanded).toContain('(3 fields)')
      // the output body still renders (envelope-stripped store text)
      expect(expanded).toContain('one result found')
      // THE acceptance gate: no raw JSON syntax in the tool render
      expect(expanded).not.toContain('{"')
      expect(expanded).not.toContain('":')
      expect(expanded).not.toContain('depth') // nested internals stay summarized
    } finally {
      probe.destroy()
    }
  })

  test('delegate_task gets the default renderer plus the muted "(/agents to monitor)" hint', async () => {
    const store = createSessionStore()
    seedTool(
      store,
      { tool_id: 'd1', name: 'delegate_task', context: 'research opentui' },
      {
        tool_id: 'd1',
        name: 'delegate_task',
        args: { goal: 'research opentui', model: 'fast' },
        result_text: 'spawned'
      }
    )

    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('(/agents to monitor)'))
      expect(frame).toContain('delegate_task')
      expect(frame).toContain('research opentui') // primary-arg preview still leads
      expect(frame).not.toContain('{"') // hint or not — still no raw JSON
    } finally {
      probe.destroy()
    }
  })
})

describe('bash tool renderer — command + full output (Epic 2.4)', () => {
  test('collapsed header shows the invoked command VERBATIM (args win over the gateway preview)', async () => {
    const store = createSessionStore()
    seedTool(
      store,
      // the gateway's one-line preview is truncated — args.command is the truth
      { tool_id: 'b1', name: 'terminal', context: 'grep -rn needle' },
      {
        tool_id: 'b1',
        name: 'terminal',
        args: { command: 'grep -rn needle src/ | head -5', timeout: 60 },
        duration_s: 0.2,
        result_text: 'a.ts:1:needle\nb.ts:2:needle\nc.ts:3:needle'
      }
    )

    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('grep -rn needle src/ | head -5'))
      expect(frame).toContain('terminal')
      expect(frame).toContain('grep -rn needle src/ | head -5') // verbatim, not the preview
      expect(frame).toContain('(3 lines)') // output stays behind the expand affordance
      expect(frame).not.toContain('a.ts:1:needle') // collapsed → no output shown
    } finally {
      probe.destroy()
    }
  })

  test('one-liner that fits the header: expanded body SKIPS the $ echo — just the output (item 3)', async () => {
    const store = createSessionStore()
    seedTool(
      store,
      { tool_id: 'b2', name: 'terminal' },
      {
        tool_id: 'b2',
        name: 'terminal',
        args: { command: 'ls' },
        result_text: 'alpha.txt\nbeta.txt\ngamma.txt'
      }
    )

    const probe = await mountApp(store)
    try {
      await clickHeader(probe, 'terminal')
      const expanded = await probe.waitForFrame(f => f.includes('alpha.txt'))
      expect(expanded).toContain('ls') // the command stays visible — in the HEADER
      expect(expanded).not.toContain('$ ls') // …so the body does NOT echo it (item 3)
      expect(expanded).not.toContain('output') // no section label without an echo above it
      expect(expanded).toContain('alpha.txt') // full output…
      expect(expanded).toContain('beta.txt')
      expect(expanded).toContain('gamma.txt') // …down to the last line
    } finally {
      probe.destroy()
    }
  })

  test('multi-line command: expanded body KEEPS the $ echo (the header could not show it)', async () => {
    const store = createSessionStore()
    seedTool(
      store,
      { tool_id: 'b2m', name: 'terminal' },
      {
        tool_id: 'b2m',
        name: 'terminal',
        args: { command: 'for f in *.txt; do\n  wc -l "$f"\ndone' },
        result_text: '3 alpha.txt'
      }
    )

    const probe = await mountApp(store)
    try {
      await clickHeader(probe, 'terminal')
      const expanded = await probe.waitForFrame(f => f.includes('3 alpha.txt'))
      expect(expanded).toContain('$ for f in *.txt; do') // first command line, prompt-prefixed
      expect(expanded).toContain('wc -l "$f"') // continuation line
      expect(expanded).toContain('output') // section label separates echo from output
      expect(expanded).toContain('3 alpha.txt')
    } finally {
      probe.destroy()
    }
  })

  test('commandFitsHeader: single-line within width fits; truncated / multi-line / failed do not', () => {
    const part = (over: Partial<ToolPartState>): ToolPartState => ({
      type: 'tool',
      id: 'cf',
      name: 'terminal',
      state: 'complete',
      ...over
    })
    // header columns = width - name.length (see view/toolPart.tsx subWidth math)
    expect(commandFitsHeader(part({ args: { command: 'ls -la' } }), 40)).toBe(true)
    expect(commandFitsHeader(part({ args: { command: 'x'.repeat(40) } }), 40)).toBe(false) // truncated
    expect(commandFitsHeader(part({ args: { command: 'a\nb' } }), 40)).toBe(false) // multi-line
    // a failed header shows the ERROR, not the command → body must echo it
    expect(commandFitsHeader(part({ args: { command: 'false' }, error: 'exit 1' }), 40)).toBe(false)
  })

  test('long output with an explicit =200 cap restored gets the honest "+N more lines" note', async () => {
    // Output is UNCAPPED by default now — restore the old 200-line cap explicitly.
    const prev = process.env.HERMES_TUI_TOOL_OUTPUT_LINES
    process.env.HERMES_TUI_TOOL_OUTPUT_LINES = '200'
    const lines = Array.from({ length: 250 }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`)
    const part: ToolPartState = {
      type: 'tool',
      id: 'b3',
      name: 'execute_code',
      state: 'complete',
      args: { code: 'for i in range(250): print(i)' },
      resultText: lines.join('\n')
    }
    // Body-level mount (tall frame so the trailing note row is on screen).
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <BashToolBody part={part} width={70} />
        </ThemeProvider>
      ),
      { width: 80, height: 210 }
    )
    try {
      const frame = await probe.waitForFrame(f => f.includes('+50 more lines'))
      expect(frame).toContain('line-001') // the cap keeps the HEAD of the output
      expect(frame).toContain('line-200') // …up to the restored cap
      expect(frame).not.toContain('line-201') // the rest is honestly elided
      expect(frame).toContain('… +50 more lines')
    } finally {
      probe.destroy()
      if (prev === undefined) delete process.env.HERMES_TUI_TOOL_OUTPUT_LINES
      else process.env.HERMES_TUI_TOOL_OUTPUT_LINES = prev
    }
  })

  test('a gateway-capped result renders the tidy omitted note', async () => {
    const part: ToolPartState = {
      type: 'tool',
      id: 'b4',
      name: 'terminal',
      state: 'complete',
      args: { command: 'cat big.log' },
      resultText: 'tail line one\ntail line two',
      omittedNote: '120 lines / 9001 chars'
    }
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <BashToolBody part={part} width={70} />
        </ThemeProvider>
      ),
      { width: 80, height: 12 }
    )
    try {
      const frame = await probe.waitForFrame(f => f.includes('omitted'))
      expect(frame).toContain('tail line one')
      expect(frame).toContain('… omitted 120 lines / 9001 chars')
    } finally {
      probe.destroy()
    }
  })
})

describe('file tool renderer — relative path + diff stats (Epic 2.3)', () => {
  // NOTE: the EXPANDED native <diff> is deliberately untested here — like
  // <markdown> it tokenizes via Tree-sitter ASYNCHRONOUSLY and may not settle
  // in the headless renderer. The diff visuals belong to the live smoke; these
  // tests pin the LOGIC surface (collapsed header, fallback body).
  const DIFF = ['--- a/src/main.ts', '+++ b/src/main.ts', '@@ -1,3 +1,4 @@', ' ctx', '-old', '+new', '+more'].join('\n')

  test('collapsed write_file shows the cwd-RELATIVE path and the themed +N −M stats', async () => {
    const store = createSessionStore()
    store.apply({ type: 'session.info', payload: { cwd: '/home/u/proj' } })
    seedTool(
      store,
      { tool_id: 'f1', name: 'write_file', context: '/home/u/proj/src/main.ts' },
      {
        tool_id: 'f1',
        name: 'write_file',
        args: { path: '/home/u/proj/src/main.ts', content: 'new\nmore\n' },
        diff_unified: DIFF + '\n',
        duration_s: 0.1,
        result: '{"success": true}'
      }
    )

    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('write_file'))
      expect(frame).toContain('src/main.ts') // relative to the session cwd…
      expect(frame).not.toContain('/home/u/proj/src/main.ts') // …never absolute
      expect(frame).toContain('+2') // added (excludes the +++ header)
      expect(frame).toContain('−1') // removed (excludes the --- header)
    } finally {
      probe.destroy()
    }
  })

  test('read_file: relpath subtitle; expanded = CONTENT only — limit/offset suppressed (items 1+7)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'session.info', payload: { cwd: '/home/u/proj' } })
    seedTool(
      store,
      { tool_id: 'f2', name: 'read_file' },
      {
        tool_id: 'f2',
        name: 'read_file',
        args: { limit: 50, offset: 1, path: '/home/u/proj/notes.py' },
        // REAL wire shape (v6fix capture): a dict result whose `content`
        // carries the `N|`-prefixed lines; result_text mirrors it as JSON.
        result: { content: '1|# Notes\n2|hello = 1', file_size: 18, total_lines: 2, truncated: false },
        result_text: '{"content": "1|# Notes\\n2|hello = 1", "total_lines": 2, "file_size": 18, "truncated": false}'
      }
    )

    const probe = await mountApp(store)
    try {
      const collapsed = await probe.waitForFrame(f => f.includes('read_file'))
      expect(collapsed).toContain('notes.py') // relpath subtitle
      expect(collapsed).not.toContain('+0') // no diff → no stats summary
      expect(collapsed).toContain('(2 lines)') // honest count: the CONTENT lines

      await clickHeader(probe, 'read_file')
      const expanded = await probe.waitForFrame(f => f.includes('# Notes'))
      expect(expanded).toContain('# Notes') // the content, through the native <code>
      expect(expanded).toContain('hello = 1')
      expect(expanded).not.toContain('1|') // line-number prefixes stripped
      expect(expanded).not.toContain('limit') // noise arg-fields suppressed…
      expect(expanded).not.toContain('offset')
      expect(expanded).not.toContain('50')
      expect(expanded).not.toContain('total_lines') // …and never the JSON envelope
      expect(expanded).not.toContain('{"')
      expect(expanded).not.toContain('@@') // never a diff
    } finally {
      probe.destroy()
    }
  })

  test('store: tool.complete diff_unified lands on the part with computed stats', () => {
    const store = createSessionStore()
    seedTool(
      store,
      { tool_id: 'f3', name: 'patch' },
      {
        tool_id: 'f3',
        name: 'patch',
        args: { mode: 'replace', path: 'x.py' },
        diff_unified: DIFF
      }
    )
    const last = store.state.messages[store.state.messages.length - 1]
    const part = last?.parts?.find((p): p is ToolPartState => p.type === 'tool' && p.id === 'f3')
    expect(part?.diffUnified).toBe(DIFF)
    expect(part?.diffStats).toEqual({ added: 2, removed: 1 })
  })
})

describe('store: HERMES_TUI_TOOL_OUTPUTS flag (W3 — retention asymmetry lever)', () => {
  const DIFF = ['--- a/x.py', '+++ b/x.py', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n')
  const findTool = (store: Store, id: string) => {
    const last = store.state.messages[store.state.messages.length - 1]
    return last?.parts?.find((p): p is ToolPartState => p.type === 'tool' && p.id === id)
  }
  const complete = {
    tool_id: 't1',
    name: 'terminal',
    args: { command: 'ls -la' },
    result_text: 'file-a\nfile-b\nfile-c',
    duration_s: 0.4,
    diff_unified: DIFF
  }

  test('default (ON): rich outputs are retained', () => {
    const prev = process.env.HERMES_TUI_TOOL_OUTPUTS
    delete process.env.HERMES_TUI_TOOL_OUTPUTS
    try {
      const store = createSessionStore()
      seedTool(store, { tool_id: 't1', name: 'terminal', context: 'ls -la' }, complete)
      const part = findTool(store, 't1')
      expect(part?.resultText).toBe('file-a\nfile-b\nfile-c')
      expect(part?.lineCount).toBe(3)
      expect(part?.args).toEqual({ command: 'ls -la' })
      expect(part?.argsText).toContain('command')
    } finally {
      if (prev === undefined) delete process.env.HERMES_TUI_TOOL_OUTPUTS
      else process.env.HERMES_TUI_TOOL_OUTPUTS = prev
    }
  })

  test('OFF: result body + raw result/args are dropped; name/duration/error/diff are kept', () => {
    const prev = process.env.HERMES_TUI_TOOL_OUTPUTS
    process.env.HERMES_TUI_TOOL_OUTPUTS = 'off'
    try {
      const store = createSessionStore()
      seedTool(store, { tool_id: 't1', name: 'terminal', context: 'ls -la' }, { ...complete, error: 'boom' })
      const part = findTool(store, 't1')
      // suppressed (the memory lever)
      expect(part?.resultText).toBeUndefined()
      expect(part?.result).toBeUndefined()
      expect(part?.args).toBeUndefined()
      expect(part?.argsText).toBeUndefined()
      expect(part?.lineCount).toBeUndefined()
      expect(part?.omittedNote).toBeUndefined()
      // kept either way
      expect(part?.name).toBe('terminal')
      expect(part?.state).toBe('complete')
      expect(part?.duration).toBe(0.4)
      expect(part?.error).toBe('boom')
      expect(part?.argsPreview).toBe('ls -la') // from tool.start context — the Ink-parity one-liner
      // the file-edit diff is a high-value surface, not generic output — KEPT
      expect(part?.diffUnified).toBe(DIFF)
      expect(part?.diffStats).toEqual({ added: 1, removed: 1 })
    } finally {
      if (prev === undefined) delete process.env.HERMES_TUI_TOOL_OUTPUTS
      else process.env.HERMES_TUI_TOOL_OUTPUTS = prev
    }
  })
})

describe('file tool — output suppression under a rendered diff (no raw JSON, ever)', () => {
  // A file-edit result is a JSON record whose payload IS the diff. In a verbose
  // session the gateway REDACTS + CAPS result_text, so it can arrive truncated
  // mid-JSON (unparseable) — that JSON-looking blob must never render below the
  // native diff. Plain-text results (lint tails etc.) must still render.
  const DIFF = ['--- a/x.py', '+++ b/x.py', '@@ -1,2 +1,2 @@', ' ctx', '-old', '+new'].join('\n')

  const part = (resultText: string): ToolPartState => ({
    type: 'tool',
    id: 'fp1',
    name: 'patch',
    state: 'complete',
    args: { path: '/p/x.py' },
    resultText,
    diffUnified: DIFF,
    diffStats: { added: 1, removed: 1 }
  })

  test('diffOutputPlan: truncated/unparseable JSON is suppressed; plain text renders; JSON warnings surface', () => {
    // gateway-capped mid-JSON (unparseable, still contains "diff") → suppress
    const capped = '{"success": true, "diff": "--- a/x.py\\n+++ b/x.py\\n@@ -1,2 +1'
    expect(diffOutputPlan(part(capped))).toEqual({ kind: 'suppress' })
    // intact JSON echo of the diff → suppress
    expect(diffOutputPlan(part(JSON.stringify({ success: true, diff: DIFF })))).toEqual({ kind: 'suppress' })
    // plain text (lint tail) → full output block
    expect(diffOutputPlan(part('warning: trailing whitespace on line 3'))).toEqual({ kind: 'output' })
    // parseable JSON carrying real non-diff signal → just the notes
    expect(diffOutputPlan(part(JSON.stringify({ success: true, diff: DIFF, warning: 'mode fallback' })))).toEqual({
      kind: 'notes',
      notes: [['warning', 'mode fallback']]
    })
  })

  test('diffOutputPlan: tail-capped echo that LOST the JSON head (normalized to diff lines) is suppressed', () => {
    // A long file-edit JSON tail-capped past its `{"success"…` head: the store
    // un-escapes the literal \n so it arrives as plain lines that ARE diff
    // lines (first/last cut mid-line) — live bug shape from the v6 smoke.
    const tallDiff = [
      '--- a/x.py',
      '+++ b/x.py',
      '@@ -1,1 +1,9 @@',
      ' ctx',
      ...Array.from({ length: 8 }, (_, i) => `+def fn_${i}() -> int: return ${i}`)
    ].join('\n')
    const echoTail = [
      'n 1', // cut mid-line
      ...Array.from({ length: 6 }, (_, i) => `+def fn_${i + 2}() -> int: return ${i + 2}`),
      '", "files_modified": ["/p/x.py' // cut mid-JSON
    ].join('\n')
    expect(diffOutputPlan({ ...part(echoTail), diffUnified: tallDiff })).toEqual({ kind: 'suppress' })
    // …but a genuine plain-text tail sharing no lines with the diff still renders
    const lintTail = ['x.py:3: W291 trailing whitespace', 'x.py:9: E302 expected 2 blank lines', '2 warnings'].join(
      '\n'
    )
    expect(diffOutputPlan({ ...part(lintTail), diffUnified: tallDiff })).toEqual({ kind: 'output' })
  })

  test('TRUNCATED JSON result under a rendered diff → NO output block in the frame', async () => {
    const capped = '{"success": true, "diff": "--- a/x.py\\n+++ b/x.py\\n@@ -1,2 +1'
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <FileToolBody part={part(capped)} width={70} />
        </ThemeProvider>
      ),
      { width: 80, height: 16 }
    )
    try {
      // wait for the native <diff> to paint (Tree-sitter settles async)
      const frame = await probe.waitForFrame(f => f.includes('new'))
      expect(frame).not.toContain('output') // no output section label
      expect(frame).not.toContain('{"') // and never raw JSON
      expect(frame).not.toContain('success')
    } finally {
      probe.destroy()
    }
  })

  test('plain-text result under a rendered diff → output block still shown', async () => {
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <FileToolBody part={part('warning: trailing whitespace on line 3')} width={70} />
        </ThemeProvider>
      ),
      { width: 80, height: 16 }
    )
    try {
      const frame = await probe.waitForFrame(f => f.includes('trailing whitespace'))
      expect(frame).toContain('output') // labeled output section
      expect(frame).toContain('warning: trailing whitespace on line 3')
    } finally {
      probe.destroy()
    }
  })

  test('V4A hunk-less add-file diff RENDERS as a diff (not the raw-params fallback)', async () => {
    // The bug: a V4A (mode='patch') add-file diff has --- /dev/null + +++ b/<path>
    // and `+` body lines but NO `@@` header, so splitUnifiedDiff used to drop it
    // and the card fell back to labeled params. Now splitUnifiedDiff synthesizes
    // a hunk header; assert the new-file CONTENT paints through the native <diff>.
    const v4aAdd = ['--- /dev/null', '+++ b/notes.md', '+# Release Notes', '+', '+- shipped the thing'].join('\n')
    const addPart: ToolPartState = {
      type: 'tool',
      id: 'v4a1',
      name: 'patch',
      state: 'complete',
      args: { path: '/p/notes.md' },
      // a typical V4A result_text is the JSON echo of the diff → suppressed below it
      resultText: JSON.stringify({ success: true, diff: v4aAdd }),
      diffUnified: v4aAdd,
      diffStats: { added: 3, removed: 0 }
    }
    const probe = await renderProbe(
      () => (
        <ThemeProvider>
          <FileToolBody part={addPart} width={70} />
        </ThemeProvider>
      ),
      { width: 80, height: 16 }
    )
    try {
      // the native <diff> must paint the added content (proves the synthesized
      // @@ header parsed) — pre-fix this frame showed `old_string`/`path` params.
      const frame = await probe.waitForFrame(f => f.includes('Release Notes'))
      expect(frame).toContain('Release Notes')
      expect(frame).toContain('shipped the thing')
      expect(frame).not.toContain('old_string') // never the raw-params fallback
      expect(frame).not.toContain('{"') // and never the raw JSON echo
    } finally {
      probe.destroy()
    }
  })
})

describe('tool lifecycle states — running / done / failed (Epic 2.5)', () => {
  // Fake ONLY setInterval/clearInterval/Date: the shared elapsed tick + the
  // Date.now() it invalidates. setTimeout/microtasks stay REAL — the test
  // renderer's settle dance (flush/waitForFrame) depends on them, and the
  // render scheduler itself times via performance.now (unfaked).
  const FAKED = ['setInterval', 'clearInterval', 'Date'] as const

  test('store: tool.start stamps startedAt; tool.complete settles the gateway duration', () => {
    vi.useFakeTimers({ toFake: [...FAKED] })
    try {
      vi.setSystemTime(1_750_000_000_000)
      const store = createSessionStore()
      store.apply({ type: 'gateway.ready' })
      store.apply({ type: 'message.start' })
      store.apply({ type: 'tool.start', payload: { tool_id: 'l1', name: 'terminal', context: 'sleep 8' } })
      const live = store.state.messages[store.state.messages.length - 1]
      const part = live?.parts?.find((p): p is ToolPartState => p.type === 'tool' && p.id === 'l1')
      expect(part?.startedAt).toBe(1_750_000_000_000)
      expect(part?.state).toBe('running')
      // the gateway's duration_s remains the settled truth, startedAt untouched
      store.apply({ type: 'tool.complete', payload: { tool_id: 'l1', name: 'terminal', duration_s: 8.2 } })
      expect(part?.state).toBe('complete')
      expect(part?.duration).toBe(8.2)
      expect(part?.startedAt).toBe(1_750_000_000_000)
    } finally {
      vi.useRealTimers()
    }
  })

  test('store: part.error comes ONLY from payload.error (gateway owns the result convention)', () => {
    // The gateway derives failure from the result convention server-side
    // (tui_gateway _tool_error_from_result) and ships payload.error; the
    // client must NOT sniff results itself (false positives on tools whose
    // legitimate output embeds an "error" key — review finding, Epic 2.5).
    const store = createSessionStore()
    seedTool(
      store,
      { tool_id: 'l2', name: 'read_file' },
      { tool_id: 'l2', name: 'read_file', error: 'File not found: /nope.txt' }
    )
    const last = store.state.messages[store.state.messages.length - 1]
    const part = last?.parts?.find((p): p is ToolPartState => p.type === 'tool' && p.id === 'l2')
    expect(part?.error).toBe('File not found: /nope.txt')
    // a result that EMBEDS an error key, without payload.error, stays un-failed
    seedTool(
      store,
      { tool_id: 'l3', name: 'web_search' },
      { tool_id: 'l3', name: 'web_search', result: { results: [1], error: 'some shards failed' } }
    )
    const part3 = store.state.messages[store.state.messages.length - 1]?.parts?.find(
      (p): p is ToolPartState => p.type === 'tool' && p.id === 'l3'
    )
    expect(part3?.error).toBeUndefined()
  })

  test('running tool shows ⚡ + a LIVE elapsed that advances with the clock — and no expand glyph', async () => {
    vi.useFakeTimers({ toFake: [...FAKED] })
    try {
      const store = createSessionStore()
      store.apply({ type: 'gateway.ready' })
      store.apply({ type: 'message.start' })
      store.apply({ type: 'tool.start', payload: { tool_id: 'r1', name: 'terminal', context: 'sleep 8' } })

      const probe = await mountApp(store)
      try {
        const f0 = await probe.waitForFrame(f => f.includes('terminal'))
        expect(f0).toContain('⚡') // running head glyph
        expect(f0).toContain('sleep 8') // subtitle shows while running
        expect(f0).toContain('· 0s') // elapsed starts at zero
        expect(f0).not.toContain('▶') // NO expand affordance while running
        expect(f0).not.toContain('▼')

        vi.advanceTimersByTime(3000) // shared tick fires 3× → repaint
        const f3 = await probe.waitForFrame(f => f.includes('· 3s'))
        expect(f3).toContain('· 3s')
        expect(f3).not.toContain('· 0s')

        vi.advanceTimersByTime(9000) // …and keeps advancing (12s total)
        const f12 = await probe.waitForFrame(f => f.includes('· 12s'))
        expect(f12).toContain('· 12s')
        expect(f12).toContain('⚡') // still running, still no ▶/▼
        expect(f12).not.toContain('▶')
      } finally {
        probe.destroy()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  test('failed tool reads as failed from the HEAD GLYPH (✗) and stays expandable when there is a body', async () => {
    const store = createSessionStore()
    seedTool(
      store,
      { tool_id: 'e1', name: 'terminal', context: 'false' },
      {
        tool_id: 'e1',
        name: 'terminal',
        args: { command: 'false' },
        error: 'exit status 1',
        result_text: 'boom line one\nboom line two',
        duration_s: 0.1
      }
    )

    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('terminal'))
      const row = frame.split('\n').find(line => line.includes('terminal')) ?? ''
      // ✗ IN the head-glyph position (immediately before the name, after the
      // assistant row's `⚕` gutter), replacing the expand glyph…
      expect(row).toContain('✗ terminal')
      expect(row).not.toContain('▶')
      expect(row).toContain('✗ exit status 1') // error subtitle stays
      expect(row).toContain('(2 lines)') // body presence still signposted

      await clickHeader(probe, 'terminal') // still expandable: body has the output
      const expanded = await probe.waitForFrame(f => f.includes('boom line one'))
      expect(expanded).toContain('boom line one')
      expect(expanded).toContain('boom line two')
    } finally {
      probe.destroy()
    }
  })

  test('settled success shows the PER-TOOL glyph ($) collapsed, ▼ expanded + duration (never ✗)', async () => {
    const store = createSessionStore()
    seedTool(
      store,
      { tool_id: 'k1', name: 'terminal', context: 'ls' },
      { tool_id: 'k1', name: 'terminal', args: { command: 'ls' }, result_text: 'a\nb', duration_s: 0.3 }
    )

    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('terminal'))
      const row = frame.split('\n').find(line => line.includes('terminal')) ?? ''
      expect(row).toContain('$ terminal') // per-tool glyph in the head position (design pass)
      expect(row).toContain('· 0.3s')
      expect(row).not.toContain('✗')
      expect(row).not.toContain('⚡')

      await clickHeader(probe, 'terminal')
      const expanded = await probe.waitForFrame(f => f.includes('▼'))
      expect(expanded).toContain('▼ terminal')
    } finally {
      probe.destroy()
    }
  })
})

describe('HERMES_TUI_TOOL_OUTPUT_LINES — expanded-output line cap (TUI-only env var)', () => {
  const ENV = 'HERMES_TUI_TOOL_OUTPUT_LINES'

  /** Run `fn` with the flag set to `value` (undefined → unset), restoring after. */
  async function withFlag(value: string | undefined, fn: () => Promise<void> | void) {
    const prev = process.env[ENV]
    if (value === undefined) delete process.env[ENV]
    else process.env[ENV] = value
    try {
      await fn()
    } finally {
      if (prev === undefined) delete process.env[ENV]
      else process.env[ENV] = prev
    }
  }

  test('flag=0 (unlimited): a 250-line output renders ALL lines with NO "+N more lines" note', async () => {
    await withFlag('0', async () => {
      const lines = Array.from({ length: 250 }, (_, i) => `row-${String(i + 1).padStart(3, '0')}`)
      const part: ToolPartState = {
        type: 'tool',
        id: 'u1',
        name: 'terminal',
        state: 'complete',
        args: { command: 'seq 1 250' },
        resultText: lines.join('\n')
      }
      const probe = await renderProbe(
        () => (
          <ThemeProvider>
            <BashToolBody part={part} width={70} />
          </ThemeProvider>
        ),
        { width: 80, height: 260 }
      )
      try {
        const frame = await probe.waitForFrame(f => f.includes('row-250'))
        expect(frame).toContain('row-001')
        expect(frame).toContain('row-200')
        expect(frame).toContain('row-201') // beyond the old 200-line cap…
        expect(frame).toContain('row-250') // …down to the very last line
        expect(frame).not.toContain('more lines') // and no truncation note
      } finally {
        probe.destroy()
      }
    })
  })

  test('flag unset: the same 250-line output renders ALL lines (UNLIMITED is the default now)', async () => {
    await withFlag(undefined, async () => {
      const lines = Array.from({ length: 250 }, (_, i) => `row-${String(i + 1).padStart(3, '0')}`)
      const part: ToolPartState = {
        type: 'tool',
        id: 'u2',
        name: 'terminal',
        state: 'complete',
        args: { command: 'seq 1 250' },
        resultText: lines.join('\n')
      }
      const probe = await renderProbe(
        () => (
          <ThemeProvider>
            <BashToolBody part={part} width={70} />
          </ThemeProvider>
        ),
        { width: 80, height: 260 }
      )
      try {
        const frame = await probe.waitForFrame(f => f.includes('row-250'))
        expect(frame).toContain('row-001')
        expect(frame).toContain('row-201') // beyond the old 200-line default…
        expect(frame).toContain('row-250') // …down to the very last line
        expect(frame).not.toContain('more lines') // and no truncation note
      } finally {
        probe.destroy()
      }
    })
  })

  test('flag=50: an explicit cap is RESTORED — 50 lines + the honest "+200 more lines" note', async () => {
    await withFlag('50', async () => {
      const lines = Array.from({ length: 250 }, (_, i) => `row-${String(i + 1).padStart(3, '0')}`)
      const part: ToolPartState = {
        type: 'tool',
        id: 'u3',
        name: 'terminal',
        state: 'complete',
        args: { command: 'seq 1 250' },
        resultText: lines.join('\n')
      }
      const probe = await renderProbe(
        () => (
          <ThemeProvider>
            <BashToolBody part={part} width={70} />
          </ThemeProvider>
        ),
        { width: 80, height: 260 }
      )
      try {
        const frame = await probe.waitForFrame(f => f.includes('+200 more lines'))
        expect(frame).toContain('row-050')
        expect(frame).not.toContain('row-051')
        expect(frame).toContain('… +200 more lines')
      } finally {
        probe.destroy()
      }
    })
  })

  test('store: unlimited cap + gateway tail-cap (omittedNote) + full raw result → body derived from the raw result', async () => {
    const full = Array.from({ length: 250 }, (_, i) => `full-${i + 1}`).join('\n')
    const cappedTail = ['full-241', 'full-242', 'full-243'].join('\n') // what the gateway kept
    const payload = {
      tool_id: 'p1',
      name: 'terminal',
      args: { command: 'seq 1 250' },
      result_text: `[showing verbose tail; omitted 240 lines / 2000 chars]\n${cappedTail}`,
      result: { output: full, exit_code: 0 }
    }
    const partOf = (store: Store) =>
      store.state.messages[store.state.messages.length - 1]?.parts?.find(
        (p): p is ToolPartState => p.type === 'tool' && p.id === 'p1'
      )

    await withFlag('0', () => {
      const store = createSessionStore()
      seedTool(store, { tool_id: 'p1', name: 'terminal' }, payload)
      const part = partOf(store)
      // the FULL raw result wins: longer than the capped tail, head included
      expect(part?.resultText).toContain('full-1\n')
      expect(part?.resultText).toContain('full-250')
      expect(part?.omittedNote).toBeUndefined() // the note no longer applies
    })

    // flag UNSET → unlimited is the DEFAULT now: the full raw result wins too
    await withFlag(undefined, () => {
      const store = createSessionStore()
      seedTool(store, { tool_id: 'p1', name: 'terminal' }, payload)
      const part = partOf(store)
      expect(part?.resultText).toContain('full-1\n')
      expect(part?.resultText).toContain('full-250')
      expect(part?.omittedNote).toBeUndefined()
    })

    // an explicit FINITE cap (=50) → the user asked for a bounded view: keep
    // the gateway tail + the honest omitted note (the view caps further)
    await withFlag('50', () => {
      const store = createSessionStore()
      seedTool(store, { tool_id: 'p1', name: 'terminal' }, payload)
      const part = partOf(store)
      expect(part?.resultText).toBe(cappedTail)
      expect(part?.resultText).not.toContain('full-1\n')
      expect(part?.omittedNote).toBe('240 lines / 2000 chars')
    })

    // unlimited but NO raw result on the wire → keep the tail + note (no crash)
    await withFlag('0', () => {
      const store = createSessionStore()
      const withoutRaw: Record<string, unknown> = { ...payload }
      delete withoutRaw['result']
      seedTool(store, { tool_id: 'p1', name: 'terminal' }, withoutRaw)
      const part = partOf(store)
      expect(part?.resultText).toBe(cappedTail)
      expect(part?.omittedNote).toBe('240 lines / 2000 chars')
    })
  })
})

describe('tool-name emphasis + thought styling (feedback: undifferentiated muted rows)', () => {
  const color = DEFAULT_THEME.color

  test('toolNameStyle: settled name is muted-BRIGHT (statusFg + bold) — machinery, never the answer color', () => {
    expect(toolNameStyle({ failed: false, running: false }, color)).toEqual({ bold: true, fg: color.statusFg })
    expect(color.text).not.toBe(color.muted) // the emphasis is real, not a no-op
  })

  test('toolNameStyle: failed keeps the error coloring (it wins), running keeps its muted treatment', () => {
    expect(toolNameStyle({ failed: true, running: false }, color)).toEqual({ bold: true, fg: color.error })
    expect(toolNameStyle({ failed: false, running: true }, color)).toEqual({ bold: false, fg: color.muted })
  })

  test('reasoningLabelStyle: muted + ITALIC — a different KIND of row than a tool, never louder', () => {
    expect(reasoningLabelStyle(color)).toEqual({ fg: color.muted, italic: true })
  })
})

describe('redaction precedence — gateway args_text wins over raw args (security)', () => {
  // The gateway redacts verbose `args_text` (server.py _tool_args_text) but
  // sends the raw `args` dict on tool.complete UNREDACTED. structuredArgs must
  // parse argsText first so masked secrets never render unmasked.

  test('labeled fields render the redacted args_text value, never the raw args secret', async () => {
    const store = createSessionStore()
    seedTool(
      store,
      // verbose session: tool.start carries the gateway-redacted args_text
      {
        tool_id: 's1',
        name: 'mcp_call',
        args_text: JSON.stringify({ api_key: 'sk-****', endpoint: 'v1/users' }, null, 2)
      },
      // tool.complete carries the raw, UNREDACTED args dict
      {
        tool_id: 's1',
        name: 'mcp_call',
        args: { api_key: 'sk-secret123', endpoint: 'v1/users' },
        result_text: 'done'
      }
    )

    const probe = await mountApp(store)
    try {
      await clickHeader(probe, 'mcp_call')
      const expanded = await probe.waitForFrame(f => f.includes('api_key'))
      expect(expanded).toContain('sk-****') // the gateway's redaction survives
      expect(expanded).not.toContain('sk-secret123') // the raw secret never renders
      expect(expanded).toContain('endpoint') // non-secret fields still labeled
      expect(expanded).toContain('v1/users')
    } finally {
      probe.destroy()
    }
  })

  test('commandOf prefers the redacted args_text parse over the raw args command', () => {
    const store = createSessionStore()
    seedTool(
      store,
      {
        tool_id: 's2',
        name: 'terminal',
        args_text: JSON.stringify({ command: 'curl -H "Authorization: sk-****" api.test' })
      },
      {
        tool_id: 's2',
        name: 'terminal',
        args: { command: 'curl -H "Authorization: sk-secret123" api.test' },
        result_text: 'ok'
      }
    )
    // Going through the real store also pins the invariant this fix relies on:
    // tool.complete back-fills argsText only when ABSENT — the redacted
    // tool.start args_text is never overwritten.
    const last = store.state.messages[store.state.messages.length - 1]
    const part = last?.parts?.find((p): p is ToolPartState => p.type === 'tool' && p.id === 's2')
    expect(part).toBeDefined()
    expect(part?.argsText).toContain('sk-****')
    const cmd = commandOf(part as ToolPartState)
    expect(cmd).toContain('sk-****') // a masked command IS the correct display
    expect(cmd).not.toContain('sk-secret123')
  })

  test('absent or unparseable argsText falls back to raw args (non-verbose parity)', () => {
    // no argsText at all → raw args, same as the previous behavior
    const bare: ToolPartState = {
      type: 'tool',
      id: 's3',
      name: 'terminal',
      state: 'complete',
      args: { command: 'ls -la' }
    }
    expect(commandOf(bare)).toBe('ls -la')
    // argsText capped mid-JSON (unparseable) → raw args still render
    const capped: ToolPartState = {
      type: 'tool',
      id: 's4',
      name: 'terminal',
      state: 'complete',
      args: { command: 'echo hi' },
      argsText: '{"command": "echo h'
    }
    expect(commandOf(capped)).toBe('echo hi')
  })
})
