/**
 * fuzzy.ts tests (Epic 7) — the fuzzysort-backed filter + grouped-rows helpers
 * behind the picker overlays: subsequence matching, ranking (prefix >
 * word-boundary > scattered), multi-field (provider/model/lab), multi-term AND,
 * empty query = catalog order, no-match = empty, header rows non-selectable,
 * the flat arrow-traversal order across groups, and long/messy haystacks shaped
 * like the resume-session picker (titles + cwd paths + sources).
 *
 * Matching/ranking comes from `fuzzysort` via the adapter in logic/fuzzy.ts —
 * all matching assertions go through the public `fuzzyFilter` (the old
 * hand-rolled scorer internals `scoreTerm`/`scoreFields` are gone).
 */
import { describe, expect, test } from 'vitest'

import { buildPickerRows, fuzzyFilter, visibleRows, type FuzzyField } from '../logic/fuzzy.ts'

/** Filter plain labels (the single-field degenerate case). */
const byLabel = (query: string, labels: string[]): string[] => fuzzyFilter(query, labels, l => [{ text: l, weight: 2 }])

describe('fuzzyFilter — subsequence matching', () => {
  test('matches subsequences (case-insensitive), drops non-subsequences', () => {
    expect(byLabel('son', ['claude-sonnet-4'])).toEqual(['claude-sonnet-4'])
    expect(byLabel('son4', ['claude-sonnet-4'])).toEqual(['claude-sonnet-4']) // the complaint's example
    expect(byLabel('SON', ['claude-sonnet-4'])).toEqual(['claude-sonnet-4'])
    expect(byLabel('xyz', ['claude-sonnet-4'])).toEqual([])
    expect(byLabel('sonn5', ['claude-sonnet-4'])).toEqual([]) // 5 not present after sonn
    expect(byLabel('', ['anything'])).toEqual(['anything']) // empty query matches everything
  })

  test('ranking: prefix > word-boundary > scattered', () => {
    // catalog order is deliberately worst-first; ranking must invert it.
    expect(byLabel('son', ['meson', 'claude-sonnet', 'sonnet'])).toEqual(['sonnet', 'claude-sonnet', 'meson'])
  })

  test('anchors at the BEST occurrence, not greedily at the first', () => {
    // greedy-from-first-char would match saturn's s@0 then o/n far away; the
    // boundary anchor at the second `s` (start of "sonnet") must win over a
    // genuinely scattered match.
    expect(byLabel('son', ['meson', 'saturn-sonnet'])).toEqual(['saturn-sonnet', 'meson'])
  })

  test('separator variants fold both ways: `-`, `_`, `.` are interchangeable with each other and with space', () => {
    // Parity with the Ink/desktop pickers (upstream 3f022595): a user typing a
    // model id from memory gets the same rows whichever separator they recall.
    const catalog = ['gpt-4o', 'claude-3-opus', 'qwen3.8-flash', 'snake_case_model']
    expect(byLabel('gpt.4o', catalog)).toEqual(['gpt-4o'])
    expect(byLabel('gpt_4o', catalog)).toEqual(['gpt-4o'])
    expect(byLabel('claude_3', catalog)).toEqual(['claude-3-opus'])
    expect(byLabel('qwen3-8', catalog)).toEqual(['qwen3.8-flash'])
    expect(byLabel('snake-case', catalog)).toEqual(['snake_case_model'])
    // The exact spelling still matches, and a folded query cannot invent a hit.
    expect(byLabel('gpt-4o', catalog)).toEqual(['gpt-4o'])
    expect(byLabel('gpt.5o', catalog)).toEqual([])
  })
})

describe('fuzzyFilter — multi-field, multi-term', () => {
  const row = { lab: 'Anthropic', label: 'claude-sonnet-4', provider: 'anthropic' }
  const fieldsOf = (r: typeof row): FuzzyField[] => [
    { text: r.label, weight: 2 },
    { text: r.provider },
    { text: r.lab }
  ]

  test('a term may match ANY field (provider/model/lab)', () => {
    expect(fuzzyFilter('son4', [row], fieldsOf)).toHaveLength(1) // via the model id
    expect(fuzzyFilter('anthro', [row], fieldsOf)).toHaveLength(1) // via the provider
    expect(fuzzyFilter('nope', [row], fieldsOf)).toHaveLength(0)
  })

  test('every whitespace term must match some field (anthropic son works)', () => {
    expect(fuzzyFilter('anthropic son', [row], fieldsOf)).toHaveLength(1)
    expect(fuzzyFilter('anthropic zzz', [row], fieldsOf)).toHaveLength(0)
  })

  test('label matches outrank same-quality secondary-field matches (weight 2×)', () => {
    const labelHit = { label: 'claude-sonnet-4', provider: 'anthropic' }
    const providerHit = { label: 'other-model', provider: 'claude' }
    const fields = (r: typeof labelHit): FuzzyField[] => [{ text: r.label, weight: 2 }, { text: r.provider }]
    // providerHit comes FIRST in catalog order; the ×2 label hit must beat it.
    expect(fuzzyFilter('claude', [providerHit, labelHit], fields)[0]).toBe(labelHit)
  })
})

interface Row {
  label: string
  provider: string
  lab: string
}
const CATALOG: Row[] = [
  { lab: 'Anthropic', label: 'claude-sonnet-4', provider: 'anthropic' },
  { lab: 'Anthropic', label: 'claude-opus-4', provider: 'anthropic' },
  { lab: 'OpenAI', label: 'gpt-5', provider: 'openai' },
  { lab: 'Nous Research', label: 'hermes-4-405b', provider: 'nous' }
]
const rowFields = (r: Row): FuzzyField[] => [{ text: r.label, weight: 2 }, { text: r.provider }, { text: r.lab }]

describe('fuzzyFilter', () => {
  test('empty/blank query → catalog order, untouched', () => {
    expect(fuzzyFilter('', CATALOG, rowFields)).toEqual(CATALOG)
    expect(fuzzyFilter('   ', CATALOG, rowFields)).toEqual(CATALOG)
  })

  test('no match → empty', () => {
    expect(fuzzyFilter('qqqq', CATALOG, rowFields)).toEqual([])
  })

  test('son4 finds claude-sonnet-4 (under anthropic) first', () => {
    expect(fuzzyFilter('son4', CATALOG, rowFields)[0]?.label).toBe('claude-sonnet-4')
  })

  test('oai matches the openai-provider model via the provider field', () => {
    const hits = fuzzyFilter('oai', CATALOG, rowFields)
    expect(hits.map(h => h.label)).toContain('gpt-5')
  })

  test('equal-quality prefix matches rank the shorter label first; true ties keep catalog order', () => {
    // DELIBERATE expectation change with the fuzzysort adapter: the old scorer
    // scored both `claude-*` labels identically and fell back to catalog order
    // (sonnet first). fuzzysort additionally rewards how much of the target the
    // match covers, so the SHORTER claude-opus-4 now outranks claude-sonnet-4 —
    // better for a user: the closer-to-exact label surfaces first.
    const hits = fuzzyFilter('claude', CATALOG, rowFields)
    expect(hits.map(h => h.label)).toEqual(['claude-opus-4', 'claude-sonnet-4'])
    // genuinely equal scores (same-length labels, same match shape) stay stable
    // in catalog order — fuzzysort's own sort is unstable; the adapter re-ties.
    expect(byLabel('son', ['claude-sonnet', 'saturn-sonnet'])).toEqual(['claude-sonnet', 'saturn-sonnet'])
    expect(byLabel('son', ['saturn-sonnet', 'claude-sonnet'])).toEqual(['saturn-sonnet', 'claude-sonnet'])
  })
})

/** Rows shaped like the upcoming resume-session picker: long human titles,
 *  deep cwd paths and a source tag as secondary haystacks. */
interface Session {
  title: string
  cwd: string
  source: string
}
const SESSIONS: Session[] = [
  {
    cwd: '/home/daimon/github/worktrees/hermes-agent/lively-thrush',
    source: 'tui',
    title: 'Adopt OpenTUI paradigm for UI implementation'
  },
  { cwd: '/home/daimon/github/opentui', source: 'tui', title: 'Fix memory leak in Ink renderer' },
  { cwd: '/home/daimon/github/daimon-nous', source: 'discord', title: 'Triage daimon-nous webhook reviewer pipeline' },
  { cwd: '/home/daimon/github/worktrees/hermes-agent/quiet-finch', source: 'tui', title: 'Parser cleanup pass' },
  { cwd: '/home/daimon/notes', source: 'telegram', title: 'Resume-session picker design notes' }
]
const sessionFields = (s: Session): FuzzyField[] => [{ text: s.title, weight: 2 }, { text: s.cwd }, { text: s.source }]

describe('fuzzyFilter — long/messy haystacks (resume-session shape)', () => {
  test('`opentui par` ANDs across one long title (word-boundary terms)', () => {
    const hits = fuzzyFilter('opentui par', SESSIONS, sessionFields)
    expect(hits.map(h => h.title)).toEqual(['Adopt OpenTUI paradigm for UI implementation'])
  })

  test('`lively` matches via the cwd-path haystack alone', () => {
    const hits = fuzzyFilter('lively', SESSIONS, sessionFields)
    expect(hits.map(h => h.title)).toEqual(['Adopt OpenTUI paradigm for UI implementation'])
  })

  test('`worktr herm` ANDs across deep path segments, keeps ONLY worktree sessions', () => {
    const hits = fuzzyFilter('worktr herm', SESSIONS, sessionFields)
    expect(hits.map(h => h.title).sort()).toEqual([
      'Adopt OpenTUI paradigm for UI implementation',
      'Parser cleanup pass'
    ])
  })

  test('a title hit outranks a path-only hit for the same query', () => {
    // 'Fix memory leak…' matches `opentui` ONLY via its cwd; the title hit
    // (label ×2) must come first even though the path row is earlier in catalog.
    const hits = fuzzyFilter('opentui', SESSIONS, sessionFields)
    expect(hits.map(h => h.title)).toEqual([
      'Adopt OpenTUI paradigm for UI implementation',
      'Fix memory leak in Ink renderer'
    ])
  })

  test('a noisy shared path prefix does not drown a title match', () => {
    // every github row shares /home/daimon/…; the title containing `daimon`
    // (the daimon-nous session) must outrank the rows matching only via cwd.
    const hits = fuzzyFilter('daimon', SESSIONS, sessionFields)
    expect(hits[0]?.title).toBe('Triage daimon-nous webhook reviewer pipeline')
    expect(hits.length).toBe(SESSIONS.length) // all rows match somewhere (path/source)
  })

  test('multi-term over title words: `resume pick` pins the picker-design session; junk → empty', () => {
    expect(fuzzyFilter('resume pick', SESSIONS, sessionFields).map(h => h.title)).toEqual([
      'Resume-session picker design notes'
    ])
    expect(fuzzyFilter('github.zzz', SESSIONS, sessionFields)).toEqual([])
  })
})

describe('buildPickerRows — grouping + traversal order', () => {
  test('items group by provider with headers; flat traversal crosses groups', () => {
    const { flat, rows } = buildPickerRows(CATALOG, r => r.lab)
    expect(rows.map(r => (r.kind === 'header' ? `# ${r.label}` : r.item.label))).toEqual([
      '# Anthropic',
      'claude-sonnet-4',
      'claude-opus-4',
      '# OpenAI',
      'gpt-5',
      '# Nous Research',
      'hermes-4-405b'
    ])
    // the flat ARROW order is exactly the item rows in render order — so ↓ from
    // claude-opus-4 lands on gpt-5 (next group) and headers are never selectable.
    expect(flat.map(f => f.label)).toEqual(['claude-sonnet-4', 'claude-opus-4', 'gpt-5', 'hermes-4-405b'])
    expect(rows.flatMap(r => (r.kind === 'item' ? [r.index] : []))).toEqual([0, 1, 2, 3])
  })

  test('ungrouped items render headerless (flat list)', () => {
    const { rows } = buildPickerRows(CATALOG, () => undefined)
    expect(rows.every(r => r.kind === 'item')).toBe(true)
  })

  test('group order = first appearance (score-sorted input → best group first)', () => {
    const sorted = [CATALOG[2]!, CATALOG[0]!, CATALOG[1]!] // gpt-5 scored best
    const { rows } = buildPickerRows(sorted, r => r.lab)
    expect(rows[0]).toEqual({ kind: 'header', label: 'OpenAI' })
  })

  test('non-selectable items (picker v2.1 unconfigured rows) render with index -1, stay out of flat', () => {
    // an unconfigured "provider hint" row sits BETWEEN two configured groups
    const mixed = [
      { lab: 'Anthropic', label: 'claude-sonnet-4', provider: 'anthropic' },
      { lab: 'Mistral', label: 'no API key — set MISTRAL_API_KEY', provider: 'mistral' },
      { lab: 'OpenAI', label: 'gpt-5', provider: 'openai' }
    ]
    const { flat, rows } = buildPickerRows(
      mixed,
      r => r.lab,
      r => !r.label.startsWith('no API key')
    )
    // hint row RENDERS (with its header) but is index -1 and absent from flat —
    // so ↑↓ traversal (which walks flat) skips it entirely.
    expect(rows.map(r => (r.kind === 'header' ? `# ${r.label}` : `${r.index}:${r.item.label}`))).toEqual([
      '# Anthropic',
      '0:claude-sonnet-4',
      '# Mistral',
      '-1:no API key — set MISTRAL_API_KEY',
      '# OpenAI',
      '1:gpt-5'
    ])
    expect(flat.map(f => f.label)).toEqual(['claude-sonnet-4', 'gpt-5'])
  })
})

describe('visibleRows — selection-following window', () => {
  const { rows } = buildPickerRows(CATALOG, r => r.lab) // 7 rows

  test('no slicing when everything fits', () => {
    const w = visibleRows(rows, 0, 12)
    expect(w.rows).toHaveLength(7)
    expect(w.above).toBe(0)
    expect(w.below).toBe(0)
  })

  test('keeps the selected item in view and reports hidden counts', () => {
    const w = visibleRows(rows, 3, 4) // last item selected, window of 4
    expect(w.rows.some(r => r.kind === 'item' && r.index === 3)).toBe(true)
    expect(w.above + w.below + w.rows.length).toBe(7)
    expect(w.above).toBeGreaterThan(0)
  })
})
