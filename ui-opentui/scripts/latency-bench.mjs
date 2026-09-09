#!/usr/bin/env node
/**
 * Repeated same-source Ink/OpenTUI startup and idle-shutdown measurement.
 *
 * The benchmark drives real renderer bundles and the real Python gateway in
 * termctrl PTYs. Every sample gets a new credential-free HOME/HERMES_HOME, a
 * closed-loopback custom provider, no personal MCP servers, disabled skills,
 * and the Hermes CLI toolset disabled. It never submits a model prompt unless
 * `--case dispatch` is selected; that case uses only the isolated fixture.
 *
 * Milestone timestamps come from termctrl's recording clock. Controller-side
 * wait/status duration and polling counts are retained separately so they are
 * not mistaken for renderer timestamps.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultRoot = resolve(scriptDir, '../..')
const originalHome = process.env.HOME || '/tmp'

function parseArgs(argv) {
  const options = {
    case: 'idle',
    cols: 120,
    engines: ['ink', 'opentui'],
    label: 'run',
    modes: ['direct'],
    outDir: resolve(process.cwd(), 'latency-artifacts'),
    pollMs: 5,
    prefix: 'latency-b0f8',
    python: '',
    quit: 'action-d',
    root: defaultRoot,
    rows: 35,
    termctrl: process.env.TERMCTRL || 'termctrl',
    trials: 5
  }
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`)
    const name = key.slice(2)
    if (name === 'case') options.case = value
    else if (name === 'cols') options.cols = Number(value)
    else if (name === 'engines') options.engines = value.split(',')
    else if (name === 'label') options.label = value
    else if (name === 'modes') options.modes = value.split(',')
    else if (name === 'out-dir') options.outDir = resolve(value)
    else if (name === 'poll-ms') options.pollMs = Number(value)
    else if (name === 'prefix') options.prefix = value
    else if (name === 'python') options.python = resolve(value)
    else if (name === 'quit') options.quit = value
    else if (name === 'root') options.root = resolve(value)
    else if (name === 'rows') options.rows = Number(value)
    else if (name === 'termctrl') options.termctrl = resolve(value)
    else if (name === 'trials') options.trials = Number(value)
    else throw new Error(`unknown argument: ${key}`)
  }
  if (!['idle', 'dispatch'].includes(options.case)) throw new Error('--case must be idle or dispatch')
  if (!options.engines.every(value => ['ink', 'opentui'].includes(value))) {
    throw new Error('--engines must contain only ink,opentui')
  }
  if (!options.modes.every(value => ['direct', 'cli'].includes(value))) {
    throw new Error('--modes must contain only direct,cli')
  }
  if (!Number.isInteger(options.trials) || options.trials < 1) throw new Error('--trials must be a positive integer')
  if (!['action-d', 'arm-action-d'].includes(options.quit)) {
    throw new Error('--quit must be action-d or arm-action-d')
  }
  if (!options.python) throw new Error('--python is required')
  if (!/^[a-z0-9-]+$/.test(options.prefix)) throw new Error('--prefix must use lowercase letters, digits, hyphens')
  return options
}

function command(command, args, options = {}) {
  const started = process.hrtime.bigint()
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024
  })
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6
  return {
    durationMs,
    error: result.error?.message,
    signal: result.signal,
    status: result.status,
    stderr: result.stderr || '',
    stdout: result.stdout || ''
  }
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function collectSkillNames(root) {
  const names = new Set()
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name === 'SKILL.md') {
        const match = readFileSync(path, 'utf8').match(/^name:\s*([^#\n]+)/m)
        if (match?.[1]?.trim()) names.add(match[1].trim())
      }
    }
  }
  visit(join(root, 'skills'))
  return [...names].sort()
}

function yamlConfig(skillNames) {
  const disabled = skillNames.map(name => `    - ${JSON.stringify(name)}`).join('\n')
  return `model:
  default: latency-fixture
  provider: latency-fixture
  context_length: 131072
providers:
  latency-fixture:
    base_url: http://127.0.0.1:9/v1
    api_key: fixture-only
    transport: chat_completions
    model: latency-fixture
    models:
      latency-fixture:
        context_length: 131072
memory:
  enabled: false
  memory_enabled: false
  user_profile_enabled: false
skills:
  disabled:
${disabled}
mcp_servers: {}
agent:
  disabled_toolsets:
    - hermes-cli
approvals:
  mode: "off"
models_dev:
  url: http://127.0.0.1:9/models.json
`
}

function makeWrapper(outDir) {
  const path = join(outDir, 'child-wrapper.sh')
  writeFileSync(
    path,
    `#!/bin/sh
"$@"
child_rc=$?
printf '\n__HERMES_LATENCY_CHILD_RETURN__ rc=%s\n' "$child_rc"
stty -a 2>&1
printf '__HERMES_LATENCY_STTY_DONE__\n'
exit "$child_rc"
`,
    'utf8'
  )
  chmodSync(path, 0o700)
  return path
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function recordingEvents(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function decodedRecordingOutput(events) {
  const chunks = events.filter(event => event.type === 'output').map(event => Buffer.from(event.bytes))
  return Buffer.concat(chunks).toString('utf8')
}

function lastInputAt(events, text) {
  let found
  for (const event of events) {
    if (event.type !== 'input') continue
    if (Buffer.from(event.bytes).toString('utf8').includes(text)) found = event.at_ms
  }
  return found
}

function firstOutputAt(events, text) {
  let retained = ''
  for (const event of events) {
    if (event.type !== 'output') continue
    retained = (retained + Buffer.from(event.bytes).toString('utf8')).slice(-Math.max(16_384, text.length * 4))
    if (retained.includes(text)) return event.at_ms
  }
  return undefined
}

function statusState(stdout) {
  try {
    return JSON.parse(stdout).state
  } catch {
    return undefined
  }
}

function processesWithHome(home) {
  if (process.platform !== 'linux') return undefined
  const matches = []
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    try {
      const environ = readFileSync(`/proc/${entry.name}/environ`, 'utf8')
      if (!environ.split('\0').includes(`HERMES_HOME=${home}`)) continue
      const commandLine = readFileSync(`/proc/${entry.name}/cmdline`, 'utf8').split('\0').filter(Boolean)
      matches.push({ commandLine, pid: Number(entry.name) })
    } catch {
      // A process can exit between /proc enumeration and reads.
    }
  }
  return matches
}

function childArgv(options, engine) {
  if (options.mode === 'cli') {
    return [options.python, '-m', 'hermes_cli.main', '--tui']
  }
  if (engine === 'ink') return [process.execPath, '--expose-gc', join(options.root, 'ui-tui/dist/entry.js')]
  return [
    process.execPath,
    '--experimental-ffi',
    '--no-warnings',
    '--expose-gc',
    join(options.root, 'ui-opentui/dist/main.js')
  ]
}

function runTrial(options, wrapper, config, engine, mode, trial) {
  const trialName = `${options.prefix}-${options.label}-${mode}-${engine}-${String(trial)}`
  const home = mkdtempSync(join(tmpdir(), `${trialName}.`))
  const hermesHome = join(home, '.hermes')
  const work = join(home, 'work')
  for (const path of [hermesHome, work, join(home, 'cache'), join(home, 'config'), join(home, 'data')]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(hermesHome, 'config.yaml'), config, 'utf8')
  const recording = join(options.outDir, `${trialName}.termctrl`)
  const logFile = join(options.outDir, `${trialName}.tui.log`)
  const dispatchText = `latency-dispatch-${engine}-${mode}-${String(trial)}`
  const cleanPath = `${dirname(process.execPath)}:/usr/bin:/bin:${join(originalHome, '.local/bin')}`
  const environment = [
    `HOME=${home}`,
    `HERMES_HOME=${hermesHome}`,
    `XDG_CACHE_HOME=${join(home, 'cache')}`,
    `XDG_CONFIG_HOME=${join(home, 'config')}`,
    `XDG_DATA_HOME=${join(home, 'data')}`,
    'LANG=C.UTF-8',
    'LC_ALL=C.UTF-8',
    'TERM=xterm-256color',
    'COLORTERM=truecolor',
    `PATH=${cleanPath}`,
    `HERMES_NODE=${process.execPath}`,
    `HERMES_PYTHON=${options.python}`,
    `HERMES_PYTHON_SRC_ROOT=${options.root}`,
    `PYTHONPATH=${options.root}`,
    `HERMES_CWD=${work}`,
    `TERMINAL_CWD=${work}`,
    `HERMES_TUI_ENGINE=${engine}`,
    'HERMES_TUI_DISABLE_MOUSE=1',
    'HERMES_TUI_LOG_LEVEL=debug',
    `HERMES_TUI_LOG_FILE=${logFile}`,
    ...(options.case === 'dispatch' ? [`HERMES_TUI_QUERY=${dispatchText}`] : [])
  ]
  const argv = childArgv({ ...options, mode }, engine)
  const started = process.hrtime.bigint()
  const start = command(options.termctrl, [
    'start',
    trialName,
    '--host',
    'opentui',
    '--cols',
    String(options.cols),
    '--rows',
    String(options.rows),
    '--cwd',
    work,
    '--record',
    recording,
    '--',
    '/usr/bin/env',
    '-i',
    ...environment,
    wrapper,
    ...argv
  ])
  if (start.status !== 0 || !existsSync(recording)) {
    return {
      case: options.case,
      engine,
      failure: 'termctrl start failed before a recording was created',
      home,
      label: options.label,
      mode,
      recording,
      start,
      trial
    }
  }
  const controllerMs = () => Number(process.hrtime.bigint() - started) / 1e6
  // The configured model first becomes visible after session.create has been
  // adopted. Unlike the empty-composer placeholder, it remains visible when
  // the early-draft probe succeeds.
  const hydratedText = 'latency-fixture'
  const composerWait = command(options.termctrl, ['wait', trialName, '❯', '--timeout', '20000'])
  let draft
  let draftWait
  let clearVerified
  if (options.case === 'idle' && composerWait.status === 0) {
    draft = `latency-draft-${engine}-${mode}-${String(trial)}`
    command(options.termctrl, ['send', trialName, `text:${draft}`])
    draftWait = command(options.termctrl, ['wait', trialName, draft, '--timeout', '3000'])
  }
  const hydratedWait = command(options.termctrl, ['wait', trialName, hydratedText, '--timeout', '20000'])
  let dispatchWait
  let dispatchErrorWait
  if (options.case === 'dispatch') {
    dispatchWait = command(options.termctrl, ['wait', trialName, dispatchText, '--timeout', '20000'])
    dispatchErrorWait = command(options.termctrl, ['wait', trialName, 'error:', '--timeout', '20000'])
  }
  const liveScreen = command(options.termctrl, ['show', trialName])
  writeFileSync(join(options.outDir, `${trialName}.hydrated.txt`), liveScreen.stdout, 'utf8')

  const draftPreserved = draft ? liveScreen.stdout.includes(draft) : undefined
  if (draft && draftPreserved) {
    command(options.termctrl, ['send', trialName, 'ctrl-c'])
    const clearDeadline = controllerMs() + 3_000
    do {
      const screen = command(options.termctrl, ['show', trialName])
      clearVerified = !screen.stdout.includes(draft)
      if (!clearVerified) sleepMs(options.pollMs)
    } while (!clearVerified && controllerMs() < clearDeadline)
  }

  let armWait
  if (options.quit === 'arm-action-d' && clearVerified !== false) {
    command(options.termctrl, ['send', trialName, 'ctrl-c'])
    armWait = command(options.termctrl, ['wait', trialName, 'Ctrl+C again to quit', '--timeout', '3000'])
  }
  const quitCommandStartMs = controllerMs()
  // Action+D is the shared direct idle-exit gesture. `/quit` is not a stable
  // benchmark input: Ink first opens slash completion while OpenTUI dispatches
  // it, so one identical key sequence measures different user actions.
  const quitSend = clearVerified === false ? undefined : command(options.termctrl, ['send', trialName, 'ctrl-d'])
  const quitSendEndMs = controllerMs()
  const pollDurations = []
  let finalStatus
  let exitObservedMs
  const exitDeadline = quitSendEndMs + 10_000
  if (quitSend) {
    do {
      finalStatus = command(options.termctrl, ['status', trialName, '--json'])
      pollDurations.push(finalStatus.durationMs)
      if (finalStatus.status !== 0 || statusState(finalStatus.stdout) !== 'running') {
        exitObservedMs = controllerMs()
        break
      }
      sleepMs(options.pollMs)
    } while (controllerMs() < exitDeadline)
  }
  const ansi = command(options.termctrl, ['logs', trialName, '--ansi'])
  const readable = command(options.termctrl, ['logs', trialName])
  writeFileSync(join(options.outDir, `${trialName}.ansi`), ansi.stdout, 'utf8')
  writeFileSync(join(options.outDir, `${trialName}.log.txt`), readable.stdout + readable.stderr, 'utf8')
  const stillRunning = finalStatus?.status === 0 && statusState(finalStatus.stdout) === 'running'

  const events = recordingEvents(recording)
  const rawOutput = decodedRecordingOutput(events)
  const sttyStart = rawOutput.lastIndexOf('__HERMES_LATENCY_CHILD_RETURN__')
  const sttyEnd = rawOutput.lastIndexOf('__HERMES_LATENCY_STTY_DONE__')
  const sttyOutput = sttyStart >= 0 && sttyEnd > sttyStart ? rawOutput.slice(sttyStart, sttyEnd) : ''
  const terminalRestored = sttyOutput
    ? !/(^|[ ;])-icanon([ ;]|$)/m.test(sttyOutput) && !/(^|[ ;])-echo([ ;]|$)/m.test(sttyOutput)
    : undefined
  const ownedProcessesAtExit = processesWithHome(hermesHome)
  let ownedProcessesAfterExit = ownedProcessesAtExit
  let ownedProcessSettleMs = 0
  if (ownedProcessesAfterExit?.length) {
    const settleStarted = process.hrtime.bigint()
    const settleDeadline = controllerMs() + 1_000
    do {
      sleepMs(options.pollMs)
      ownedProcessesAfterExit = processesWithHome(hermesHome)
    } while (ownedProcessesAfterExit?.length && controllerMs() < settleDeadline)
    ownedProcessSettleMs = Number(process.hrtime.bigint() - settleStarted) / 1e6
  }
  // `termctrl` retains its controller after a child exits. Capture the
  // recording, logs, terminal state, and exact-profile process evidence first,
  // then stop this trial's named controller on both success and failure.
  const controllerStop = command(options.termctrl, ['stop', trialName])
  const result = {
    case: options.case,
    controller: {
      composerWaitMs: composerWait.durationMs,
      armWaitMs: armWait?.durationMs,
      dispatchErrorWaitMs: dispatchErrorWait?.durationMs,
      dispatchWaitMs: dispatchWait?.durationMs,
      draftWaitMs: draftWait?.durationMs,
      exitObservedMs,
      hydratedWaitMs: hydratedWait.durationMs,
      pollCount: pollDurations.length,
      pollMaxMs: pollDurations.length ? Math.max(...pollDurations) : undefined,
      pollMeanMs: pollDurations.length
        ? pollDurations.reduce((sum, value) => sum + value, 0) / pollDurations.length
        : undefined,
      quitCommandStartMs,
      quitSendCallMs: quitSend?.durationMs,
      quitSendEndMs,
      startCallMs: start.durationMs
    },
    draftPreserved,
    engine,
    exit: {
      childReturnAtMs: firstOutputAt(events, '__HERMES_LATENCY_CHILD_RETURN__'),
      finalState: finalStatus ? statusState(finalStatus.stdout) : undefined,
      ownedProcessesAfterExit,
      ownedProcessesAtExit,
      ownedProcessSettleMs,
      stopWasRequired: stillRunning,
      terminalRestored
    },
    home,
    label: options.label,
    milestones: {
      composerAtMs: firstOutputAt(events, '❯'),
      dispatchAtMs: options.case === 'dispatch' ? firstOutputAt(events, dispatchText) : undefined,
      firstChromeAtMs: firstOutputAt(events, 'Nous Research'),
      hydratedAtMs: firstOutputAt(events, hydratedText),
      quitInputAtMs: lastInputAt(events, '\u0004')
    },
    mode,
    recording,
    termctrl: {
      composerWaitStatus: composerWait.status,
      armWaitStatus: armWait?.status,
      dispatchErrorWaitStatus: dispatchErrorWait?.status,
      dispatchWaitStatus: dispatchWait?.status,
      draftWaitStatus: draftWait?.status,
      finalStatus: finalStatus?.stdout.trim(),
      hydratedWaitStatus: hydratedWait.status,
      controllerStopStatus: controllerStop.status,
      startStatus: start.status,
      stderr: [
        start.stderr,
        composerWait.stderr,
        hydratedWait.stderr,
        quitSend?.stderr,
        finalStatus?.stderr,
        controllerStop.stderr
      ]
        .filter(Boolean)
        .join('\n')
    },
    trial
  }
  return result
}

const options = parseArgs(process.argv.slice(2))
mkdirSync(options.outDir, { recursive: true })
const wrapper = makeWrapper(options.outDir)
const config = yamlConfig(collectSkillNames(options.root))
const resultsPath = join(options.outDir, 'results.ndjson')
const metadata = {
  argv: process.argv,
  bundleSha256: {
    ink: hashFile(join(options.root, 'ui-tui/dist/entry.js')),
    opentui: hashFile(join(options.root, 'ui-opentui/dist/main.js'))
  },
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: options.root, encoding: 'utf8' }).trim(),
  configSha256: createHash('sha256').update(config).digest('hex'),
  node: process.version,
  nodePath: process.execPath,
  options,
  platform: `${process.platform}-${process.arch}`,
  python: options.python,
  termctrl: command(options.termctrl, ['--version']).stdout.trim(),
  type: 'metadata'
}
appendFileSync(resultsPath, `${JSON.stringify(metadata)}\n`, 'utf8')
console.log(JSON.stringify(metadata))

for (const mode of options.modes) {
  for (const engine of options.engines) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      const result = runTrial(options, wrapper, config, engine, mode, trial)
      appendFileSync(resultsPath, `${JSON.stringify(result)}\n`, 'utf8')
      console.log(JSON.stringify(result))
    }
  }
}
