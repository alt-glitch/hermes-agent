import { describe, expect, test } from 'vitest'

import { createDelegationLabeler, delegationTaskPrefix } from '../logic/delegationLabels.ts'
import type { DashboardAgent } from '../view/overlays/agents/model.ts'
import { AgentsDashboard } from '../view/overlays/agentsDashboard.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame } from './lib/render.ts'

describe('delegation labels', () => {
  test('opaque ids receive stable first-seen human ordinals', () => {
    const labels = createDelegationLabeler()
    expect(labels.label('deleg_alpha')).toBe('set 1')
    expect(labels.label('deleg_beta')).toBe('set 2')
    expect(labels.label('deleg_alpha')).toBe('set 1')
    expect(labels.label(undefined)).toBeUndefined()
    expect(labels.label('  ')).toBeUndefined()
  })

  test('task prefixes retain a useful position fallback for older gateways', () => {
    expect(delegationTaskPrefix(undefined, 2, 9)).toBe('[3/9] ')
    expect(delegationTaskPrefix(undefined, 0, 1)).toBe('')
  })

  test('agent rows render one stable set label for an interleaved batch', async () => {
    const rows: readonly DashboardAgent[] = [
      {
        delegationId: 'deleg_render_batch',
        depth: 0,
        goal: 'Audit API',
        id: 'a1',
        index: 0,
        parentId: null,
        status: 'running',
        taskCount: 2
      },
      {
        delegationId: 'deleg_render_batch',
        depth: 0,
        goal: 'Audit UI',
        id: 'a2',
        index: 1,
        parentId: null,
        status: 'running',
        taskCount: 2
      }
    ]
    const frame = await captureFrame(
      () => (
        <ThemeProvider>
          <AgentsDashboard subagents={rows} onClose={() => {}} />
        </ThemeProvider>
      ),
      { height: 28, until: 'Audit UI', width: 100 }
    )
    const first = /\[(set \d+) · 1\/2\]/.exec(frame)
    const second = /\[(set \d+) · 2\/2\]/.exec(frame)
    expect(first?.[1]).toBeDefined()
    expect(second?.[1]).toBe(first?.[1])
  })
})
