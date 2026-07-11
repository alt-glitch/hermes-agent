/**
 * DEV DEMO — NOT a test, NOT production. Renders the bench fixture (lorem-ipsum +
 * fat tool-turns from ./fixture.ts) in a REAL CliRenderer so you can attach over
 * tmux, scroll, and eyeball the transcript + the rolling-cap truncation notice.
 * No gateway is spawned (purely the fixture seeded into the store via the resume
 * path), so typing won't reach a backend — it's for viewing/scrolling.
 *
 * Run (Node 26 — needs the esbuild/Solid transform, then --experimental-ffi):
 *   node scripts/build.mjs scripts/demo.tsx .demo
 *   node --experimental-ffi --no-warnings .demo/demo.js      # inside tmux (needs a TTY)
 *   DEMO_TOTAL=200               fixture messages to seed (default 200)
 *   HERMES_TUI_MAX_MESSAGES=80   cap → the "⤒ N earlier messages" notice fires
 * Quit: Ctrl+C.
 */
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'

import { installMultiClickSelection } from '../src/boundary/multiClickSelect.ts'
import { registerRemoteParsers } from '../src/boundary/parsers.ts'
import { createSessionStore } from '../src/logic/store.ts'
import { App } from '../src/view/App.tsx'
import { ThemeProvider } from '../src/view/theme.tsx'
import { materialize } from './fixture.ts'

// Same grammar registration as the live entry so fixture code blocks highlight
// (fetched+cached on first use; no HERMES_TUI_PARSER_CACHE here → OpenTUI default).
registerRemoteParsers()

const TOTAL = Number.parseInt(process.env.DEMO_TOTAL ?? '', 10) || 200

const store = createSessionStore()
store.apply({ type: 'gateway.ready' })
store.setSessionId('demo-fixture-20260609')
// Seed via the resume path so the cap slices + the `dropped` counter is set
// (drives the truncation notice) exactly as a real `session.resume` would.
store.beginBuffer()
store.commitSnapshot(materialize(TOTAL))

const renderer = await createCliRenderer({
  externalOutputMode: 'passthrough',
  targetFps: 60,
  exitOnCtrlC: true,
  useKittyKeyboard: {},
  useMouse: true
})
// Same seam the live entry installs (boundary/renderer.ts) so the demo smokes
// double-click word / triple-click line / drag-extend too.
installMultiClickSelection(renderer)

// `render()` is async in @opentui/solid: awaiting it lets the renderer attach
// and start its native render loop before this gateway-free script reaches
// the end of the module.  A fire-and-forget call exits 0 without painting,
// which makes PTY/termctrl smoke tests report an empty screen.
await render(
  () => (
    <ThemeProvider theme={() => store.state.theme}>
      <App store={store} />
    </ThemeProvider>
  ),
  renderer
)
