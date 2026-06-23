/**
 * Per-tool content renderers (direct user feedback round, items 1–7):
 * clarify Q/A (never JSON), skill_view name-only, search_files pattern +
 * results-only, read_file content extraction. Each `result` payload is the
 * REAL wire shape captured live (v6fix tee of `python -m tui_gateway.entry`
 * stdout); frame tests go through the real App tree + mouse expansion.
 * The native `<code>` visuals (Tree-sitter colors) belong to the live smoke —
 * here we only assert the text content/wiring.
 */
import { describe, expect, test } from 'vitest'

import { createSessionStore, type ToolPartState } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { clarifyQA, clarifyRenderer } from '../view/tools/clarifyTool.tsx'
import { delegateInfoOf, delegateRenderer } from '../view/tools/delegateTool.tsx'
import { readContentOf, readRenderer, stripLineNumbers } from '../view/tools/readTool.tsx'
import { patternOf, searchRenderer, searchResultLines } from '../view/tools/searchTool.tsx'
import { skillInfoOf, skillRenderer } from '../view/tools/skillTool.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

type Store = ReturnType<typeof createSessionStore>

function seedTool(store: Store, start: Record<string, unknown>, complete: Record<string, unknown>) {
  store.apply({ type: 'gateway.ready' })
  store.apply({ type: 'message.start' })
  store.apply({ type: 'tool.start', payload: start })
  store.apply({ type: 'tool.complete', payload: complete })
  store.apply({ type: 'message.complete' })
}

async function mountApp(store: Store, width = 100, height = 24): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} />
      </ThemeProvider>
    ),
    { width, height }
  )
}

async function clickHeader(probe: RenderProbe, name: string): Promise<void> {
  const frame = await probe.waitForFrame(f => f.includes(name))
  const rows = frame.split('\n')
  const y = rows.findIndex(line => line.includes(name))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = (rows[y] ?? '').indexOf(name)
  await probe.click(x, y)
}

/** A settled part straight from a wire-shaped tool.complete payload. */
function partFrom(store: Store, id: string): ToolPartState {
  const last = store.state.messages[store.state.messages.length - 1]
  const part = last?.parts?.find((p): p is ToolPartState => p.type === 'tool' && p.id === id)
  expect(part).toBeDefined()
  return part as ToolPartState
}

describe('clarify renderer — Q/A, never JSON (item 4)', () => {
  // REAL wire shape (v6fix live capture, tools/clarify_tool.py json.dumps).
  const COMPLETE = {
    args: { choices: ['red', 'green', 'blue'], question: 'Which color do you prefer?' },
    duration_s: 30.7,
    name: 'clarify',
    result: {
      choices_offered: ['red', 'green', 'blue'],
      question: 'Which color do you prefer?',
      user_response: 'green'
    },
    result_text:
      '{"question": "Which color do you prefer?", "choices_offered": ["red", "green", "blue"], "user_response": "green"}',
    tool_id: 'c1'
  }

  test('clarifyQA extracts the pair from the real result shape', () => {
    const store = createSessionStore()
    seedTool(store, { name: 'clarify', tool_id: 'c1' }, COMPLETE)
    const part = partFrom(store, 'c1')
    expect(clarifyQA(part)).toEqual([{ answer: 'green', question: 'Which color do you prefer?' }])
    expect(clarifyRenderer.subtitle(part)).toBe('Which color do you prefer?: green')
    expect(clarifyRenderer.expandable(part)).toBe(true)
  })

  test('frame: collapsed `q: a` subtitle; expanded `User answered:` rows; NO JSON anywhere', async () => {
    const store = createSessionStore()
    seedTool(store, { context: 'Which color do you prefer?', name: 'clarify', tool_id: 'c1' }, COMPLETE)
    const probe = await mountApp(store)
    try {
      const collapsed = await probe.waitForFrame(f => f.includes('clarify'))
      expect(collapsed).toContain('Which color do you prefer?: green') // compact q: a
      expect(collapsed).not.toContain('{"')

      await clickHeader(probe, 'clarify')
      const expanded = await probe.waitForFrame(f => f.includes('User answered:'))
      expect(expanded).toContain('User answered:')
      expect(expanded).toContain('· Which color do you prefer?: green')
      // THE acceptance gate: the JSON result never reaches the frame
      expect(expanded).not.toContain('{"')
      expect(expanded).not.toContain('user_response')
      expect(expanded).not.toContain('choices_offered')
    } finally {
      probe.destroy()
    }
  })

  test('no extractable Q/A (capped/garbled result) → header only, never the raw text', () => {
    const part: ToolPartState = {
      id: 'c2',
      name: 'clarify',
      resultText: '{"question": "Which col', // gateway-capped mid-JSON
      state: 'complete',
      type: 'tool'
    }
    expect(clarifyQA(part)).toEqual([])
    expect(clarifyRenderer.expandable(part)).toBe(false) // no body → no JSON ever
  })
})

describe('skill_view renderer — WHICH skill, not its contents (item 5)', () => {
  // REAL wire shape (v6fix live capture, trimmed to the read keys + content).
  const COMPLETE = {
    args: { name: 'plan' },
    duration_s: 0.02,
    name: 'skill_view',
    result: {
      content: '---\nname: plan\n---\n# Plan mode\n\nMANY KB OF SKILL BODY…',
      description: 'Plan mode: write an actionable markdown plan.',
      linked_files: null,
      name: 'plan',
      success: true,
      tags: ['planning']
    },
    tool_id: 'k1'
  }

  test('skillInfoOf: name + one-line description from the real shape', () => {
    const store = createSessionStore()
    seedTool(store, { name: 'skill_view', tool_id: 'k1' }, COMPLETE)
    const part = partFrom(store, 'k1')
    expect(skillInfoOf(part)).toEqual({
      description: 'Plan mode: write an actionable markdown plan.',
      name: 'plan'
    })
    expect(skillRenderer.subtitle(part)).toBe('plan')
    expect(skillRenderer.lines?.(part)).toHaveLength(2)
  })

  test('a linked-file view names the file it loaded', () => {
    const part: ToolPartState = {
      args: { file_path: 'references/api.md', name: 'opentui' },
      id: 'k2',
      name: 'skill_view',
      result: { content: '…file body…', file: 'references/api.md', name: 'opentui', success: true },
      state: 'complete',
      type: 'tool'
    }
    expect(skillRenderer.subtitle(part)).toBe('opentui · references/api.md')
    expect(skillRenderer.expandable(part)).toBe(false) // no description → header says it all
  })

  test('frame: collapsed shows the name; expanded shows name + description, NEVER the contents', async () => {
    const store = createSessionStore()
    seedTool(store, { context: 'plan', name: 'skill_view', tool_id: 'k1' }, COMPLETE)
    const probe = await mountApp(store)
    try {
      const collapsed = await probe.waitForFrame(f => f.includes('skill_view'))
      expect(collapsed).toContain('skill_view')
      expect(collapsed).toContain('plan')
      expect(collapsed).not.toContain('SKILL BODY')

      await clickHeader(probe, 'skill_view')
      const expanded = await probe.waitForFrame(f => f.includes('Plan mode'))
      expect(expanded).toContain('skill') // labeled name row
      expect(expanded).toContain('Plan mode: write an actionable markdown plan.')
      expect(expanded).not.toContain('SKILL BODY') // full contents suppressed
      expect(expanded).not.toContain('{"') // and never JSON
      expect(expanded).not.toContain('linked_files')
    } finally {
      probe.destroy()
    }
  })
})

describe('search_files renderer — pattern + results only (item 2)', () => {
  // REAL wire shape (v6fix live capture, SearchResult.to_dict content mode).
  const COMPLETE = {
    args: { path: 'ui-opentui/src', pattern: 'syntaxStyleFor' },
    duration_s: 0.1,
    name: 'search_files',
    result: {
      matches: [
        {
          content: 'export function syntaxStyleFor(theme: Theme): SyntaxStyle {',
          line: 56,
          path: 'src/view/markdown.tsx'
        },
        { content: '      syntaxStyle={syntaxStyleFor(theme())}', line: 73, path: 'src/view/markdown.tsx' }
      ],
      total_count: 2
    },
    tool_id: 's1'
  }

  test('searchResultLines shapes grep-style rows from the real result (and files/counts modes)', () => {
    const store = createSessionStore()
    seedTool(store, { name: 'search_files', tool_id: 's1' }, COMPLETE)
    const part = partFrom(store, 's1')
    expect(patternOf(part)).toBe('syntaxStyleFor')
    expect(searchResultLines(part)).toEqual([
      'src/view/markdown.tsx:56: export function syntaxStyleFor(theme: Theme): SyntaxStyle {',
      'src/view/markdown.tsx:73:       syntaxStyle={syntaxStyleFor(theme())}'
    ])
    expect(searchRenderer.subtitle(part)).toBe('syntaxStyleFor')
    // files mode
    expect(searchResultLines({ ...part, result: { files: ['a.py', 'b.py'], total_count: 2 } })).toEqual([
      'a.py',
      'b.py'
    ])
    // count mode + truncated note
    expect(searchResultLines({ ...part, result: { counts: { 'a.py': 3 }, total_count: 3, truncated: true } })).toEqual([
      'a.py: 3',
      '… results truncated'
    ])
    // zero matches is still an answer
    expect(searchResultLines({ ...part, result: { total_count: 0 } })).toEqual(['no matches'])
  })

  test('frame: pattern subtitle; expanded = result rows; context/output_mode/path never shown', async () => {
    const store = createSessionStore()
    const complete = {
      ...COMPLETE,
      args: { context: 2, output_mode: 'content', path: 'ui-opentui/src', pattern: 'syntaxStyleFor', target: 'content' }
    }
    seedTool(store, { context: 'syntaxStyleFor', name: 'search_files', tool_id: 's1' }, complete)
    const probe = await mountApp(store, 120)
    try {
      const collapsed = await probe.waitForFrame(f => f.includes('search_files'))
      expect(collapsed).toContain('syntaxStyleFor') // the pattern IS the subtitle

      await clickHeader(probe, 'search_files')
      const expanded = await probe.waitForFrame(f => f.includes('markdown.tsx:56'))
      expect(expanded).toContain('src/view/markdown.tsx:56: export function syntaxStyleFor')
      expect(expanded).toContain('src/view/markdown.tsx:73:')
      expect(expanded).not.toContain('output_mode') // noise fields suppressed…
      expect(expanded).not.toContain('context')
      expect(expanded).not.toContain('target')
      expect(expanded).not.toContain('total_count') // …and never the JSON envelope
      expect(expanded).not.toContain('{"')
    } finally {
      probe.destroy()
    }
  })
})

describe('read_file content extraction (items 1 + 7 logic)', () => {
  test('readContentOf reads the dict result; stripLineNumbers peels uniform N| prefixes only', () => {
    const part: ToolPartState = {
      args: { limit: 50, offset: 1, path: '/p/x.py' },
      id: 'r1',
      name: 'read_file',
      result: { content: '1|import os\n2|\n3|print(os.sep)', file_size: 30, total_lines: 3 },
      state: 'complete',
      type: 'tool'
    }
    expect(readContentOf(part)).toBe('1|import os\n2|\n3|print(os.sep)')
    expect(stripLineNumbers(readContentOf(part) ?? '')).toBe('import os\n\nprint(os.sep)')
    expect(readRenderer.expandable(part)).toBe(true)
    expect(readRenderer.lines?.(part)).toEqual(['import os', '', 'print(os.sep)'])
    // mixed content (not every line prefixed) stays verbatim — no false stripping
    expect(stripLineNumbers('1|a\nplain line')).toBe('1|a\nplain line')
    // a resumed part with only (mangled) result_text falls back gracefully
    const resumed: ToolPartState = {
      id: 'r2',
      name: 'read_file',
      resultText: '…tail…',
      state: 'complete',
      type: 'tool'
    }
    expect(readContentOf(resumed)).toBeUndefined()
    expect(readRenderer.expandable(resumed)).toBe(true) // output fallback still expandable
  })
})

describe('delegate_task renderer — structured fan-out, never JSON dump (glitch 2026-06-23)', () => {
  test('background dispatch shape → "N agents dispatched" + goal rows', () => {
    // REAL wire shape (tools/delegate_tool.py background dispatch payload).
    const part: ToolPartState = {
      id: 'd1',
      name: 'delegate_task',
      args: { tasks: [{ goal: 'Research WebGPU' }, { goal: 'Summarize MoE papers' }, { goal: 'SQLite WAL notes' }] },
      result: {
        status: 'dispatched',
        mode: 'background',
        count: 3,
        delegation_id: 'deleg_69782cb2',
        goals: ['Research WebGPU', 'Summarize MoE papers', 'SQLite WAL notes'],
        note: '3 subagents are running in parallel in the background.'
      },
      state: 'complete',
      type: 'tool'
    }
    const info = delegateInfoOf(part)
    expect(info?.dispatched).toBe(true)
    expect(info?.rows).toEqual([
      { state: 'dispatched', goal: 'Research WebGPU' },
      { state: 'dispatched', goal: 'Summarize MoE papers' },
      { state: 'dispatched', goal: 'SQLite WAL notes' }
    ])
    expect(delegateRenderer.subtitle(part)).toBe('3 agents dispatched (background)')
    expect(delegateRenderer.expandable(part)).toBe(true)
    // honest "(N lines)": one row per goal, no detail rows on dispatch
    expect(delegateRenderer.lines?.(part)).toEqual([
      '→ Research WebGPU',
      '→ Summarize MoE papers',
      '→ SQLite WAL notes'
    ])
    // single-agent grammar
    const one: ToolPartState = {
      ...part,
      result: { status: 'dispatched', mode: 'background', count: 1, delegation_id: 'd', goals: ['solo'], note: '' }
    }
    expect(delegateRenderer.subtitle(one)).toBe('1 agent dispatched (background)')
  })

  test('completion shape → per-task ok/failed rows + summary/error detail; goals matched by task_index', () => {
    // REAL wire shape (tools/delegate_tool.py _execute_and_aggregate return).
    const part: ToolPartState = {
      id: 'd2',
      name: 'delegate_task',
      args: { tasks: [{ goal: 'crunch the data' }, { goal: 'child probe' }] },
      result: {
        results: [
          { task_index: 0, status: 'ok', summary: 'Computed pi to 1000 digits.', duration_seconds: 12.4 },
          { task_index: 1, status: 'error', summary: null, error: 'tool timed out' }
        ],
        total_duration_seconds: 12.6
      },
      state: 'complete',
      type: 'tool'
    }
    const info = delegateInfoOf(part)
    expect(info?.dispatched).toBe(false)
    expect(info?.okCount).toBe(1)
    expect(info?.failedCount).toBe(1)
    expect(info?.rows).toEqual([
      { state: 'ok', goal: 'crunch the data', detail: 'Computed pi to 1000 digits.' },
      { state: 'failed', goal: 'child probe', detail: 'tool timed out' }
    ])
    expect(delegateRenderer.subtitle(part)).toBe('2 agents · 1 ok · 1 failed')
    // all-ok grammar
    const allOk: ToolPartState = {
      ...part,
      result: { results: [{ task_index: 0, status: 'ok', summary: 'done' }], total_duration_seconds: 1 }
    }
    expect(delegateRenderer.subtitle(allOk)).toBe('1 agent · all done')
  })

  test('falls back to default renderer for an unknown result shape (no crash, no JSON contract)', () => {
    const part: ToolPartState = {
      id: 'd3',
      name: 'delegate_task',
      result: { something: 'unexpected' },
      state: 'complete',
      type: 'tool'
    }
    expect(delegateInfoOf(part)).toBeUndefined()
    expect(delegateRenderer.expandable(part)).toBe(false)
  })
})
