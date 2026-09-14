/** Synthetic high-fan-out native navigation demo; no gateway or model calls.
 * node scripts/build.mjs scripts/agent-navigation.tsx .accept-agents
 * node --experimental-ffi .accept-agents/agent-navigation.js [--tree]
 */
import { createCliRenderer } from '@opentui/core'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { KeymapProvider } from '@opentui/keymap/solid'
import { render } from '@opentui/solid'

import { installFfiCoordSafety } from '../src/boundary/ffiSafe.ts'
import { createSessionStore } from '../src/logic/store.ts'
import { seedAgentFanout } from '../src/test/lib/agentFanout.ts'
import { App } from '../src/view/App.tsx'
import { ThemeProvider } from '../src/view/theme.tsx'

installFfiCoordSafety()
const store = createSessionStore()
store.apply({ type: 'gateway.ready' })
seedAgentFanout(store)
if (process.argv.includes('--tree')) store.openDashboard('worker-011')
const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useKittyKeyboard: {},
  useMouse: true
})
const keymap = createDefaultOpenTuiKeymap(renderer)
await render(
  () => (
    <KeymapProvider keymap={keymap}>
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} />
      </ThemeProvider>
    </KeymapProvider>
  ),
  renderer
)
