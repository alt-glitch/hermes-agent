/** Pure state/formatting helpers for the unified Sessions orchestrator. */

const DEFAULT_VISIBLE_ROWS = 12
const DEFAULT_TITLE_MAX = 64
const TUI_SESSION_MODEL_FLAG = '--tui-session'

export interface ActiveSessionRow {
  readonly id: string
  readonly session_key?: string
  readonly status?: string
  readonly current?: boolean
  readonly title?: string
  readonly preview?: string
  readonly model?: string
}

export interface SessionHistoryRow {
  readonly id: string
  readonly message_count: number
  readonly preview: string
  readonly started_at: number
  readonly title: string
  readonly model?: string
  readonly cwd?: string
}

const STATUS_GLYPHS: Readonly<Record<string, string>> = {
  idle: '✓',
  starting: '…',
  waiting: '?',
  working: '▶'
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  idle: 'idle',
  starting: 'starting',
  waiting: 'waiting',
  working: 'working'
}

export function sessionStatusGlyph(status = 'idle'): string {
  return STATUS_GLYPHS[status] ?? '·'
}

export function sessionStatusLabel(status = 'idle'): string {
  return STATUS_LABELS[status] ?? status
}

export function shortSessionModel(model = ''): string {
  return model.replace(/^.*\//, '') || 'model?'
}

export function activeSessionCountLabel(count: number): string {
  return `${count} live ${count === 1 ? 'session' : 'sessions'}`
}

export function sessionsCountLabel(liveCount: number, resumableCount: number): string {
  return `${liveCount} live · ${resumableCount} resumable`
}

export type SessionRowKind = 'history' | 'live' | 'new'

/** Rows are ordered [new][live…][history…]. */
export function sessionRowKindAt(index: number, liveCount: number): SessionRowKind {
  if (index <= 0) return 'new'
  return index - 1 < liveCount ? 'live' : 'history'
}

export function relativeSessionAge(timestampSeconds?: number, nowMs = Date.now()): string {
  if (!timestampSeconds) return ''
  const days = (nowMs / 1000 - timestampSeconds) / 86400
  if (days < 1) return 'today'
  if (days < 2) return 'yesterday'
  return `${Math.floor(days)}d ago`
}

/** Drop already-live sessions from resumable history, preserving DB order. */
export function resumableHistory<T extends SessionHistoryRow>(
  history: readonly T[],
  live: readonly ActiveSessionRow[]
): T[] {
  const liveIds = new Set(
    live.flatMap(session => {
      const durableKey = session.session_key?.trim()
      return durableKey ? [session.id, durableKey] : [session.id]
    })
  )
  return history.filter(session => !liveIds.has(session.id))
}

export type OrchestratorHintRole = 'hotkey' | 'label' | 'text'

export interface OrchestratorHintSegment {
  readonly role: OrchestratorHintRole
  readonly text: string
}

export const resumeRowContextHintSegments: readonly OrchestratorHintSegment[] = [
  { role: 'label', text: 'Resumable:' },
  { role: 'text', text: ' ' },
  { role: 'hotkey', text: 'Enter' },
  { role: 'text', text: ' resume · ' },
  { role: 'hotkey', text: 'd' },
  { role: 'text', text: ' delete' }
]

export function orchestratorContextHintSegments(newSelected: boolean): readonly OrchestratorHintSegment[] {
  return newSelected
    ? [
        { role: 'label', text: 'New row:' },
        { role: 'text', text: ' type prompt · ' },
        { role: 'hotkey', text: 'Enter' },
        { role: 'text', text: ' start · ' },
        { role: 'hotkey', text: 'Tab' },
        { role: 'text', text: ' model' }
      ]
    : [
        { role: 'label', text: 'Session row:' },
        { role: 'text', text: ' ' },
        { role: 'hotkey', text: 'Enter' },
        { role: 'text', text: ' switch · ' },
        { role: 'hotkey', text: 'Ctrl+D' },
        { role: 'text', text: ' close' }
      ]
}

export const orchestratorGlobalHotkeyHintSegments: readonly OrchestratorHintSegment[] = [
  { role: 'hotkey', text: '↑↓' },
  { role: 'text', text: ' move · ' },
  { role: 'hotkey', text: 'Ctrl+N' },
  { role: 'text', text: ' new · ' },
  { role: 'hotkey', text: 'Ctrl+R' },
  { role: 'text', text: ' refresh · ' },
  { role: 'hotkey', text: 'Esc' },
  { role: 'text', text: ' close' }
]

function hintText(segments: readonly OrchestratorHintSegment[]): string {
  return segments.map(segment => segment.text).join('')
}

export function orchestratorContextHint(newSelected: boolean): string {
  return hintText(orchestratorContextHintSegments(newSelected))
}

export const orchestratorGlobalHotkeyHint = hintText(orchestratorGlobalHotkeyHintSegments)

export function newSessionRowIndex(sessionCount: number): number {
  return Math.max(0, sessionCount)
}

export function isNewSessionRow(index: number, sessionCount: number): boolean {
  return index >= newSessionRowIndex(sessionCount)
}

export function canTypeOrchestratorPrompt(index: number, sessionCount: number): boolean {
  return isNewSessionRow(index, sessionCount)
}

export function clampOrchestratorSelection(index: number, sessionCount: number): number {
  return Math.max(0, Math.min(index, newSessionRowIndex(sessionCount)))
}

export function currentSessionSelectionIndex(
  sessions: readonly ActiveSessionRow[],
  currentSessionId: string | null
): number {
  const index = sessions.findIndex(
    session => Boolean(session.current) || (Boolean(currentSessionId) && session.id === currentSessionId)
  )
  return index >= 0 ? index : 0
}

function windowOffset(count: number, selected: number, visible: number): number {
  return Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible))
}

export function orchestratorVisibleRowIndexes(
  sessionCount: number,
  selected: number,
  visible = DEFAULT_VISIBLE_ROWS
): number[] {
  const total = Math.max(0, sessionCount) + 1
  const clamped = clampOrchestratorSelection(selected, sessionCount)
  const safeVisible = Math.max(1, visible)
  const offset = windowOffset(total, clamped, safeVisible)
  const count = Math.min(safeVisible, total - offset)
  return Array.from({ length: count }, (_, index) => offset + index)
}

export type CloseFallback =
  | { readonly action: 'activate'; readonly sessionId: string }
  | { readonly action: 'new' }
  | { readonly action: 'stay' }

export function closeFallbackAfterClose(
  closedId: string,
  currentSessionId: string | null,
  remaining: readonly ActiveSessionRow[]
): CloseFallback {
  if (!currentSessionId || closedId !== currentSessionId) return { action: 'stay' }
  const next = remaining.find(session => session.id !== closedId)
  return next ? { action: 'activate', sessionId: next.id } : { action: 'new' }
}

export function draftModelArgFromPickerValue(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  const kept = parts.filter(part => part !== TUI_SESSION_MODEL_FLAG && part !== '--global' && part !== '--session')

  return kept.length ? `${kept.join(' ')} --session` : ''
}

export function draftModelNameFromArg(value: string): string {
  const parts = draftModelArgFromPickerValue(value).split(/\s+/).filter(Boolean)
  const modelParts: string[] = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part === undefined) continue
    if (part === '--provider') {
      index++
      continue
    }
    if (!part.startsWith('--')) modelParts.push(part)
  }
  return modelParts.join(' ').trim()
}

export function draftModelDisplayLabel(value: string): string {
  const modelName = draftModelNameFromArg(value)
  return modelName ? shortSessionModel(modelName) : 'current/default'
}

export type OrchestratorRowClickAction =
  | { readonly action: 'activate'; readonly sessionId: string }
  | { readonly action: 'select-new' }

export function orchestratorRowClickAction(
  index: number,
  sessions: readonly ActiveSessionRow[]
): OrchestratorRowClickAction {
  const target = sessions[index]
  return target && !isNewSessionRow(index, sessions.length)
    ? { action: 'activate', sessionId: target.id }
    : { action: 'select-new' }
}

export type UnifiedSessionRowAction =
  | { readonly action: 'activate'; readonly sessionId: string }
  | { readonly action: 'resume'; readonly sessionId: string }
  | { readonly action: 'select-new' }

/** Resolve a click in the pinned-new unified layout. */
export function unifiedSessionRowAction(
  index: number,
  live: readonly ActiveSessionRow[],
  history: readonly SessionHistoryRow[]
): UnifiedSessionRowAction {
  const kind = sessionRowKindAt(index, live.length)
  if (kind === 'new') return { action: 'select-new' }
  if (kind === 'live') {
    const session = live[index - 1]
    return session ? { action: 'activate', sessionId: session.id } : { action: 'select-new' }
  }
  const session = history[index - 1 - live.length]
  return session ? { action: 'resume', sessionId: session.id } : { action: 'select-new' }
}

export function draftTitleFromPrompt(prompt: string, max = DEFAULT_TITLE_MAX): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Preserve the selected row identity when a live poll reorders either list. */
export function reanchorOrchestratorSelection(
  selected: number,
  previousLive: readonly ActiveSessionRow[],
  previousHistory: readonly SessionHistoryRow[],
  nextLive: readonly ActiveSessionRow[],
  nextHistory: readonly SessionHistoryRow[]
): number {
  if (selected <= 0) return 0
  const maximum = nextLive.length + nextHistory.length
  const clamped = Math.max(0, Math.min(selected, maximum))
  if (selected - 1 < previousLive.length) {
    const id = previousLive[selected - 1]?.id
    const index = id === undefined ? -1 : nextLive.findIndex(session => session.id === id)
    return index >= 0 ? index + 1 : clamped
  }
  const id = previousHistory[selected - 1 - previousLive.length]?.id
  const index = id === undefined ? -1 : nextHistory.findIndex(session => session.id === id)
  return index >= 0 ? 1 + nextLive.length + index : clamped
}
