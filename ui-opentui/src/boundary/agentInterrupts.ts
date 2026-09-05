import { Option } from 'effect'

import { decodeSubagentInterruptResponse } from './schema/Delegation.ts'

export function createAgentInterrupts(request: (id: string) => Promise<unknown>) {
  async function interrupt(id: string): Promise<boolean> {
    const decoded = decodeSubagentInterruptResponse(await request(id))
    if (Option.isNone(decoded)) throw new Error(`invalid interrupt response: ${id}`)
    return decoded.value.found
  }

  return {
    interrupt: async (id: string): Promise<string> => {
      return (await interrupt(id)) ? `killing ${id}` : `not found: ${id}`
    },
    interruptSubtree: async (ids: readonly string[]): Promise<string> => {
      // Wait for every request, including when one fails, so the dashboard's
      // pending gate covers the actual lifetime of the whole subtree action.
      const results = await Promise.allSettled([...new Set(ids)].map(interrupt))
      const failed = results.filter(result => result.status === 'rejected').length
      const found = results.filter(result => result.status === 'fulfilled' && result.value).length
      const missing = results.length - failed - found
      const summary = `${String(found)} stop requested · ${String(missing)} already finished/not found`
      if (failed > 0) throw new Error(`${summary} · ${String(failed)} failed — retry available`)
      return summary
    }
  }
}
