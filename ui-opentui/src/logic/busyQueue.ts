/** Busy-input policy + bounded queue helpers.
 *
 * Ink keeps the queue outside the transcript and shows at most three rows. The
 * OpenTUI store uses the same contract, with explicit ceilings so repeatedly
 * pasting while a turn runs cannot retain unbounded user input in the renderer
 * process. Rejections are surfaced by the caller; nothing is silently dropped.
 */

export const BUSY_INPUT_MODES = ['interrupt', 'queue', 'steer'] as const
export type BusyInputMode = (typeof BUSY_INPUT_MODES)[number]

/** Ink's full-screen TUI defaults to queue even though the classic CLI defaults
 * to interrupt; a persisted config value can override it after bootstrap. */
export const DEFAULT_BUSY_INPUT_MODE: BusyInputMode = 'queue'

export const BUSY_QUEUE_WINDOW = 3
export const BUSY_QUEUE_MAX_ITEMS = 100
export const BUSY_QUEUE_MAX_CHARS = 4 * 1024 * 1024
/** Loading a very large row into OpenTUI's native textarea is nonlinear for
 * wide/non-ASCII input. Keep the row queued (and still sendable/deletable), but
 * do not copy more than this into the editable native buffer. Benchmarked at
 * <100ms p95 with 16Ki UTF-16 code units on the target device. */
export const BUSY_QUEUE_MAX_EDIT_CHARS = 16 * 1024

const MODES = new Set<string>(BUSY_INPUT_MODES)

export function normalizeBusyInputMode(value: unknown): BusyInputMode {
  if (typeof value !== 'string') return DEFAULT_BUSY_INPUT_MODE
  const normalized = value.trim().toLowerCase()
  return MODES.has(normalized) ? (normalized as BusyInputMode) : DEFAULT_BUSY_INPUT_MODE
}

export interface QueueWindow {
  readonly end: number
  readonly showLead: boolean
  readonly showTail: boolean
  readonly start: number
}

/** Keep the active edit row visible in Ink's three-row queue window. */
export function queueWindow(length: number, editIndex: number | undefined): QueueWindow {
  const safeLength = Math.max(0, Math.floor(length))
  const start =
    editIndex === undefined
      ? 0
      : Math.max(0, Math.min(Math.floor(editIndex) - 1, Math.max(0, safeLength - BUSY_QUEUE_WINDOW)))
  const end = Math.min(safeLength, start + BUSY_QUEUE_WINDOW)
  return { end, showLead: start > 0, showTail: end < safeLength, start }
}

/** Collapse a queued prompt to one bounded display row without scanning a
 * multi-megabyte paste merely to render its preview. */
export function queuePreview(text: string, width: number): string {
  const limit = Math.max(16, Math.floor(width))
  const probe = text.slice(0, Math.min(text.length, limit * 4 + 64))
  const compact = probe.replace(/\s+/g, ' ').trim()
  if (compact.length <= limit && probe.length === text.length) return compact
  return `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

export function queuedCharacterCount(items: readonly string[]): number {
  let total = 0
  for (const item of items) total += item.length
  return total
}

/** Whether adding/replacing a row stays inside both queue ceilings. */
export function queueAccepts(
  items: readonly string[],
  text: string,
  replacingIndex?: number,
  reservedItems = 0,
  reservedChars = 0
): boolean {
  const replacing = replacingIndex !== undefined && replacingIndex >= 0 && replacingIndex < items.length
  const safeReservedItems = Math.max(0, Math.floor(reservedItems))
  const safeReservedChars = Math.max(0, Math.floor(reservedChars))
  const nextCount = items.length + safeReservedItems + (replacing ? 0 : 1)
  if (nextCount > BUSY_QUEUE_MAX_ITEMS) return false
  const replacedChars = replacing ? (items[replacingIndex]?.length ?? 0) : 0
  return queuedCharacterCount(items) - replacedChars + safeReservedChars + text.length <= BUSY_QUEUE_MAX_CHARS
}

/** Read the TUI-specific mode from a decoded `config.get full` payload. Missing
 * display/key intentionally resolves to the safer full-screen default (`queue`),
 * unlike the classic CLI's `config.get busy` default. */
export function busyInputModeFromConfig(config: Readonly<Record<string, unknown>>): BusyInputMode {
  const display = config['display']
  const rawMode =
    display && typeof display === 'object' && !Array.isArray(display) && 'busy_input_mode' in display
      ? display.busy_input_mode
      : undefined
  return normalizeBusyInputMode(rawMode)
}
