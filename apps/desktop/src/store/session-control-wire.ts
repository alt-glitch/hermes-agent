import type {
  SessionControlDispatch,
  SessionControlGate,
  SessionControlGoal,
  SessionControlGoalContract,
  SessionControlGoalStatus,
  SessionControlHeartbeat,
  SessionControlHeartbeatStatus,
  SessionControlLoop,
  SessionControlLoopMode,
  SessionControlLoopStatus,
  SessionControlSnapshot,
  SessionControlWaitBarrier
} from './session-control'

type UnknownRecord = Record<string, unknown>

const GOAL_STATUSES = new Set<SessionControlGoalStatus>(['active', 'done', 'paused'])

const GOAL_VERDICTS = new Set<NonNullable<SessionControlGoal['last_verdict']>>([
  'blocked',
  'continue',
  'done',
  'skipped',
  'wait'
])

const LOOP_MODES = new Set<SessionControlLoopMode>(['interval', 'self_paced'])
const LOOP_STATUSES = new Set<SessionControlLoopStatus>(['active', 'done', 'paused'])
const HEARTBEAT_STATUSES = new Set<SessionControlHeartbeatStatus>(['active', 'paused'])
const DISPATCH_TYPES = new Set<SessionControlDispatch['type']>(['exec', 'send'])

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasExactFields(value: UnknownRecord, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional])

  return required.every(key => hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value)
}

function hasOptionalStrings(value: UnknownRecord, keys: string[]): boolean {
  return keys.every(key => !hasOwn(value, key) || typeof value[key] === 'string')
}

function parseGoalContract(value: unknown): SessionControlGoalContract | null {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ['outcome', 'verification', 'constraints', 'boundaries', 'stop_when'])
  ) {
    return null
  }

  if (
    typeof value.outcome !== 'string' ||
    typeof value.verification !== 'string' ||
    typeof value.constraints !== 'string' ||
    typeof value.boundaries !== 'string' ||
    typeof value.stop_when !== 'string'
  ) {
    return null
  }

  return {
    boundaries: value.boundaries,
    constraints: value.constraints,
    outcome: value.outcome,
    stop_when: value.stop_when,
    verification: value.verification
  }
}

function parseGate(value: unknown): SessionControlGate | null {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ['command', 'timeout_seconds', 'max_retries', 'attempts', 'last_exit_code'])
  ) {
    return null
  }

  if (
    typeof value.command !== 'string' ||
    !isInteger(value.timeout_seconds) ||
    !isInteger(value.max_retries) ||
    !isInteger(value.attempts) ||
    (value.last_exit_code !== null && !isInteger(value.last_exit_code))
  ) {
    return null
  }

  return {
    attempts: value.attempts,
    command: value.command,
    last_exit_code: value.last_exit_code,
    max_retries: value.max_retries,
    timeout_seconds: value.timeout_seconds
  }
}

function parseWaitBarrier(value: unknown): SessionControlWaitBarrier | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null
  }

  if (value.type === 'until') {
    if (
      !hasExactFields(value, ['type', 'until_at', 'reason']) ||
      !isFiniteNumber(value.until_at) ||
      typeof value.reason !== 'string'
    ) {
      return null
    }

    return { reason: value.reason, type: 'until', until_at: value.until_at }
  }

  if (value.type === 'session') {
    if (
      !hasExactFields(value, ['type', 'target', 'reason']) ||
      typeof value.target !== 'string' ||
      typeof value.reason !== 'string'
    ) {
      return null
    }

    return { reason: value.reason, target: value.target, type: 'session' }
  }

  if (value.type === 'pid') {
    if (
      !hasExactFields(value, ['type', 'target', 'reason']) ||
      !isInteger(value.target) ||
      typeof value.reason !== 'string'
    ) {
      return null
    }

    return { reason: value.reason, target: value.target, type: 'pid' }
  }

  return null
}

function parseGoal(value: unknown): SessionControlGoal | null {
  const required = ['title', 'status', 'turns_used', 'max_turns', 'contract', 'subgoals', 'gates']
  const optional = ['created_at', 'updated_at', 'paused_reason', 'last_verdict', 'last_reason', 'wait_barrier']

  if (!isRecord(value) || !hasExactFields(value, required, optional)) {
    return null
  }

  if (
    typeof value.title !== 'string' ||
    typeof value.status !== 'string' ||
    !GOAL_STATUSES.has(value.status as SessionControlGoalStatus) ||
    !isInteger(value.turns_used) ||
    !isInteger(value.max_turns) ||
    !Array.isArray(value.subgoals) ||
    !value.subgoals.every(subgoal => typeof subgoal === 'string') ||
    !Array.isArray(value.gates) ||
    !hasOptionalStrings(value, ['paused_reason', 'last_reason']) ||
    (hasOwn(value, 'created_at') && !isFiniteNumber(value.created_at)) ||
    (hasOwn(value, 'updated_at') && !isFiniteNumber(value.updated_at)) ||
    (hasOwn(value, 'last_verdict') &&
      (typeof value.last_verdict !== 'string' ||
        !GOAL_VERDICTS.has(value.last_verdict as NonNullable<SessionControlGoal['last_verdict']>)))
  ) {
    return null
  }

  const contract = parseGoalContract(value.contract)
  const parsedGates = value.gates.map(parseGate)
  const waitBarrier = hasOwn(value, 'wait_barrier') ? parseWaitBarrier(value.wait_barrier) : undefined

  if (!contract || parsedGates.some(gate => gate === null) || (hasOwn(value, 'wait_barrier') && !waitBarrier)) {
    return null
  }

  const gates = parsedGates.filter((gate): gate is SessionControlGate => gate !== null)

  const goal: SessionControlGoal = {
    contract,
    gates,
    max_turns: value.max_turns,
    status: value.status as SessionControlGoalStatus,
    subgoals: [...value.subgoals],
    title: value.title,
    turns_used: value.turns_used
  }

  if (hasOwn(value, 'created_at')) {
    goal.created_at = value.created_at as number
  }

  if (hasOwn(value, 'updated_at')) {
    goal.updated_at = value.updated_at as number
  }

  if (hasOwn(value, 'paused_reason')) {
    goal.paused_reason = value.paused_reason as string
  }

  if (hasOwn(value, 'last_reason')) {
    goal.last_reason = value.last_reason as string
  }

  if (hasOwn(value, 'last_verdict')) {
    goal.last_verdict = value.last_verdict as SessionControlGoal['last_verdict']
  }

  if (waitBarrier) {
    goal.wait_barrier = waitBarrier
  }

  return goal
}

function parseLoop(value: unknown): SessionControlLoop | null {
  const required = [
    'prompt',
    'status',
    'mode',
    'interval_seconds',
    'current_delay',
    'times',
    'until',
    'max_ticks',
    'ticks_fired',
    'created_at',
    'last_fired_at',
    'next_due_at',
    'awaiting_response',
    'deferred_by_goal'
  ]

  if (!isRecord(value) || !hasExactFields(value, required, ['paused_reason', 'last_stop_reason'])) {
    return null
  }

  if (
    typeof value.prompt !== 'string' ||
    typeof value.status !== 'string' ||
    !LOOP_STATUSES.has(value.status as SessionControlLoopStatus) ||
    typeof value.mode !== 'string' ||
    !LOOP_MODES.has(value.mode as SessionControlLoopMode) ||
    !isFiniteNumber(value.interval_seconds) ||
    !isFiniteNumber(value.current_delay) ||
    !isInteger(value.times) ||
    typeof value.until !== 'string' ||
    !isInteger(value.max_ticks) ||
    !isInteger(value.ticks_fired) ||
    !isFiniteNumber(value.created_at) ||
    !isFiniteNumber(value.last_fired_at) ||
    !isFiniteNumber(value.next_due_at) ||
    typeof value.awaiting_response !== 'boolean' ||
    typeof value.deferred_by_goal !== 'boolean' ||
    !hasOptionalStrings(value, ['paused_reason', 'last_stop_reason'])
  ) {
    return null
  }

  const loop: SessionControlLoop = {
    awaiting_response: value.awaiting_response,
    created_at: value.created_at,
    current_delay: value.current_delay,
    deferred_by_goal: value.deferred_by_goal,
    interval_seconds: value.interval_seconds,
    last_fired_at: value.last_fired_at,
    max_ticks: value.max_ticks,
    mode: value.mode as SessionControlLoopMode,
    next_due_at: value.next_due_at,
    prompt: value.prompt,
    status: value.status as SessionControlLoopStatus,
    ticks_fired: value.ticks_fired,
    times: value.times,
    until: value.until
  }

  if (hasOwn(value, 'paused_reason')) {
    loop.paused_reason = value.paused_reason as string
  }

  if (hasOwn(value, 'last_stop_reason')) {
    loop.last_stop_reason = value.last_stop_reason as string
  }

  return loop
}

function parseHeartbeat(value: unknown): SessionControlHeartbeat | null {
  const required = ['prompt', 'status', 'interval_seconds', 'created_at', 'last_fired_at', 'fire_count']

  if (!isRecord(value) || !hasExactFields(value, required)) {
    return null
  }

  if (
    typeof value.prompt !== 'string' ||
    typeof value.status !== 'string' ||
    !HEARTBEAT_STATUSES.has(value.status as SessionControlHeartbeatStatus) ||
    !isInteger(value.interval_seconds) ||
    !isFiniteNumber(value.created_at) ||
    !isFiniteNumber(value.last_fired_at) ||
    !isInteger(value.fire_count)
  ) {
    return null
  }

  return {
    created_at: value.created_at,
    fire_count: value.fire_count,
    interval_seconds: value.interval_seconds,
    last_fired_at: value.last_fired_at,
    prompt: value.prompt,
    status: value.status as SessionControlHeartbeatStatus
  }
}

/** Parses the stable allowlisted backend shape into fresh renderer-owned data. */
export function parseSessionControlSnapshot(value: unknown): SessionControlSnapshot | null {
  if (!isRecord(value) || !hasExactFields(value, ['goal', 'loop', 'heartbeat', 'revision', 'updated_at'])) {
    return null
  }

  if (typeof value.revision !== 'string' || !isFiniteNumber(value.updated_at)) {
    return null
  }

  const goal = value.goal === null ? null : parseGoal(value.goal)
  const loop = value.loop === null ? null : parseLoop(value.loop)
  const heartbeat = value.heartbeat === null ? null : parseHeartbeat(value.heartbeat)

  if ((value.goal !== null && !goal) || (value.loop !== null && !loop) || (value.heartbeat !== null && !heartbeat)) {
    return null
  }

  return { goal, heartbeat, loop, revision: value.revision, updated_at: value.updated_at }
}

function parseSessionControlDispatch(value: unknown): SessionControlDispatch | null {
  if (!isRecord(value) || !hasExactFields(value, ['type', 'output', 'notice', 'message', 'display'])) {
    return null
  }

  if (
    typeof value.type !== 'string' ||
    !DISPATCH_TYPES.has(value.type as SessionControlDispatch['type']) ||
    ![value.output, value.notice, value.message, value.display].every(
      field => field === null || typeof field === 'string'
    )
  ) {
    return null
  }

  return {
    display: value.display as string | null,
    message: value.message as string | null,
    notice: value.notice as string | null,
    output: value.output as string | null,
    type: value.type as SessionControlDispatch['type']
  }
}

export function parseSessionControlEventSequence(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}

export function parseSessionControlReadResponse(value: unknown) {
  if (!isRecord(value)) {
    return null
  }

  const snapshot = parseSessionControlSnapshot(value.control)

  return snapshot ? { eventSeq: parseSessionControlEventSequence(value.event_seq), snapshot } : null
}

export function parseSessionControlActionResponse(value: unknown) {
  if (!isRecord(value)) {
    return null
  }

  const snapshot = parseSessionControlSnapshot(value.control)
  const dispatch = parseSessionControlDispatch(value.dispatch)

  return snapshot && dispatch
    ? { dispatch, eventSeq: parseSessionControlEventSequence(value.event_seq), snapshot }
    : null
}
