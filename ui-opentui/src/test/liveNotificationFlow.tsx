/**
 * Deterministic end-to-end notification acceptance harness.
 *
 * Real path: native OpenTUI renderer + keyboard/mouse, Solid store, Effect
 * GatewayService, Python stdio transport, tui_gateway, AIAgent, SessionDB,
 * terminal tool, host subprocesses, process registry, notification poller,
 * persistence, and fresh session.resume hydration.
 *
 * Controlled seam: a local HTTP server supplies deterministic OpenAI-compatible
 * streaming responses. It is a protocol fixture, NOT a live-model check.
 *
 * Invoked by scripts/acceptance.sh; it may also be built and run directly:
 *   node scripts/build.mjs src/test/liveNotificationFlow.tsx .accept
 *   node --experimental-ffi --no-warnings .accept/liveNotificationFlow.js
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ManagedRuntime } from 'effect'

import { GatewayService, type GatewayTransport } from '../boundary/gateway/GatewayService.ts'
import { liveGatewayLayer } from '../boundary/gateway/liveGateway.ts'
import type { GatewayEvent } from '../boundary/schema/GatewayEvent.ts'
import { createSession, resumeSession } from '../boundary/sessionLifecycle.ts'
import { dispatchSlash, type SlashContext } from '../logic/slash.ts'
import { createSessionStore, type SessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

const FIXTURE_LABEL = 'DETERMINISTIC LOCAL OPENAI-WIRE FIXTURE — NOT A LIVE MODEL'
const SPAWN_REQUEST = 'FIXTURE_SPAWN_REQUEST'
const HOLD_REQUEST = 'FIXTURE_HOLD_REQUEST'
const QUEUED_INPUT = 'FIXTURE_QUEUED_INPUT'
const HOLD_STARTED = 'FIXTURE_HOLD_STREAM_STARTED'
const QUEUED_RESPONSE = 'FIXTURE_QUEUED_RESPONSE'
const LARGE_HEAD = 'LARGE_HEAD_SENTINEL'
const LARGE_TAIL = 'LARGE_TAIL_SENTINEL'
const SUCCESS_DETAIL = 'SUCCESS_DETAIL_SENTINEL'
const NONZERO_DETAIL = 'NONZERO_DETAIL_SENTINEL'
const CANCEL_DETAIL = 'CANCEL_DETAIL_SENTINEL'
const READY_TIMEOUT_MS = 30_000
const FLOW_TIMEOUT_MS = 60_000

type ProcKind = 'success' | 'nonzero' | 'large' | 'cancel'
type JsonRecord = Record<string, unknown>

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

interface FixtureState {
  readonly holdStarted: Deferred
  readonly releaseHold: Deferred
  readonly procIds: Partial<Record<ProcKind, string>>
  readonly requests: JsonRecord[]
  largeLogResult?: string
}

function deferred(): Deferred {
  let resolve = (): void => {}
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

function messageText(message: unknown): string {
  const record = asRecord(message)
  const content = record?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (typeof part === 'string') return part
      const value = asRecord(part)?.text
      return typeof value === 'string' ? value : ''
    })
    .join('\n')
}

function messages(body: JsonRecord): JsonRecord[] {
  if (!Array.isArray(body.messages)) return []
  return body.messages.flatMap(item => {
    const record = asRecord(item)
    return record ? [record] : []
  })
}

function processId(state: FixtureState, kind: ProcKind): string {
  const id = state.procIds[kind]
  assert(id, `fixture did not capture ${kind} process id`)
  return id
}

function lastUserText(body: JsonRecord): string {
  const user = [...messages(body)].reverse().find(message => message.role === 'user')
  return messageText(user)
}

function parseToolResult(message: JsonRecord): JsonRecord | undefined {
  const raw = messageText(message)
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function updateProcessIds(body: JsonRecord, state: FixtureState): void {
  const byCall: Record<string, ProcKind> = {
    call_cancel: 'cancel',
    call_large: 'large',
    call_nonzero: 'nonzero',
    call_success: 'success'
  }
  for (const message of messages(body)) {
    const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
    const kind = byCall[callId]
    const result = parseToolResult(message)
    const sessionId = result?.session_id
    if (kind && typeof sessionId === 'string') state.procIds[kind] = sessionId
  }
}

function chunk(delta: JsonRecord, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1,
    id: 'chatcmpl-hermes-notification-fixture',
    model: 'fixture-model',
    object: 'chat.completion.chunk'
  })}\n\n`
}

function beginSse(response: ServerResponse): void {
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream'
  })
}

function finishSse(response: ServerResponse): void {
  response.write(chunk({}, 'stop'))
  response.end('data: [DONE]\n\n')
}

function sendText(response: ServerResponse, text: string, stream = true): void {
  if (!stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', index: 0, message: { content: text, role: 'assistant' } }],
        created: 1,
        id: 'chatcmpl-hermes-notification-fixture',
        model: 'fixture-model',
        object: 'chat.completion',
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 }
      })
    )
    return
  }
  beginSse(response)
  response.write(chunk({ content: text, role: 'assistant' }))
  finishSse(response)
}

function sendToolCalls(
  response: ServerResponse,
  calls: ReadonlyArray<{ readonly args: JsonRecord; readonly id: string; readonly name: string }>
): void {
  beginSse(response)
  response.write(
    chunk({
      role: 'assistant',
      tool_calls: calls.map((call, index) => ({
        function: { arguments: JSON.stringify(call.args), name: call.name },
        id: call.id,
        index,
        type: 'function'
      }))
    })
  )
  response.write(chunk({}, 'tool_calls'))
  response.end('data: [DONE]\n\n')
}

function waitingCommand(paths: { readonly ready: string; readonly release: string }, output: string, exit = 0): string {
  return `: > ${JSON.stringify(paths.ready)}; while [ ! -f ${JSON.stringify(paths.release)} ]; do sleep 0.05; done; printf '%s\\n' ${JSON.stringify(output)}; exit ${String(exit)}`
}

function largeCommand(paths: { readonly ready: string; readonly release: string }): string {
  return `: > ${JSON.stringify(paths.ready)}; while [ ! -f ${JSON.stringify(paths.release)} ]; do sleep 0.05; done; printf '%s' ${JSON.stringify(LARGE_HEAD)}; i=0; while [ "$i" -lt 700 ]; do printf 'LARGE_BLOCK_'; i=$((i+1)); done; printf '%s\\n' ${JSON.stringify(LARGE_TAIL)}`
}

function cancelCommand(paths: { readonly ready: string; readonly release: string }): string {
  return `printf '%s\\n' ${JSON.stringify(CANCEL_DETAIL)}; : > ${JSON.stringify(paths.ready)}; while [ ! -f ${JSON.stringify(paths.release)} ]; do sleep 0.05; done`
}

async function readRequest(request: AsyncIterable<unknown>): Promise<JsonRecord> {
  const chunks: Buffer[] = []
  for await (const value of request) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value)))
  return asRecord(JSON.parse(Buffer.concat(chunks).toString('utf8'))) ?? {}
}

function processFromNotification(text: string, state: FixtureState): ProcKind | undefined {
  return (Object.entries(state.procIds) as Array<[ProcKind, string]>).find(([, id]) => text.includes(id))?.[0]
}

async function startFixture(home: string, paths: Record<ProcKind, { ready: string; release: string }>) {
  const state: FixtureState = {
    holdStarted: deferred(),
    procIds: {},
    releaseHold: deferred(),
    requests: []
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'fixture-model', object: 'model' }], object: 'list' }))
        return
      }
      const body = await readRequest(request)
      state.requests.push(body)
      updateProcessIds(body, state)
      const user = lastUserText(body)
      const hasTools = Array.isArray(body.tools)
      const toolRows = messages(body).filter(message => message.role === 'tool')

      if (hasTools && user.includes(SPAWN_REQUEST)) {
        if (toolRows.some(message => message.tool_call_id === 'call_success')) {
          sendText(response, 'FIXTURE_SPAWNED_ALL', body.stream !== false)
        } else {
          sendToolCalls(response, [
            {
              args: { background: true, command: waitingCommand(paths.success, SUCCESS_DETAIL), notify: true },
              id: 'call_success',
              name: 'terminal'
            },
            {
              args: { background: true, command: waitingCommand(paths.nonzero, NONZERO_DETAIL, 7), notify: true },
              id: 'call_nonzero',
              name: 'terminal'
            },
            {
              args: { background: true, command: largeCommand(paths.large), notify: true },
              id: 'call_large',
              name: 'terminal'
            },
            {
              args: { background: true, command: cancelCommand(paths.cancel), notify: true },
              id: 'call_cancel',
              name: 'terminal'
            }
          ])
        }
        return
      }

      if (hasTools && user.includes(HOLD_REQUEST)) {
        beginSse(response)
        response.write(chunk({ content: HOLD_STARTED, role: 'assistant' }))
        state.holdStarted.resolve()
        await state.releaseHold.promise
        response.write(chunk({ content: '_FINISHED' }))
        finishSse(response)
        return
      }

      if (hasTools && user.includes(QUEUED_INPUT)) {
        sendText(response, QUEUED_RESPONSE, body.stream !== false)
        return
      }

      if (hasTools && user.includes('[IMPORTANT: Background process')) {
        const kind = processFromNotification(user, state)
        assert(kind, `fixture received notification for unknown process: ${user.slice(0, 200)}`)
        if (kind === 'large') {
          const logResult = toolRows.find(message => message.tool_call_id === 'call_large_log')
          if (!logResult) {
            sendToolCalls(response, [
              {
                args: {
                  calls: [
                    {
                      arguments: { action: 'log', limit: 200, offset: 0, session_id: processId(state, 'large') },
                      name: 'process_manage'
                    }
                  ]
                },
                id: 'call_large_log',
                name: 'tool_call'
              }
            ])
          } else {
            state.largeLogResult = messageText(logResult)
            sendText(response, 'FIXTURE_ACK_LARGE', body.stream !== false)
          }
        } else {
          sendText(response, `FIXTURE_ACK_${kind.toUpperCase()}`, body.stream !== false)
        }
        return
      }

      // Auxiliary calls (for example title generation) remain deterministic
      // and never masquerade as one of the asserted conversational turns.
      sendText(response, 'FIXTURE_AUXILIARY_RESPONSE', false)
    })().catch(error => {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
    })
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  await writeFile(
    join(home, 'config.yaml'),
    [
      'model:',
      '  default: fixture-model',
      '  provider: notification-fixture',
      '  context_length: 131072',
      'providers:',
      '  notification-fixture:',
      `    base_url: http://127.0.0.1:${String(address.port)}/v1`,
      '    api_key: fixture-key',
      '    transport: chat_completions',
      '    model: fixture-model',
      '    models:',
      '      fixture-model:',
      '        context_length: 131072',
      'display:',
      '  busy_input_mode: queue',
      'approvals:',
      "  mode: 'off'",
      'memory:',
      '  enabled: false',
      ''
    ].join('\n'),
    'utf8'
  )
  return {
    close: () =>
      new Promise<void>((resolveClose, reject) => server.close(error => (error ? reject(error) : resolveClose()))),
    state
  }
}

async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = READY_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
}

function eventHas(event: GatewayEvent, text: string): boolean {
  return JSON.stringify(event).includes(text)
}

function processEvents(events: readonly GatewayEvent[], type: GatewayEvent['type']): GatewayEvent[] {
  return events.filter(event => event.type === type && eventHas(event, 'proc_'))
}

async function submit(
  runtime: ManagedRuntime.ManagedRuntime<GatewayService, never>,
  gateway: GatewayTransport,
  store: SessionStore,
  sessionId: string,
  text: string,
  queued = false
): Promise<JsonRecord> {
  store.pushUser(text)
  const response = await runtime.runPromise(
    gateway.request<unknown>('prompt.submit', { queued, session_id: sessionId, text })
  )
  return asRecord(response) ?? {}
}

type DetailsSlashContext = Pick<
  SlashContext,
  'detailSections' | 'details' | 'pushSystem' | 'request' | 'sessionId' | 'setDetails' | 'setDetailSection'
>

async function proveNativeDisclosure(
  store: SessionStore,
  successId: string,
  evidenceDir?: string,
  privateHome?: string
): Promise<void> {
  store.setDetails('collapsed')
  const detailsContext: DetailsSlashContext = {
    detailSections: () => store.state.detailsSections,
    details: () => store.state.details,
    pushSystem: text => store.pushSystem(text),
    request: () => Promise.resolve({}),
    sessionId: () => store.state.sessionId,
    setDetails: (mode, override) => store.setDetails(mode, override),
    setDetailSection: (section, mode) => store.setDetailSection(section, mode)
  }
  const slashContext = detailsContext as SlashContext
  let slashDone: Promise<void> | undefined
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App
          store={store}
          onSubmit={text => {
            slashDone = dispatchSlash(text, slashContext)
            return true
          }}
        />
      </ThemeProvider>
    ),
    { height: 90, kittyKeyboard: true, width: 140 }
  )
  try {
    // Markdown initialization uses a worker; render-pass counts are not a
    // wall-clock readiness boundary for the asynchronously painted text.
    let collapsed = ''
    await waitUntil('settled native assistant chronology', async () => {
      await probe.settle()
      collapsed = probe.frame()
      return collapsed.includes(successId) && collapsed.includes(QUEUED_RESPONSE) && collapsed.includes('· ready')
    })
    assert(collapsed.indexOf(QUEUED_INPUT) < collapsed.indexOf(QUEUED_RESPONSE), 'visible queued exchange is reversed')
    assert(collapsed.indexOf(QUEUED_RESPONSE) < collapsed.indexOf('◆'), 'visible completion overtook queued response')
    assert(!collapsed.includes(SUCCESS_DETAIL), 'completion detail flooded the default native frame')
    if (evidenceDir) {
      await writeFile(
        join(evidenceDir, 'followup-live-notification-collapsed.txt'),
        privateHome ? collapsed.replaceAll(privateHome, '$HOME') : collapsed
      )
    }

    await probe.keys.typeText('/details activity expanded')
    probe.keys.pressEnter()
    await waitUntil('keyboard /details dispatch', () => slashDone !== undefined)
    await Promise.resolve(slashDone)
    await probe.settle()
    const keyboardExpanded = await probe.waitForFrame(frame => frame.includes(SUCCESS_DETAIL))
    assert(keyboardExpanded.includes('▼'), 'keyboard-expanded card did not render an open disclosure marker')
    if (evidenceDir) {
      await writeFile(
        join(evidenceDir, 'followup-live-notification-keyboard-expanded.txt'),
        privateHome ? keyboardExpanded.replaceAll(privateHome, '$HOME') : keyboardExpanded
      )
    }

    slashDone = undefined
    await probe.keys.typeText('/details activity collapsed')
    probe.keys.pressEnter()
    await waitUntil('keyboard /details collapse dispatch', () => slashDone !== undefined)
    await Promise.resolve(slashDone)
    await probe.settle()
    const recollapsed = await probe.waitForFrame(frame => frame.includes(successId) && !frame.includes(SUCCESS_DETAIL))
    const rows = recollapsed.split('\n')
    const y = rows.findIndex(row => row.includes(successId))
    assert(y >= 0, 'could not locate completion header for native mouse input')
    await probe.click(Math.max(1, (rows[y]?.indexOf('◆') ?? 0) + 2), y)
    const mouseExpanded = await probe.waitForFrame(frame => frame.includes(SUCCESS_DETAIL))
    assert(mouseExpanded.includes('▼'), 'mouse-expanded card did not render an open disclosure marker')
    if (evidenceDir) {
      await writeFile(
        join(evidenceDir, 'followup-live-notification-mouse-expanded.txt'),
        privateHome ? mouseExpanded.replaceAll(privateHome, '$HOME') : mouseExpanded
      )
    }
  } finally {
    probe.destroy()
  }
}

async function main(): Promise<void> {
  console.log(FIXTURE_LABEL)
  // Arbitrary-entry bundles land in <repo>/ui-opentui/<outdir>; walk back to
  // the candidate checkout, not the run directory that contains the worktree.
  const root = resolve(import.meta.dirname, '../..')
  const home = await mkdtemp(join(tmpdir(), 'hermes-live-notification-'))
  const privateHome = process.env.HOME
  const control = join(home, 'control')
  await mkdir(control)
  const paths = Object.fromEntries(
    (['success', 'nonzero', 'large', 'cancel'] as const).map(kind => [
      kind,
      { ready: join(control, `${kind}.ready`), release: join(control, `${kind}.release`) }
    ])
  ) as Record<ProcKind, { ready: string; release: string }>
  const fixture = await startFixture(home, paths)
  const python = process.env.HERMES_NOTIFICATION_PYTHON?.trim() || resolve(root, '.venv/bin/python')
  process.env.HOME = home
  process.env.HERMES_HOME = home
  process.env.HERMES_PYTHON = python
  process.env.HERMES_PYTHON_SRC_ROOT = root
  process.env.HERMES_IGNORE_RULES = '1'
  process.env.TERMINAL_ENV = 'local'
  const evidenceDir = process.env.HERMES_NOTIFICATION_EVIDENCE_DIR?.trim()
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true })

  const runtime = ManagedRuntime.make(liveGatewayLayer)
  const events: GatewayEvent[] = []
  const liveStore = createSessionStore()
  let activeStore = liveStore
  let gateway: GatewayTransport | undefined
  let liveSessionId: string | undefined
  try {
    gateway = await runtime.runPromise(GatewayService)
    await runtime.runPromise(
      gateway.subscribe(event => {
        events.push(event)
        activeStore.apply(event)
      })
    )
    await waitUntil('gateway.ready', () => events.some(event => event.type === 'gateway.ready'), READY_TIMEOUT_MS)

    const created = await runtime.runPromise(createSession(gateway, { cols: 140, cwd: root }))
    liveSessionId = created.sessionId
    liveStore.adoptFreshSession(created.sessionId, created.info, created.resumeId, created.todoState)

    const spawn = await submit(runtime, gateway, liveStore, liveSessionId, SPAWN_REQUEST)
    assert.equal(spawn.status, 'streaming')
    try {
      await waitUntil('all four terminal tool results', () => Object.keys(fixture.state.procIds).length === 4)
    } catch (error) {
      console.error(
        'spawn diagnostics:',
        JSON.stringify(
          {
            events: events.slice(-20),
            procIds: fixture.state.procIds,
            requests: fixture.state.requests.map(body => ({
              lastUser: lastUserText(body).slice(-200),
              toolRows: messages(body)
                .filter(message => message.role === 'tool')
                .map(message => ({ call: message.tool_call_id, content: messageText(message).slice(0, 300) })),
              tools: Array.isArray(body.tools) ? body.tools.length : 0
            }))
          },
          null,
          2
        )
      )
      throw error
    }
    await waitUntil('spawn turn completion', () =>
      events.some(event => event.type === 'message.complete' && eventHas(event, 'FIXTURE_SPAWNED_ALL'))
    )
    await Promise.all(
      Object.values(paths).map(path => waitUntil(`${path.ready} readiness marker`, () => existsSync(path.ready)))
    )
    const successId = processId(fixture.state, 'success')
    const nonzeroId = processId(fixture.state, 'nonzero')
    const largeId = processId(fixture.state, 'large')
    const cancelId = processId(fixture.state, 'cancel')

    // message.complete seals the response before the turn's finally releases admission.
    // Wait for the subsequent authoritative idle event, not an optimistic client phase.
    const spawnCompleteIndex = events.findIndex(
      event => event.type === 'message.complete' && eventHas(event, 'FIXTURE_SPAWNED_ALL')
    )
    await waitUntil('spawn admission released', () =>
      events
        .slice(spawnCompleteIndex + 1)
        .some(event => event.type === 'session.info' && event.payload.running === false)
    )
    const hold = await submit(runtime, gateway, liveStore, liveSessionId, HOLD_REQUEST)
    assert.equal(hold.status, 'streaming')
    await fixture.state.holdStarted.promise
    await waitUntil('held streaming delta', () =>
      events.some(event => event.type === 'message.delta' && eventHas(event, HOLD_STARTED))
    )

    const queued = await submit(runtime, gateway, liveStore, liveSessionId, QUEUED_INPUT, true)
    assert.equal(queued.status, 'queued')
    const killed = asRecord(
      await runtime.runPromise(
        gateway.request<unknown>('process.kill', { process_id: cancelId, session_id: liveSessionId })
      )
    )
    assert(killed && (killed.status === 'killed' || killed.status === 'already_exited'))
    assert.equal(killed.completion_reason, 'killed')
    assert(
      typeof killed.output === 'string' && killed.output.includes(CANCEL_DETAIL),
      'process.kill did not return the cancelled process output it consumed'
    )

    await writeFile(paths.success.release, '')
    try {
      await waitUntil('success status while hold streams', () =>
        processEvents(events, 'status.update').some(event => eventHas(event, successId))
      )
    } catch (error) {
      const processList = await runtime
        .runPromise(gateway.request<unknown>('process.list', { session_id: liveSessionId }))
        .catch(listError => ({ listError: String(listError) }))
      console.error(
        'completion diagnostics:',
        JSON.stringify({ events: events.slice(-30), processList, procIds: fixture.state.procIds }, null, 2)
      )
      throw error
    }
    await writeFile(paths.nonzero.release, '')
    await waitUntil('nonzero status while hold streams', () =>
      processEvents(events, 'status.update').some(event => eventHas(event, nonzeroId))
    )
    await writeFile(paths.large.release, '')
    await waitUntil('large-output status while hold streams', () =>
      processEvents(events, 'status.update').some(event => eventHas(event, largeId))
    )
    assert(
      !events.some(event => event.type === 'message.complete' && eventHas(event, `${HOLD_STARTED}_FINISHED`)),
      'controlled hold completed before all autonomous background statuses arrived'
    )

    fixture.state.releaseHold.resolve()
    await waitUntil(
      'queued response before notification turns',
      () => events.some(event => event.type === 'message.complete' && eventHas(event, QUEUED_RESPONSE)),
      FLOW_TIMEOUT_MS
    )
    await waitUntil(
      'all notification acknowledgements',
      () => {
        const completions = events.filter(event => event.type === 'message.complete')
        return ['SUCCESS', 'NONZERO', 'LARGE'].every(kind =>
          completions.some(event => eventHas(event, `FIXTURE_ACK_${kind}`))
        )
      },
      FLOW_TIMEOUT_MS
    )
    await waitUntil('full large process log retrieval', () => fixture.state.largeLogResult !== undefined)

    const cards = processEvents(events, 'notification.show')
    assert.equal(cards.length, 3, 'expected exactly one admitted card per autonomous process completion')
    assert(
      cards.every(card => !eventHas(card, cancelId)),
      'explicit process.kill output was duplicated as an autonomous completion card'
    )
    const cardKeys = cards.map(card => asRecord(card.payload)?.key)
    assert.equal(new Set(cardKeys).size, 3, 'completion cards did not have unique process keys')
    const queuedCompleteIndex = events.findIndex(
      event => event.type === 'message.complete' && eventHas(event, QUEUED_RESPONSE)
    )
    assert(queuedCompleteIndex >= 0)
    for (const card of cards) {
      const index = events.indexOf(card)
      assert(index > queuedCompleteIndex, 'a completion card overtook the queued user response')
      assert.equal(events[index + 1]?.type, 'message.start', 'card was not published at its admitted turn boundary')
    }
    if (!fixture.state.largeLogResult?.includes(LARGE_HEAD)) {
      console.error(
        'large log diagnostics:',
        JSON.stringify({
          length: fixture.state.largeLogResult?.length,
          prefix: fixture.state.largeLogResult?.slice(0, 500),
          suffix: fixture.state.largeLogResult?.slice(-500)
        })
      )
    }
    assert(fixture.state.largeLogResult?.includes(LARGE_HEAD), 'process_manage log lost the retained output head')
    assert(fixture.state.largeLogResult?.includes(LARGE_TAIL), 'process_manage log lost the retained output tail')
    assert(
      (fixture.state.largeLogResult?.length ?? 0) > 7_000,
      'process_manage log did not return the full retained output'
    )

    // Closing removes the registered live session: resume must load SessionDB,
    // rather than reattaching to the same in-memory conversation.
    await runtime.runPromise(gateway.request('session.close', { session_id: liveSessionId }))
    const freshStore = createSessionStore()
    const readyEvent = events.find(event => event.type === 'gateway.ready')
    assert(readyEvent, 'transport readiness was not observed')
    freshStore.apply(readyEvent)
    activeStore = freshStore
    const resumed = await runtime.runPromise(
      resumeSession(gateway, freshStore, { cols: 140, targetSessionId: created.resumeId })
    )
    assert.notEqual(resumed.sessionId, created.sessionId, 'resume reused the closed live session')
    liveSessionId = resumed.sessionId
    const rows = freshStore.state.messages
    const queuedUserIndex = rows.findIndex(row => row.role === 'user' && row.text === QUEUED_INPUT)
    const queuedAssistantIndex = rows.findIndex(row => row.role === 'assistant' && row.text.includes(QUEUED_RESPONSE))
    const notificationRows = rows.filter(row => row.role === 'notification')
    assert(queuedUserIndex >= 0 && queuedAssistantIndex > queuedUserIndex, 'fresh resume lost the queued exchange')
    assert.equal(notificationRows.length, 3, 'fresh resume did not hydrate exactly three completion cards')
    assert(
      notificationRows.every(row => rows.indexOf(row) > queuedAssistantIndex),
      'fresh resume placed a completion before the queued exchange'
    )
    assert(
      !rows.some(row => row.role === 'user' && row.text.startsWith('[IMPORTANT:')),
      'fresh resume exposed a synthetic completion as apparent user input'
    )
    const largeCard = notificationRows.find(row => row.notification?.key === `proc:${largeId}`)
    assert(largeCard?.notification?.detail?.includes(LARGE_TAIL), 'resumed large-output card lost its retained tail')
    assert(
      largeCard?.notification?.detail?.includes("process(action='log'"),
      'resumed truncated card did not disclose the honest full-output retrieval path'
    )
    const successCard = notificationRows.find(row => row.notification?.key === `proc:${successId}`)
    assert(successCard?.notification?.detail?.includes(SUCCESS_DETAIL), 'resumed success card lost its detail')

    await proveNativeDisclosure(freshStore, successId, evidenceDir, privateHome)

    const summary = {
      fixture: FIXTURE_LABEL,
      gatewayEvents: events.length,
      modelRequests: fixture.state.requests.length,
      notificationCards: cards.length,
      processIds: fixture.state.procIds,
      resumedMessages: rows.length,
      retainedLargeLogChars: fixture.state.largeLogResult?.length ?? 0
    }
    if (evidenceDir) {
      await writeFile(
        join(evidenceDir, 'followup-live-notification-summary.json'),
        `${JSON.stringify(summary, null, 2)}\n`
      )
    }
    console.log(JSON.stringify(summary, null, 2))
    console.log('PASS — real gateway/process/persistence/native-renderer notification flow')
  } finally {
    if (gateway && liveSessionId) {
      await runtime.runPromise(gateway.request('session.close', { session_id: liveSessionId })).catch(() => {})
    }
    await runtime.dispose()
    await fixture.close()
    await rm(home, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }).catch(error => {
      console.error(`temporary fixture cleanup warning: ${String(error)}`)
    })
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
