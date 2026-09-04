/**
 * Human labels for opaque delegation ids.
 *
 * Concurrent/nested fan-outs interleave their rows, so `[3/9]` alone is
 * ambiguous. The gateway supplies a stable `delegation_id`; this process-local
 * registry maps first-seen ids to compact `set N` labels without exposing raw
 * ids in the UI. Older gateways still get the useful task-position fallback.
 */
export interface DelegationLabeler {
  readonly label: (delegationId: string | undefined) => string | undefined
}

export function createDelegationLabeler(): DelegationLabeler {
  const ordinals = new Map<string, number>()

  return {
    label: delegationId => {
      const id = delegationId?.trim()
      if (!id) return undefined
      let ordinal = ordinals.get(id)
      if (ordinal === undefined) {
        ordinal = ordinals.size + 1
        ordinals.set(id, ordinal)
      }
      return `set ${String(ordinal)}`
    }
  }
}

const processLabels = createDelegationLabeler()

/** Stable for the lifetime of this TUI process. */
export function delegationSetLabel(delegationId: string | undefined): string | undefined {
  return processLabels.label(delegationId)
}

/** `[set N · 3/9]`, `[3/9]` on an older gateway, or `[set N]` for one task. */
export function delegationTaskPrefix(
  delegationId: string | undefined,
  index: number | undefined,
  taskCount: number | undefined
): string {
  const set = delegationSetLabel(delegationId)
  const count = taskCount ?? 1
  const task = (index ?? 0) + 1
  if (count > 1) return `[${set ? `${set} · ` : ''}${String(task)}/${String(count)}] `
  return set ? `[${set}] ` : ''
}
