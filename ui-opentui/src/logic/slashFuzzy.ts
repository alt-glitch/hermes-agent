/**
 * Description-aware fuzzy scoring for slash-command matching (port of upstream
 * 1405d330e7e5 — Ink `app/slash/fuzzyScore.ts`, itself ported from
 * superagent-ai/grok-cli `src/ui/slash-menu.ts`).
 *
 * Candidates score in tiers — exact match on id/label/alias (0), prefix (1),
 * substring (2) — and DESCRIPTION text is tokenized and matched at a +3 offset
 * (exact word 3, word prefix 4, word substring 5). Lower score wins; `Infinity`
 * means no match. The dispatcher (`dispatchSlash`) keeps only scores < 3 so a
 * description-only match can surface in a completion MENU but never
 * auto-executes a submitted command.
 *
 * OpenTUI's gateway rows are gateway-ranked (`complete.slash` runs the Python
 * port of this same scorer). Client-local widget rows use `rankSlashItems`
 * because the gateway cannot see that registry.
 */

export interface SlashScoreItem {
  aliases?: string[]
  description?: string
  id: string
  label?: string
}

/** Lowercase the value and return it alongside its alphanumeric word tokens. */
export function tokenizeSearchText(value: string): string[] {
  const normalized = value.toLowerCase()

  return [normalized, ...normalized.split(/[^a-z0-9]+/).filter(Boolean)]
}

/** Trim, drop leading slashes, lowercase — `/Model ` and `model` score alike. */
export function normalizeSlashSearchQuery(query: string): string {
  return query.trim().replace(/^\/+/, '').toLowerCase()
}

function scoreFields(fields: string[], query: string, offset: number): number {
  for (const field of fields) {
    if (field === query || `/${field}` === query) {
      return offset
    }
  }

  for (const field of fields) {
    if (field.startsWith(query) || `/${field}`.startsWith(query)) {
      return offset + 1
    }
  }

  for (const field of fields) {
    if (field.includes(query)) {
      return offset + 2
    }
  }

  return Number.POSITIVE_INFINITY
}

/** Score one item against a normalized query. Lower is better; Infinity = no match. */
export function scoreSlashMenuItem(item: SlashScoreItem, query: string): number {
  const commandFields = [item.id, item.label ?? '', ...(item.aliases ?? [])].filter(Boolean).flatMap(tokenizeSearchText)

  const descriptionFields = tokenizeSearchText(item.description ?? '')

  return Math.min(scoreFields(commandFields, query, 0), scoreFields(descriptionFields, query, 3))
}

/** Keep only the strongest matching tier, preserving input order within it.
 * An empty query returns the original list so browsing keeps registry order. */
export function rankSlashItems<T>(items: T[], query: string, toScoreItem: (item: T) => SlashScoreItem): T[] {
  const normalized = normalizeSlashSearchQuery(query)

  if (!normalized) return items

  const scored = items.map(item => ({ item, score: scoreSlashMenuItem(toScoreItem(item), normalized) }))
  const bestScore = Math.min(...scored.map(entry => entry.score))

  return Number.isFinite(bestScore) ? scored.filter(entry => entry.score === bestScore).map(entry => entry.item) : []
}
