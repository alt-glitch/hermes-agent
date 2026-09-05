import { createCliRenderer } from '@opentui/core'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { KeymapProvider } from '@opentui/keymap/solid'
import { render, useKeyboard } from '@opentui/solid'
import { installFfiCoordSafety } from '../src/boundary/ffiSafe.ts'
import { registerRemoteParsers } from '../src/boundary/parsers.ts'
import { createSessionStore } from '../src/logic/store.ts'
import { DimensionsProvider } from '../src/view/dimensions.tsx'
import { AgentsDashboard } from '../src/view/overlays/agentsDashboard.tsx'
import { ThemeProvider } from '../src/view/theme.tsx'

// Sanitized deterministic renderer fixture. No gateway, credentials or model calls.
// 2 appends messages, 3 finishes, 4 adds rows. Verify backend delivery separately.
installFfiCoordSafety()
registerRemoteParsers()
const store = createSessionStore()
store.apply({ type: 'gateway.ready' })
store.apply({ type: 'message.start' })
const now = Date.now() / 1000
for (const [id, goal, label, parent, offset] of [
  [
    'lead',
    'Review the release and delegate a focused dependency audit, then explain the result.',
    'Review release',
    null,
    30
  ],
  ['child', 'Read dependency manifests and verify native runtime compatibility.', 'Audit dependencies', 'lead', 18],
  ['tests', 'Run the focused contract tests and report any failures.', 'Verify contracts', null, 24]
] as const) {
  store.apply({
    type: 'subagent.start',
    payload: {
      subagent_id: id,
      goal,
      task_label: label,
      parent_id: parent,
      depth: parent ? 1 : 0,
      started_at: now - offset,
      model: 'fixture-model'
    }
  })
}
store.apply({
  type: 'subagent.text',
  payload: {
    subagent_id: 'lead',
    text: '## Release review\n\nI am checking **runtime compatibility** while the other agents verify dependencies and contracts.\n\n'
  }
})
store.apply({ type: 'subagent.tool', payload: { subagent_id: 'child', tool_name: 'read_file', text: 'package.json' } })
store.apply({
  type: 'subagent.text',
  payload: {
    subagent_id: 'child',
    text: 'The native packages match the installed runtime.\n\n| Package | Result |\n| --- | --- |\n| Core | Compatible |\n| Solid | Compatible |\n'
  }
})
store.apply({
  type: 'subagent.complete',
  payload: {
    subagent_id: 'tests',
    status: 'failed',
    duration_seconds: 12,
    summary: 'One contract failed: the disabled-progress path drops child messages.'
  }
})
const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: true,
  useKittyKeyboard: {},
  openConsoleOnError: false
})
let step = 0
function Fixture() {
  useKeyboard(key => {
    if (key.name === '2') {
      step += 1
      store.apply({
        type: 'subagent.text',
        payload: {
          subagent_id: 'lead',
          text: `Update ${String(step)}: messages stay ordered while the dependency agent finishes.\n\n`
        }
      })
    }
    if (key.name === '3') {
      for (const id of store.state.subagents.filter(agent => agent.status === 'running').map(agent => agent.id)) {
        const agent = store.state.subagents.find(item => item.id === id)
        const summary = agent?.trace?.filter(entry => entry.kind === 'reply').at(-1)?.text ?? 'Complete'
        store.apply({
          type: 'subagent.complete',
          payload: {
            subagent_id: id,
            status: 'completed',
            summary: summary.slice(0, 500),
            duration_seconds: id === 'lead' ? 35 : 23
          }
        })
      }
      store.apply({ type: 'message.complete', payload: { text: 'Fixture complete' } })
    }
    if (key.name === '4') {
      for (let index = 0; index < 40; index += 1)
        store.apply({
          type: 'subagent.start',
          payload: {
            subagent_id: `extra-${String(index)}`,
            goal: `Inspect module ${String(index)}`,
            parent_id: 'lead',
            depth: 1,
            started_at: now
          }
        })
    }
  })
  return (
    <KeymapProvider keymap={createDefaultOpenTuiKeymap(renderer)}>
      <DimensionsProvider>
        <ThemeProvider theme={() => store.state.theme}>
          <box flexDirection="column" width="100%" height="100%">
            <text flexShrink={0}>
              Synthetic agent fixture · 2 append · 3 complete/replay · 4 add rows · Ctrl+C quit
            </text>
            <AgentsDashboard
              subagents={store.state.subagents}
              history={store.state.spawnHistory}
              onClose={() => renderer.destroy()}
            />
          </box>
        </ThemeProvider>
      </DimensionsProvider>
    </KeymapProvider>
  )
}
await render(() => <Fixture />, renderer)
