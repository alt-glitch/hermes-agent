/**
 * manage_connections card: the pure half. The reducer folds `connection.request`
 * / `connection.update` frames into the one open card, and the phase table maps
 * a target's state to what the card shows. No Solid, no transport. Ported from
 * Ink's `connectionOperationStore.ts` and the phase logic in
 * `connectionSetupOverlay.tsx`.
 */
import type {
  ConnectionEnvField,
  ConnectionRequestPayload,
  ConnectionTarget,
  ConnectionUpdatePayload
} from '../boundary/schema/Connection.ts'

export interface ConnectionCard {
  readonly opId: string
  readonly seq: number
  readonly deadlineAt: number
  readonly targets: readonly ConnectionTarget[]
}

const OPERATION_MEMORY = 64

/** Op ids that settled or were dismissed: a late request frame for one never reopens the card. */
export class ConnectionOpMemory {
  private readonly settled: string[] = []
  private readonly dismissed: string[] = []

  isSettled(opId: string): boolean {
    return this.settled.includes(opId)
  }

  isDismissed(opId: string): boolean {
    return this.dismissed.includes(opId)
  }

  markSettled(opId: string): void {
    remember(this.settled, opId)
  }

  markDismissed(opId: string): void {
    remember(this.dismissed, opId)
  }
}

function remember(ids: string[], opId: string): void {
  if (ids.includes(opId)) return
  ids.push(opId)
  if (ids.length > OPERATION_MEMORY) ids.shift()
}

/** `connection.request` (or a resume's `pending_connection`): open or refresh the card. */
export function requestCard(
  current: ConnectionCard | undefined,
  payload: ConnectionRequestPayload,
  memory: ConnectionOpMemory
): ConnectionCard | undefined {
  if (memory.isSettled(payload.op_id) || memory.isDismissed(payload.op_id)) return current
  if (current?.opId === payload.op_id && payload.seq <= current.seq) return current
  return { opId: payload.op_id, seq: payload.seq, deadlineAt: payload.deadline_at, targets: payload.targets }
}

export interface UpdateResult {
  readonly card: ConnectionCard | undefined
  /** Transcript lines for a settlement; the card is gone by then, so these are the only record. */
  readonly lines: readonly string[]
}

const outcomeWord = (target: ConnectionTarget): string =>
  target.state === 'connected' ? 'connected' : target.state === 'skipped' ? 'skipped' : 'not connected'

/** `connection.update`: move rows on a newer frame, or settle and report each outcome. */
export function updateCard(
  current: ConnectionCard | undefined,
  payload: ConnectionUpdatePayload,
  memory: ConnectionOpMemory
): UpdateResult {
  const shown = current?.opId === payload.op_id
  if (payload.settled) {
    memory.markSettled(payload.op_id)
    const card = shown ? undefined : current
    if (!shown && !memory.isDismissed(payload.op_id)) return { card, lines: [] }
    return { card, lines: payload.targets.map(target => `${target.name}: ${outcomeWord(target)}`) }
  }
  if (!current || !shown || payload.seq <= current.seq) return { card: current, lines: [] }
  return {
    card: { ...current, seq: payload.seq, deadlineAt: payload.deadline_at, targets: payload.targets },
    lines: []
  }
}

export type ConnectionPhase = 'authorized' | 'browser' | 'form' | 'retry' | 'working'

const RESOLVED = new Set(['connected', 'skipped', 'not_connected'])

/** A row still needs the user: not resolved, or connected but its tools failed to load. */
export const isUnresolved = (target: ConnectionTarget): boolean =>
  !RESOLVED.has(target.state) || (target.state === 'connected' && Boolean(target.discovery_error))

export const unresolvedTargets = (card: ConnectionCard): readonly ConnectionTarget[] =>
  card.targets.filter(isUnresolved)

export const envFields = (target: ConnectionTarget): readonly ConnectionEnvField[] => target.required_env ?? []

export const hasFailed = (target: ConnectionTarget): boolean => target.state === 'failed' || target.state === 'expired'

export function phaseOf(target: ConnectionTarget): ConnectionPhase {
  if (target.state === 'connected') return 'authorized'
  if (hasFailed(target)) return envFields(target).length ? 'form' : 'retry'
  if (target.state === 'initiated') return target.connect_url ? 'browser' : 'working'
  return 'form'
}

const VERBS: Record<string, string> = {
  authorize: 'Authorize',
  connect: 'Connect',
  enable: 'Enable',
  install: 'Install',
  reconnect: 'Reconnect'
}

/** Title verb for the target's action. An unknown upstream verb is capitalized, not dropped. */
export const verbOf = (action: string): string =>
  VERBS[action] ?? (action ? action.charAt(0).toUpperCase() + action.slice(1) : 'Connect')

export const failureLine = (target: ConnectionTarget): string =>
  target.state === 'expired' ? 'The link expired.' : 'That did not work.'

export const fieldLabel = (field: ConnectionEnvField): string => field.prompt || field.name

/** Draft seed: non-secret fields start from their default, secrets always start empty. */
export const initialDraft = (fields: readonly ConnectionEnvField[]): Record<string, string> =>
  Object.fromEntries(fields.map(field => [field.name, field.secret ? '' : field.default]))

export const missingRequired = (
  fields: readonly ConnectionEnvField[],
  draft: Readonly<Record<string, string>>
): ConnectionEnvField | undefined => fields.find(field => field.required && !draft[field.name]?.trim())

export const CONNECTION_HINTS: Record<ConnectionPhase | 'finishing', string> = {
  finishing: 'Esc close · Ctrl+C stop the turn',
  authorized: 'Enter or Esc continue',
  browser: 'Enter open in browser · Esc skip · Ctrl+C stop the turn',
  working: 'Esc skip · Ctrl+C stop the turn',
  retry: '←/→ select · Enter confirm · Esc skip · Ctrl+C stop the turn',
  form: '↑/↓ or Tab move · ←/→ select · Enter confirm · Esc skip · Ctrl+C stop the turn'
}
