import type { SubagentInfo, SessionStore } from '../../logic/store.ts'

/** Synthetic ownership and messages only; no model calls or personal sessions. */
export function agentFanout(): SubagentInfo[] {
  const startedAt = Date.now() - 300_000
  return Array.from({ length: 223 }, (_, index) => {
    const id = `worker-${String(index).padStart(3, '0')}`
    const parent = index === 0 || index === 12 ? undefined : index < 12 ? index - 1 : index % 12
    return {
      id,
      depth: index < 12 ? index : parent === undefined ? 0 : parent + 1,
      ...(parent === undefined ? {} : { parentId: `worker-${String(parent).padStart(3, '0')}` }),
      goal: `Task ${String(index).padStart(3, '0')} — verify the assigned component`,
      status: 'running',
      startedAt: startedAt + index * 500,
      trace: [{ kind: 'reply', text: `Report from ${id}` }]
    }
  })
}

export function seedAgentFanout(store: SessionStore): void {
  for (const agent of agentFanout()) {
    store.apply({
      type: 'subagent.start',
      payload: {
        subagent_id: agent.id,
        goal: agent.goal,
        depth: agent.depth,
        ...(agent.parentId === undefined ? {} : { parent_id: agent.parentId }),
        ...(agent.startedAt === undefined ? {} : { started_at: agent.startedAt })
      }
    })
    store.apply({ type: 'subagent.text', payload: { subagent_id: agent.id, text: `Report from ${agent.id}` } })
  }
}
