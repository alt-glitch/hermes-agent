/**
 * fuzzy.ts — pure fuzzy filtering + grouped presentation for picker overlays
 * (Epic 7 model picker v2; resume-session picker; skills hub). Matching/ranking
 * is delegated to `fuzzysort` (the library opencode uses in production, see its
 * dialog-select.tsx) through a thin adapter that preserves this module's API:
 * call sites pass weighted `FuzzyField[]` haystacks and get back a ranked list.
 *
 * Adapter semantics on top of fuzzysort:
 * - Multi-key scoring à la opencode: each field is a fuzzysort key; the final
 *   score is the weight-multiplied SUM of per-key scores (label conventionally
 *   ×2, opencode's `r[0].score * 2 + r[1].score`), so label hits outrank
 *   equal-quality group/slug hits.
 * - Multi-term AND (a feature of the old hand-rolled scorer that fuzzysort
 *   lacks natively): the query is whitespace-split and fuzzysort runs once per
 *   term over the progressively-filtered pool — every term must match at least
 *   one field; per-term scores accumulate. Chosen over a joined single needle
 *   because it keeps `anthropic son` / `copilot son` matching ACROSS fields.
 * - Empty/blank query → all items in catalog order (fuzzysort returns nothing
 *   for an empty needle; the old all-rows behavior is preserved here).
 * - Equal final scores keep catalog order (fuzzysort's sort is not stable; the
 *   adapter re-sorts with the original index as tie-break).
 * - Separators `-`, `_`, `.` fold to a space on BOTH sides before matching
 *   (upstream 3f022595's `searchFold`, shared with the Ink/desktop pickers), so
 *   `gpt.4o`, `claude_3` and `qwen3-8` hit `gpt-4o`, `claude-3-opus` and
 *   `qwen3.8-flash` the way a user typing from memory expects. The fold is one
 *   char in, one char out, so any future highlighter can apply it without
 *   drift. Query folding happens BEFORE the whitespace split: a folded
 *   separator becomes a term boundary, so `gpt.4o` searches like `gpt 4o`.
 */
import fuzzysort from 'fuzzysort'

/** Length-preserving search fold: lower-case and `[-_.]` → space. */
export const searchFold = (value: string): string => value.toLowerCase().replace(/[-_.]/g, ' ')

/** One searchable field of an item (e.g. model id ×2, provider slug, lab name). */
export interface FuzzyField {
  text: string
  /** Score multiplier (default 1). The primary label is conventionally 2. */
  weight?: number
}

/** Pool entry: the item plus its precomputed fields, catalog position and the
 *  per-term accumulated score. */
interface Entry<T> {
  item: T
  at: number
  fields: FuzzyField[]
  total: number
}

/**
 * Filter + rank items by query. Empty query → the items in catalog order;
 * otherwise matches sorted by score (descending), ties keeping catalog order.
 * Every whitespace-split term must fuzzy-match at least one field.
 */
export function fuzzyFilter<T>(query: string, items: readonly T[], fieldsOf: (item: T) => FuzzyField[]): T[] {
  const terms = searchFold(query).trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return [...items]

  let pool: Entry<T>[] = items.map((item, at) => ({ at, fields: fieldsOf(item), item, total: 0 }))
  // Items may carry different field counts (description/haystacks optional):
  // one key per field slot, missing slots read as '' (never match).
  const keyCount = pool.reduce((max, e) => Math.max(max, e.fields.length), 0)
  const keys = Array.from({ length: keyCount }, (_, i) => (e: Entry<T>) => searchFold(e.fields[i]?.text ?? ''))

  for (const term of terms) {
    const results = fuzzysort.go(term, pool, {
      keys,
      // Weighted sum of per-key scores (unmatched keys score 0). Inclusion is
      // decided by fuzzysort (≥1 key must match); this only ranks.
      scoreFn: r => {
        let sum = 0
        for (let i = 0; i < r.length; i++) sum += (r[i]?.score ?? 0) * (r.obj.fields[i]?.weight ?? 1)
        return sum
      }
    })
    if (!results.length) return []
    pool = results.map(r => {
      r.obj.total += r.score
      return r.obj
    })
  }

  pool.sort((a, b) => b.total - a.total || a.at - b.at)
  return pool.map(e => e.item)
}

/** A render row of a grouped picker: a non-selectable group header or an item.
 *  `index` is the item's position in the flat ARROW-TRAVERSAL order; `-1` marks
 *  a non-selectable item row (rendered dimmed, skipped by traversal). */
export type PickerRow<T> = { kind: 'header'; label: string } | { kind: 'item'; item: T; index: number }

/**
 * Group items for display (group order = first appearance, so a score-sorted
 * input puts the best group first). Returns the header+item render rows and
 * the flat selectable list in traversal order — arrows walk `flat` and thus
 * cross group boundaries seamlessly; headers are never selectable. Items
 * without a group render headerless (e.g. the skills picker). Items failing
 * `selectableOf` (picker v2.1: unconfigured-provider hint rows) still RENDER
 * (index `-1`) but never enter `flat`, so ↑↓ traversal skips them.
 */
export function buildPickerRows<T>(
  items: readonly T[],
  groupOf: (item: T) => string | undefined,
  selectableOf: (item: T) => boolean = () => true
): { rows: PickerRow<T>[]; flat: T[] } {
  const order: string[] = []
  const buckets = new Map<string, T[]>()
  for (const item of items) {
    const group = groupOf(item) ?? ''
    let bucket = buckets.get(group)
    if (!bucket) {
      bucket = []
      buckets.set(group, bucket)
      order.push(group)
    }
    bucket.push(item)
  }
  const rows: PickerRow<T>[] = []
  const flat: T[] = []
  for (const group of order) {
    if (group) rows.push({ kind: 'header', label: group })
    for (const item of buckets.get(group) ?? []) {
      if (selectableOf(item)) {
        rows.push({ index: flat.length, item, kind: 'item' })
        flat.push(item)
      } else {
        rows.push({ index: -1, item, kind: 'item' })
      }
    }
  }
  return { flat, rows }
}

/**
 * Slice rows to a visible window of at most `cap` rows that keeps the selected
 * item in view (centered when possible). `above`/`below` are the hidden row
 * counts for the ↑/↓ "more" indicators.
 */
export function visibleRows<T>(
  rows: readonly PickerRow<T>[],
  selected: number,
  cap: number
): { rows: PickerRow<T>[]; above: number; below: number } {
  if (rows.length <= cap) return { above: 0, below: 0, rows: [...rows] }
  const selRow = rows.findIndex(r => r.kind === 'item' && r.index === selected)
  const anchor = selRow === -1 ? 0 : selRow
  const start = Math.max(0, Math.min(anchor - Math.floor(cap / 2), rows.length - cap))
  return { above: start, below: rows.length - (start + cap), rows: rows.slice(start, start + cap) }
}
