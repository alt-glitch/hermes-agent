/**
 * Pasted-text placeholders (free-code's model). A large paste isn't dumped raw
 * into the composer — instead a compact `[Pasted text #N +M lines]` chip is shown
 * and the real content is held in a bounded Map, then expanded back on submit.
 * Pure + no OpenTUI imports → trivially unit-testable.
 *
 * The store is created ONCE per session (entry) and passed to the Composer, so it
 * survives the composer remounting when overlays open/close (a per-composer store
 * would lose a pending paste mid-compose).
 */

export interface PasteStore {
  /** Register a pasted block; returns undefined without retaining it when the
   * aggregate ceiling would be exceeded. Callers must consume/reject that paste
   * rather than letting a multi-megabyte body fall through to the textarea. */
  add(text: string): string | undefined
  /** Atomically replace every retained block with one new block. A rejected
   * replacement leaves the existing refs intact, so the visible draft remains
   * recoverable until its caller decides what to do. */
  replace(text: string): string | undefined
  /** Replace every placeholder with its stored content. Returns undefined
   * without allocating the expanded string when it would exceed maxChars. */
  expand(input: string, maxChars?: number): string | undefined
  /** Drop only refs present in an abandoned draft/editor buffer. */
  discard(input: string): void
  /** Keep only refs still reachable from the replacement draft. This is the
   * programmatic-replacement seam: restoring the same token keeps its body;
   * replacing it with unrelated text releases the old body. */
  retainOnly(input: string): void
  /** Drop all stored pastes (successful submit / explicit draft discard). */
  clear(): void
  /** Deterministic retained-memory accounting for diagnostics/resource tests.
   * `bytes` is a conservative UTF-16 upper bound (two bytes per code unit). */
  stats(): PasteStoreStats
}

// Matches `[Pasted text #12]` and `[Pasted text #12 +34 lines]`. The id is the key.
const REF = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g

/** Matches the busy queue's 4 Mi-code-unit aggregate ceiling without allowing
 * this long-lived side store to retain an unbounded second copy. */
export const PASTE_STORE_MAX_RETAINED_BYTES = 8 * 1024 * 1024

export interface PasteStoreStats {
  readonly bytes: number
  readonly count: number
  readonly maxBytes: number
  readonly maxCount: number
}

export interface PasteStoreOptions {
  readonly maxRetainedBytes?: number
  readonly maxRetainedItems?: number
}

export const PASTE_STORE_MAX_RETAINED_ITEMS = 100

/** V8 may store some strings more compactly, but two bytes per UTF-16 code unit
 * is a stable conservative bound and requires no second multi-megabyte Buffer. */
function retainedBytes(text: string): number {
  return text.length * 2
}

function lineCount(text: string): number {
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  return lines
}

function referencedIds(input: string): Set<number> {
  const ids = new Set<number>()
  for (const match of input.matchAll(REF)) {
    const raw = match[1]
    if (raw !== undefined) ids.add(Number(raw))
  }
  return ids
}

export function createPasteStore(options: PasteStoreOptions = {}): PasteStore {
  const map = new Map<number, string>()
  const requestedBytes = options.maxRetainedBytes ?? PASTE_STORE_MAX_RETAINED_BYTES
  const requestedItems = options.maxRetainedItems ?? PASTE_STORE_MAX_RETAINED_ITEMS
  const maxBytes = Number.isFinite(requestedBytes) ? Math.max(0, Math.floor(requestedBytes)) : 0
  const maxCount = Number.isFinite(requestedItems) ? Math.max(0, Math.floor(requestedItems)) : 0
  let seq = 0
  let bytes = 0

  const remove = (id: number): void => {
    const text = map.get(id)
    if (text === undefined) return
    bytes -= retainedBytes(text)
    map.delete(id)
  }

  const tokenFor = (id: number, text: string): string => {
    const lines = lineCount(text)
    return lines > 1 ? `[Pasted text #${id} +${lines} lines]` : `[Pasted text #${id}]`
  }

  const add = (text: string): string | undefined => {
    const nextBytes = retainedBytes(text)
    if (map.size >= maxCount || nextBytes > maxBytes - bytes) return undefined
    const id = ++seq
    map.set(id, text)
    bytes += nextBytes
    return tokenFor(id, text)
  }

  return {
    add,
    replace(text) {
      const nextBytes = retainedBytes(text)
      if (maxCount < 1 || nextBytes > maxBytes) return undefined
      map.clear()
      bytes = 0
      return add(text)
    },
    // Preflight reference MULTIPLICITY before allocating the result. Retained
    // bytes count unique bodies, but a user can duplicate one visible token;
    // without this pass one 4 Mi-character body could expand arbitrarily many
    // times and OOM the renderer. String.replace(/g) then remains a single pass
    // over the ORIGINAL input, so refs inside pasted bodies are not re-scanned.
    expand(input, maxChars = Number.POSITIVE_INFINITY) {
      const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : Number.POSITIVE_INFINITY
      let expandedChars = input.length
      for (const match of input.matchAll(REF)) {
        const rawId = match[1]
        const body = rawId === undefined ? undefined : map.get(Number(rawId))
        if (body === undefined) continue
        expandedChars += body.length - match[0].length
      }
      if (expandedChars > limit) return undefined
      return input.replace(REF, (m, id: string) => map.get(Number(id)) ?? m)
    },
    discard(input) {
      for (const id of referencedIds(input)) remove(id)
    },
    retainOnly(input) {
      const retained = referencedIds(input)
      for (const id of map.keys()) if (!retained.has(id)) remove(id)
    },
    clear() {
      map.clear()
      bytes = 0
      // Keep ids monotonic across clears. Reusing #1 could make a stale literal
      // from a prior draft unexpectedly expand to unrelated future content.
    },
    stats() {
      return { bytes, count: map.size, maxBytes, maxCount }
    }
  }
}

/** A paste big enough to placeholder rather than inline (conservative thresholds). */
export function shouldPlaceholder(text: string): boolean {
  if (text.length > 400) return true
  let newlines = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && ++newlines >= 3) return true
  }
  return false
}
