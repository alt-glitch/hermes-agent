import type { McpServerStatus } from './store.ts'

/** Per-server annotation from `session.info.mcp_servers`: a `lazy` server is
 *  registered from the schema cache (tools callable, process not spawned) and
 *  reads `N tools (lazy)` instead of looking unavailable (Ink abdb402701). */
export function mcpServerNote(status: McpServerStatus | undefined): { tools: string; lazy: boolean } | undefined {
  if (!status) return undefined
  if (status.status === 'lazy') return { lazy: true, tools: `${status.tools} tool${status.tools === 1 ? '' : 's'}` }
  if (status.connected && status.tools > 0)
    return { lazy: false, tools: `${status.tools} tool${status.tools === 1 ? '' : 's'}` }
  return undefined
}
