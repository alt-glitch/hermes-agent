/**
 * Low-level JSON-RPC-over-stdio client for the Python `tui_gateway` (spec v4 §4).
 * Re-authored minimal (NOT the Ink client's 740-LOC attach-mode/buffering) but
 * the WIRE CONTRACT is identical (verified against ui-tui/src/gatewayClient.ts +
 * tui_gateway/server.py + entry.py + transport.py):
 *
 *  - spawn: `python -m tui_gateway.entry`, cwd=srcRoot, env={...process.env,
 *    PYTHONPATH=srcRoot:…, HERMES_PYTHON_SRC_ROOT=srcRoot}, stdio piped.
 *  - framing: newline-delimited compact JSON, BOTH directions, on ONE stdout.
 *  - request:  {id:"r<n>", jsonrpc:"2.0", method, params} + "\n".
 *  - response: {jsonrpc, id, result} | {jsonrpc, id, error:{code,message}} — match by id.
 *  - event:    {jsonrpc, method:"event", params:{type, session_id?, payload?}} (NO id).
 *  - handshake: child emits {event, params:{type:"gateway.ready", payload:{skin}}}
 *    UNSOLICITED first; no subscribe RPC. Then client drives session.create /
 *    session.resume / prompt.submit / *.respond.
 *  - GOTCHA: session.resume/prompt.submit/slash.exec are LONG handlers — their
 *    {id,result} arrives async, interleaved with events. Keep the pending map
 *    authoritative; never assume in-order response delivery.
 *
 * Raw events are surfaced as `unknown` (the params object). The liveGateway
 * layer Schema-decodes them once at the boundary (spec v4 §3.3); this client
 * stays decode-agnostic so the transport and the schema evolve independently.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { getHeapStatistics } from 'node:v8'

import type { Log } from '../log.ts'
import { resolvePython, resolveSrcRoot } from './python.ts'

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  method: string
}

interface StartupWatchdog {
  readonly generation: number
  readonly handle: ReturnType<typeof setTimeout>
}

interface CloseWatchdog extends StartupWatchdog {
  readonly reason: string
}

const WS_CONNECTING = 0
const WS_OPEN = 1

export function resolveGatewayAttachUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HERMES_TUI_GATEWAY_URL?.trim() || undefined
}

const USERINFO_FALLBACK_RE = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i

/** Dashboard attachment URLs carry credentials in user-info and/or the query.
 * Never expose either through the diagnostics ring or structured logger. */
export function redactGatewayUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const userInfo = url.username || url.password ? '***@' : ''
    return `${url.protocol}//${userInfo}${url.host}${url.pathname}${url.search ? '?***' : ''}`
  } catch {
    const withoutUserInfo = raw.replace(USERINFO_FALLBACK_RE, '$1***@')
    const query = withoutUserInfo.indexOf('?')
    return query < 0 ? withoutUserInfo : `${withoutUserInfo.slice(0, query)}?***`
  }
}

const wireDecoder = new TextDecoder()

function websocketFrameText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  if (raw instanceof ArrayBuffer) return wireDecoder.decode(raw)
  if (ArrayBuffer.isView(raw)) return wireDecoder.decode(raw)
  return undefined
}

export interface RawClientOptions {
  readonly log: Log
  /** Called with each server-pushed event's `params` object (still unknown — decoded upstream). */
  readonly onEvent: (params: unknown) => void
  /** Called when the child exits / errors (so the layer can reject pending + reconnect). */
  readonly onExit?: (reason: string) => void
}

/** Machine-readable request failure provenance. Delivery-sensitive callers
 * must never infer transport admission from human-readable error copy. */
export type RawGatewayFailureReason = 'rpc-error' | 'timeout' | 'transport-down'

export class RawGatewayRequestError extends Error {
  readonly code: number | undefined
  readonly data: unknown
  readonly reason: RawGatewayFailureReason

  constructor(reason: RawGatewayFailureReason, message: string, code?: number, data?: unknown) {
    super(message)
    this.name = 'RawGatewayRequestError'
    this.reason = reason
    this.code = code
    this.data = data
  }
}

const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.HERMES_TUI_RPC_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? Math.max(5000, raw) : 120_000
})()

export const STARTUP_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.HERMES_TUI_STARTUP_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? Math.max(2000, raw) : 20_000
})()

/** `exit` can precede the final buffered stdout `data`/stdio `close` events.
 * Give that pipe a short bounded drain window before forcing recovery. */
export const CHILD_CLOSE_GRACE_MS = 250
/** Escalate a captured child that ignored SIGTERM, then detach its stdio so a
 * wedged process can never keep renderer teardown alive indefinitely. */
export const CHILD_FORCE_KILL_GRACE_MS = 750

export const TRANSPORT_LOG_RING_LIMIT = 200
export const TRANSPORT_LOG_LINE_LIMIT = 4096
/** Ordinary UTF-8 byte ceiling for one newline-delimited stdout JSON-RPC frame.
 * Events and normal RPC responses stay under this budget. Only a canonical
 * response for a pending history-bearing RPC can opt into the larger bounded
 * budget below; a missing newline or unrelated/forged frame remains capped at
 * 32 MiB and recycles the child generation. */
export const STDOUT_FRAME_MAX_BYTES = 32 * 1024 * 1024
/** Absolute ceiling for a legitimate session snapshot/history response. The
 * complete JSON string and its parsed object graph coexist briefly, so any
 * allowance above the ordinary 32 MiB floor is limited to one eighth of V8's
 * effective heap. The launcher already derives that heap from the
 * cgroup/device memory limit. */
export const SESSION_RESPONSE_FRAME_ABSOLUTE_MAX_BYTES = 256 * 1024 * 1024
const SESSION_RESPONSE_HEAP_HEADROOM_FACTOR = 8

export function sessionResponseFrameLimitForHeap(heapLimitBytes: number): number {
  if (!Number.isFinite(heapLimitBytes) || heapLimitBytes <= 0) return STDOUT_FRAME_MAX_BYTES
  const heapBudget = Math.floor(heapLimitBytes / SESSION_RESPONSE_HEAP_HEADROOM_FACTOR)
  return Math.max(STDOUT_FRAME_MAX_BYTES, Math.min(SESSION_RESPONSE_FRAME_ABSOLUTE_MAX_BYTES, heapBudget))
}

/** Runtime ceiling for large history-bearing responses. This is an internal
 * safety invariant, not a user-facing configuration knob. */
export const SESSION_RESPONSE_FRAME_MAX_BYTES = sessionResponseFrameLimitForHeap(getHeapStatistics().heap_size_limit)

const RESPONSE_HEADER_PREFIX_MAX_CHARS = 512
const LARGE_SESSION_RESPONSE_METHODS = new Set(['session.resume', 'session.history'])
/** `_ok`/`_err` in tui_gateway/server.py deliberately serialize this canonical
 * key order. Requiring that prefix plus a currently pending request id prevents
 * an arbitrary event/corrupt line from borrowing the larger frame budget. */
const CANONICAL_RESPONSE_HEADER =
  /^\s*\{\s*"jsonrpc"\s*:\s*"2\.0"\s*,\s*"id"\s*:\s*"(r[1-9]\d*)"\s*,\s*"(?:result|error)"\s*:/

function canonicalResponseId(prefix: string): string | undefined {
  return CANONICAL_RESPONSE_HEADER.exec(prefix)?.[1]
}

/** stderr is diagnostic and line-oriented. Retain at most 64 KiB for an
 * unterminated line; after that emit one explicit truncation record and discard
 * bytes until the next newline. */
export const STDERR_LINE_MAX_BYTES = 64 * 1024
const TRUNCATED_SUFFIX = '… [truncated]'

/** Keep diagnostics useful without allowing a hostile stderr/frame line to
 * retain an unbounded string. The suffix makes the loss explicit. */
export function boundTransportLogLine(line: string): string {
  if (line.length <= TRANSPORT_LOG_LINE_LIMIT) return line
  return `${line.slice(0, TRANSPORT_LOG_LINE_LIMIT - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`
}

export function formatRpcErrorLog(
  method: string,
  error: { readonly code?: unknown; readonly message?: unknown }
): string {
  const code = typeof error.code === 'number' && Number.isFinite(error.code) ? ` (${error.code})` : ''
  const message = typeof error.message === 'string' ? error.message.trim() : ''
  return `[rpc] ${method} failed${code}: ${message || 'rpc error'}`
}

/** Establish transport-down/recovery state before rejected RPC continuations
 * run. Promise rejection handlers are microtasks, but keeping this ordering
 * explicit is load-bearing: pending prompt/steer ownership must see recovery
 * provenance rather than mistake the dead ephemeral SID for a user switch. */
export function notifyTransportExit(
  reason: string,
  onExit: ((reason: string) => void) | undefined,
  rejectAll: (reason: string) => void
): void {
  try {
    onExit?.(reason)
  } finally {
    rejectAll(reason)
  }
}

/** Small transport-owned ring, kept separate so boundedness is unit-testable
 * without spawning the Python child. */
export class TransportLogRing {
  private readonly lines: string[] = []

  push(line: string): void {
    const bounded = boundTransportLogLine(line.trimEnd())
    if (!bounded) return
    this.lines.push(bounded)
    if (this.lines.length > TRANSPORT_LOG_RING_LIMIT) {
      this.lines.splice(0, this.lines.length - TRANSPORT_LOG_RING_LIMIT)
    }
  }

  tail(limit = 20): string[] {
    return this.lines.slice(-Math.max(1, Math.min(TRANSPORT_LOG_RING_LIMIT, limit)))
  }
}

export class RawGatewayClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ws: WebSocket | null = null
  private wsConnectPromise: Promise<void> | null = null
  private attachUrl: string | undefined
  private pending = new Map<string, Pending>()
  private reqId = 0
  private processGeneration = 0
  private startupWatchdog: StartupWatchdog | undefined
  private closeWatchdog: CloseWatchdog | undefined
  private transportAccepting = false
  private readonly log: Log
  private readonly onEvent: (params: unknown) => void
  private readonly onExit?: (reason: string) => void
  private readonly transportLog = new TransportLogRing()

  constructor(options: RawClientOptions) {
    this.log = options.log
    this.onEvent = options.onEvent
    if (options.onExit) this.onExit = options.onExit
  }

  private pushTransportLog(line: string): void {
    this.transportLog.push(line)
  }

  /** A defensive copy: callers cannot mutate the authoritative bounded ring. */
  getLogTail(limit = 20): string[] {
    return this.transportLog.tail(limit)
  }

  /** Spawn the gateway child and begin reading frames. Idempotent. */
  start(): void {
    const requestedAttachUrl = resolveGatewayAttachUrl()
    if (this.proc || this.ws) {
      if (requestedAttachUrl === this.attachUrl) return
      this.replaceTransport('gateway attach url changed')
    }
    // A finished child must never leave a watchdog behind. Clear defensively
    // before assigning the next generation so a stale handle cannot be lost
    // when the new child arms its own timer.
    this.clearStartupWatchdog()
    this.clearCloseWatchdog()
    const generation = ++this.processGeneration
    this.attachUrl = requestedAttachUrl
    if (requestedAttachUrl) {
      this.startAttachedGateway(requestedAttachUrl, generation)
      return
    }
    const srcRoot = resolveSrcRoot()
    const python = resolvePython(srcRoot)
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    env.PYTHONPATH = env.PYTHONPATH ? `${srcRoot}:${env.PYTHONPATH}` : srcRoot
    env.HERMES_PYTHON_SRC_ROOT = srcRoot

    // Python resolves the package named by `-m` before tui_gateway.entry can
    // harden sys.path. Always start it in the selected Hermes runtime, never
    // HERMES_CWD (which may be a project or a `-w` worktree that contains its
    // own tui_gateway package). The gateway still uses HERMES_CWD /
    // TERMINAL_CWD from env as the user's workspace.
    const pythonCwd = srcRoot

    this.log.info('gateway', 'spawning tui_gateway', { python, cwd: pythonCwd, srcRoot })
    this.pushTransportLog(`[gateway] spawning python=${python} cwd=${pythonCwd}`)

    const proc = spawn(python, ['-m', 'tui_gateway.entry'], {
      cwd: pythonCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc
    this.transportAccepting = true

    // `exit` fires before stdio has necessarily drained. Keep this generation
    // installed (but reject NEW requests) until `close`, so a response or
    // event already buffered in stdout remains authoritative.
    // The short watchdog handles broken mocks/platforms that never emit close.
    proc.on('exit', (code, signal) =>
      this.beginExitDrain(proc, generation, `gateway exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
    )
    proc.on('close', (code, signal) => {
      const pendingReason = this.closeWatchdog?.generation === generation ? this.closeWatchdog.reason : undefined
      this.finishGeneration(
        proc,
        generation,
        pendingReason ?? `gateway closed (code=${code ?? 'null'} signal=${signal ?? 'null'})`
      )
    })
    proc.on('error', err => {
      const reason = `gateway spawn error: ${err instanceof Error ? err.message : String(err)}`
      this.abortGeneration(proc, generation, reason)
    })
    proc.stdin.on('error', cause => {
      this.abortGeneration(proc, generation, `gateway stdin failed: ${String(cause)}`)
    })

    // Startup-readiness watchdog: a child that hangs on import (wrong python /
    // missing dep) never emits the unsolicited `gateway.ready` handshake, leaving
    // a silent blank UI. Emit `gateway.start_timeout` so the store can surface a
    // failure line + the captured stderr tail. Cleared on ready (dispatch) / stop.
    // A recovery-respawn re-enters start(), so this re-arms per respawn — desired.
    const handle = setTimeout(() => {
      // clearTimeout() is the primary cancellation path; the identity checks
      // are the second line of defence if an expired callback was already
      // queued when a child exited and a replacement was spawned.
      if (
        this.proc !== proc ||
        this.processGeneration !== generation ||
        this.startupWatchdog?.generation !== generation
      ) {
        return
      }
      this.startupWatchdog = undefined
      const message = `no gateway.ready within ${STARTUP_TIMEOUT_MS}ms`
      this.pushTransportLog(`[gateway] ${message}`)
      try {
        this.onEvent({ type: 'gateway.start_timeout', payload: { message } })
      } finally {
        // A child stuck before readiness cannot service RPCs and will never
        // trigger recovery by itself. Make the timeout terminal for precisely
        // this generation, then terminate the captured child.
        this.abortGeneration(proc, generation, `gateway startup timeout: ${message}`)
      }
    }, STARTUP_TIMEOUT_MS)
    this.startupWatchdog = { generation, handle }

    // Arm readiness before attaching stdout: a mock/in-memory child can have a
    // ready frame buffered already, and dispatch must be able to cancel the
    // watchdog even when that frame is delivered immediately on subscription.
    this.readStdout(proc, generation)
    this.readStderr(proc, generation)
  }

  private armAttachedStartupWatchdog(generation: number, ws: WebSocket, safeUrl: string): void {
    const handle = setTimeout(() => {
      if (this.ws !== ws || this.processGeneration !== generation || this.startupWatchdog?.generation !== generation) {
        return
      }
      this.startupWatchdog = undefined
      const message = `no gateway.ready within ${STARTUP_TIMEOUT_MS}ms`
      this.pushTransportLog(`[gateway] ${message}`)
      try {
        this.onEvent({ type: 'gateway.start_timeout', payload: { message } })
      } finally {
        this.finishAttachedGeneration(generation, `gateway startup timeout: ${safeUrl}`)
      }
    }, STARTUP_TIMEOUT_MS)
    this.startupWatchdog = { generation, handle }
  }

  private startAttachedGateway(attachUrl: string, generation: number): void {
    const safeUrl = redactGatewayUrl(attachUrl)
    this.log.info('gateway', 'attaching to tui_gateway websocket', { url: safeUrl })
    this.pushTransportLog(`[gateway] attaching ${safeUrl}`)
    this.transportAccepting = false

    try {
      const ws = new WebSocket(attachUrl)
      // Normalize binary server frames to ArrayBuffer so one bounded decoder
      // handles Node's dashboard WebSocket implementation consistently.
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      let settled = false
      const connected = new Promise<void>((resolve, reject) => {
        ws.addEventListener(
          'open',
          () => {
            if (settled) return
            settled = true
            this.transportAccepting = true
            resolve()
          },
          { once: true }
        )
        ws.addEventListener(
          'error',
          () => {
            if (settled) return
            settled = true
            reject(new RawGatewayRequestError('transport-down', 'gateway websocket connection failed'))
          },
          { once: true }
        )
        ws.addEventListener(
          'close',
          event => {
            if (settled) return
            settled = true
            reject(
              new RawGatewayRequestError('transport-down', `gateway websocket closed (${event.code}) during connect`)
            )
          },
          { once: true }
        )
      })
      connected.catch(() => {})
      this.wsConnectPromise = connected
      this.armAttachedStartupWatchdog(generation, ws, safeUrl)

      ws.addEventListener('message', event => this.dispatchWebSocketFrame(event.data, ws, generation))
      ws.addEventListener('close', event => {
        if (this.ws !== ws || this.processGeneration !== generation) return
        this.finishAttachedGeneration(generation, `gateway websocket closed${event.code ? ` (${event.code})` : ''}`)
      })
      ws.addEventListener('error', () => {
        if (this.ws !== ws || this.processGeneration !== generation) return
        const line = '[gateway] websocket transport error'
        this.pushTransportLog(line)
        this.onEvent({ type: 'gateway.stderr', payload: { line } })
      })
    } catch {
      this.pushTransportLog(`[startup] failed to attach websocket ${safeUrl}`)
      this.finishAttachedGeneration(generation, `gateway websocket startup failed: ${safeUrl}`)
    }
  }

  private finishAttachedGeneration(generation: number, reason: string): boolean {
    if (this.processGeneration !== generation || !this.attachUrl) return false
    this.clearStartupWatchdog(generation)
    this.transportAccepting = false
    const ws = this.ws
    this.ws = null
    this.wsConnectPromise = null
    this.pushTransportLog(`[gateway] ${reason}`)
    try {
      notifyTransportExit(reason, this.onExit, failedReason => this.rejectAll(failedReason))
    } finally {
      try {
        ws?.close()
      } catch {
        // Best-effort cleanup; ownership was cleared before close dispatch.
      }
    }
    return true
  }

  private closeSocket(): void {
    const ws = this.ws
    this.ws = null
    this.wsConnectPromise = null
    try {
      ws?.close()
    } catch {
      // Best-effort teardown. Ownership was cleared first, so a late close is stale.
    }
  }

  private replaceTransport(reason: string): void {
    this.clearStartupWatchdog()
    this.clearCloseWatchdog()
    this.transportAccepting = false
    this.rejectAll(reason)
    this.closeSocket()
    const proc = this.proc
    this.proc = null
    if (proc) this.terminateCaptured(proc)
    this.attachUrl = undefined
  }

  private clearStartupWatchdog(generation?: number): void {
    const watchdog = this.startupWatchdog
    if (!watchdog || (generation !== undefined && watchdog.generation !== generation)) return
    clearTimeout(watchdog.handle)
    this.startupWatchdog = undefined
  }

  private clearCloseWatchdog(generation?: number): void {
    const watchdog = this.closeWatchdog
    if (!watchdog || (generation !== undefined && watchdog.generation !== generation)) return
    clearTimeout(watchdog.handle)
    this.closeWatchdog = undefined
  }

  private finishGeneration(proc: ChildProcessWithoutNullStreams, generation: number, reason: string): boolean {
    if (this.proc !== proc || this.processGeneration !== generation) return false
    this.log.warn('gateway', reason)
    this.pushTransportLog(`[gateway] ${reason}`)
    this.clearStartupWatchdog(generation)
    this.clearCloseWatchdog(generation)
    this.transportAccepting = false
    this.proc = null
    notifyTransportExit(reason, this.onExit, failedReason => this.rejectAll(failedReason))
    return true
  }

  private detachCapturedHandles(proc: ChildProcessWithoutNullStreams): void {
    proc.stdin.destroy()
    proc.stdout.destroy()
    proc.stderr.destroy()
    try {
      proc.unref()
    } catch (cause) {
      this.pushTransportLog(`[gateway] failed to unref child: ${String(cause)}`)
    }
  }

  private terminateCaptured(proc: ChildProcessWithoutNullStreams): void {
    const forceKill = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch (cause) {
        this.pushTransportLog(`[gateway] failed to force-kill child: ${String(cause)}`)
      } finally {
        // SIGKILL is the terminal boundary. Release every local handle even if
        // a broken mock/platform never reports `close` after the signal.
        proc.removeListener('close', onClose)
        this.detachCapturedHandles(proc)
      }
    }, CHILD_FORCE_KILL_GRACE_MS)
    forceKill.unref()
    const onClose = () => clearTimeout(forceKill)
    proc.once('close', onClose)
    try {
      if (!proc.kill('SIGTERM')) {
        clearTimeout(forceKill)
        proc.removeListener('close', onClose)
        this.detachCapturedHandles(proc)
        return
      }
    } catch (cause) {
      clearTimeout(forceKill)
      proc.removeListener('close', onClose)
      this.pushTransportLog(`[gateway] failed to terminate child: ${String(cause)}`)
      this.detachCapturedHandles(proc)
      return
    }
  }

  private abortGeneration(proc: ChildProcessWithoutNullStreams, generation: number, reason: string): void {
    if (this.proc !== proc || this.processGeneration !== generation) return
    try {
      this.finishGeneration(proc, generation, reason)
    } finally {
      // Always target the captured child: onExit may synchronously install a
      // replacement generation, which must never be killed by old cleanup.
      this.terminateCaptured(proc)
    }
  }

  private beginExitDrain(proc: ChildProcessWithoutNullStreams, generation: number, reason: string): void {
    if (this.proc !== proc || this.processGeneration !== generation) return
    if (this.closeWatchdog?.generation === generation) return
    this.transportAccepting = false
    this.clearStartupWatchdog(generation)
    const handle = setTimeout(() => {
      if (
        this.proc !== proc ||
        this.processGeneration !== generation ||
        this.closeWatchdog?.generation !== generation
      ) {
        return
      }
      try {
        this.finishGeneration(proc, generation, `${reason}; stdio close timed out`)
      } finally {
        this.terminateCaptured(proc)
      }
    }, CHILD_CLOSE_GRACE_MS)
    this.closeWatchdog = { generation, handle, reason }
  }

  private readStdout(proc: ChildProcessWithoutNullStreams, generation: number): void {
    // Framing belongs to one stdout stream, never to the client instance. A
    // partial final frame from a dead child must be discarded at that process
    // boundary instead of prefixing the replacement child's first frame.
    let buffer = ''
    let bufferBytes = 0
    let frameMaxBytes = STDOUT_FRAME_MAX_BYTES
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (this.proc !== proc || this.processGeneration !== generation) return
      // Consume a potentially multi-frame chunk segment-by-segment. Checking
      // the whole chunk before splitting would reject a large batch of many
      // perfectly small newline-delimited frames.
      let offset = 0
      while (offset <= chunk.length) {
        const newline = chunk.indexOf('\n', offset)
        const end = newline >= 0 ? newline : chunk.length
        const fragment = chunk.slice(offset, end)
        const nextBytes = bufferBytes + Buffer.byteLength(fragment, 'utf8')
        if (nextBytes > frameMaxBytes && frameMaxBytes === STDOUT_FRAME_MAX_BYTES) {
          // Normal frames pay no prefix-copy/regex cost. Reuse their already-
          // retained buffer only when the ordinary ceiling is actually crossed.
          const headerPrefix =
            buffer.length >= RESPONSE_HEADER_PREFIX_MAX_CHARS
              ? buffer.slice(0, RESPONSE_HEADER_PREFIX_MAX_CHARS)
              : `${buffer}${fragment.slice(0, RESPONSE_HEADER_PREFIX_MAX_CHARS - buffer.length)}`
          const responseId = canonicalResponseId(headerPrefix)
          const pendingMethod = responseId ? this.pending.get(responseId)?.method : undefined
          if (pendingMethod && LARGE_SESSION_RESPONSE_METHODS.has(pendingMethod)) {
            frameMaxBytes = SESSION_RESPONSE_FRAME_MAX_BYTES
            if (frameMaxBytes > STDOUT_FRAME_MAX_BYTES) {
              this.pushTransportLog(
                `[protocol] ${pendingMethod} response crossed ${STDOUT_FRAME_MAX_BYTES} bytes; ` +
                  `bounded at ${frameMaxBytes} bytes`
              )
            }
          }
        }

        if (nextBytes > frameMaxBytes) {
          // Drop the retained rope before transport recovery. The local stdout
          // listener remains attached to the old process, but generation/owner
          // guards make every later chunk inert.
          buffer = ''
          bufferBytes = 0
          this.abortOversizedStdoutFrame(proc, generation, frameMaxBytes)
          return
        }
        buffer += fragment
        bufferBytes = nextBytes
        if (newline < 0) return

        const line = buffer
        buffer = ''
        bufferBytes = 0
        frameMaxBytes = STDOUT_FRAME_MAX_BYTES
        if (line.trim()) this.dispatch(line, proc, generation)
        if (this.proc !== proc || this.processGeneration !== generation) return
        offset = newline + 1
        if (offset === chunk.length) return
      }
    })
    proc.stdout.on('error', cause => {
      if (this.proc !== proc || this.processGeneration !== generation) return
      const detail = String(cause)
      this.log.error('gateway', 'stdout read loop failed', { cause: detail })
      this.pushTransportLog(`[stdout] read loop failed: ${detail}`)
      this.abortGeneration(proc, generation, `gateway stdout failed: ${detail}`)
    })
  }

  private abortOversizedStdoutFrame(
    proc: ChildProcessWithoutNullStreams,
    generation: number,
    limitBytes: number
  ): void {
    if (this.proc !== proc || this.processGeneration !== generation) return
    const preview = `stdout JSON-RPC frame exceeded ${limitBytes} bytes without newline`
    this.log.error('gateway', 'oversized stdout frame', { generation, limitBytes })
    this.pushTransportLog(`[protocol] ${preview}`)
    try {
      this.onEvent({ type: 'gateway.protocol_error', payload: { preview } })
    } finally {
      this.abortGeneration(proc, generation, `gateway protocol error: ${preview}`)
    }
  }

  private readStderr(proc: ChildProcessWithoutNullStreams, generation: number): void {
    let buffer = ''
    let bufferBytes = 0
    let discarding = false
    const emit = (line: string): void => {
      if (!line.trim()) return
      this.log.debug('gateway.stderr', line)
      this.pushTransportLog(`[stderr] ${line}`)
      // Surface as a synthetic gateway.stderr event (matches Ink).
      this.onEvent({ type: 'gateway.stderr', payload: { line } })
    }
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      if (this.proc !== proc || this.processGeneration !== generation) return
      let offset = 0
      while (offset <= chunk.length) {
        const newline = chunk.indexOf('\n', offset)
        if (discarding) {
          if (newline < 0) return
          discarding = false
          offset = newline + 1
          if (offset === chunk.length) return
          continue
        }

        const end = newline >= 0 ? newline : chunk.length
        const fragment = chunk.slice(offset, end)
        const nextBytes = bufferBytes + Buffer.byteLength(fragment, 'utf8')
        if (nextBytes > STDERR_LINE_MAX_BYTES) {
          // One record per oversized physical line. Free the prefix immediately,
          // then hold only a boolean until the terminating newline arrives.
          buffer = ''
          bufferBytes = 0
          emit(`stderr line exceeded ${STDERR_LINE_MAX_BYTES} bytes; discarded until newline`)
          if (newline < 0) {
            discarding = true
            return
          }
          offset = newline + 1
          if (offset === chunk.length) return
          continue
        }

        buffer += fragment
        bufferBytes = nextBytes
        if (newline < 0) return
        emit(buffer)
        buffer = ''
        bufferBytes = 0
        offset = newline + 1
        if (offset === chunk.length) return
      }
    })
    // stderr pipe closing on exit is expected; ignore errors.
    proc.stderr.on('error', () => {})
  }

  private dispatch(line: string, proc: ChildProcessWithoutNullStreams, generation: number): void {
    if (this.proc !== proc || this.processGeneration !== generation) return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      this.log.warn('gateway', 'unparseable frame', { preview: line.slice(0, 120) })
      this.pushTransportLog(`[protocol] unparseable frame: ${line.slice(0, 120)}`)
      this.onEvent({ type: 'gateway.protocol_error', payload: { preview: line.slice(0, 120) } })
      return
    }
    this.routeFrame(line, msg, generation)
  }

  private dispatchWebSocketFrame(raw: unknown, ws: WebSocket, generation: number): void {
    if (this.ws !== ws || this.processGeneration !== generation) return
    const text = websocketFrameText(raw)
    if (text === undefined) return
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      const preview = text.trim().slice(0, 120) || '(empty frame)'
      this.pushTransportLog(`[protocol] malformed websocket frame: ${preview}`)
      this.onEvent({ type: 'gateway.protocol_error', payload: { preview } })
      return
    }
    this.routeFrame(text, msg, generation)
  }

  private routeFrame(line: string, msg: unknown, generation: number): void {
    if (!msg || typeof msg !== 'object') return
    const frame = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

    // Response: has an id matching a pending request.
    const pending = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined
    if (typeof frame.id === 'string' && pending) {
      const p = pending
      this.pending.delete(frame.id)
      if (frame.error) {
        const err = frame.error as { code?: unknown; data?: unknown; message?: unknown }
        this.pushTransportLog(formatRpcErrorLog(p.method, err))
        const message = typeof err.message === 'string' && err.message.trim() ? err.message : undefined
        const code = typeof err.code === 'number' && Number.isFinite(err.code) ? err.code : '?'
        p.reject(
          new RawGatewayRequestError(
            'rpc-error',
            message ?? `rpc error (${code})`,
            typeof err.code === 'number' && Number.isFinite(err.code) ? err.code : undefined,
            err.data
          )
        )
      } else {
        p.resolve(frame.result)
      }
      return
    }

    // Event push: method === "event", no id. Surface params (decoded upstream).
    if (frame.method === 'event' && frame.params && typeof frame.params === 'object') {
      // Handshake arrived: cancel the startup-readiness watchdog. Narrow without
      // `as` via `'type' in obj` + property access (the params record is loose).
      if ('type' in frame.params && frame.params.type === 'gateway.ready') {
        this.clearStartupWatchdog(generation)
        this.pushTransportLog('[gateway] ready')
      }
      this.onEvent(frame.params)
      return
    }

    this.log.warn('gateway', 'unroutable frame', { preview: line.slice(0, 120) })
    this.pushTransportLog(`[protocol] unroutable frame: ${line.slice(0, 120)}`)
  }

  /** Send a JSON-RPC request; resolves with `result` (long handlers reply async). */
  request<A = unknown>(method: string, params: unknown): Promise<A> {
    const requestedAttachUrl = resolveGatewayAttachUrl()
    if (requestedAttachUrl) {
      if (requestedAttachUrl !== this.attachUrl) {
        this.replaceTransport('gateway attach url changed')
        this.start()
      }
      return this.requestOverWebSocket<A>(method, params)
    }
    if (this.attachUrl) {
      this.replaceTransport('gateway attach url changed')
      this.start()
    }

    // Do NOT auto-start here: during the recovery backoff window `this.proc` is
    // null, and a respawn here would BYPASS the backoff (the first spawn always
    // comes from subscribe() → client.start()). A null proc rejects below.
    const proc = this.proc
    const stdin = proc?.stdin
    const generation = this.processGeneration
    if (!stdin || !this.transportAccepting) {
      return Promise.reject(new RawGatewayRequestError('transport-down', 'gateway not running'))
    }

    const id = `r${++this.reqId}`
    const frame = JSON.stringify({ id, jsonrpc: '2.0', method, params: params ?? {} }) + '\n'

    return new Promise<A>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.pushTransportLog(`[rpc] timeout: ${method}`)
          reject(new RawGatewayRequestError('timeout', `timeout: ${method}`))
        }
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        method,
        resolve: result => {
          clearTimeout(timer)
          resolve(result as A)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        }
      })

      try {
        // Newline-delimited JSON to the child's stdin. Fire-and-forget: the write
        // returns a backpressure boolean we intentionally ignore (frames are tiny
        // and ordered; Node flushes the pipe itself).
        stdin.write(frame, error => {
          if (!error) return
          this.pushTransportLog(`[rpc] write failed: ${method}: ${String(error)}`)
          this.abortGeneration(proc, generation, `gateway stdin write failed: ${String(error)}`)
        })
      } catch (cause) {
        this.pushTransportLog(`[rpc] write failed: ${method}: ${String(cause)}`)
        this.abortGeneration(proc, generation, `gateway stdin write failed: ${String(cause)}`)
      }
    })
  }

  private async ensureAttachedWebSocket(method: string): Promise<WebSocket> {
    const ws = this.ws
    if (!ws || !this.attachUrl) {
      throw new RawGatewayRequestError('transport-down', 'gateway not running')
    }
    if (ws.readyState === WS_CONNECTING) {
      await this.wsConnectPromise
    }
    if (this.ws !== ws || ws.readyState !== WS_OPEN) {
      throw new RawGatewayRequestError('transport-down', `gateway not connected: ${method}`)
    }
    return ws
  }

  private async requestOverWebSocket<A>(method: string, params: unknown): Promise<A> {
    const ws = await this.ensureAttachedWebSocket(method)
    const id = `r${++this.reqId}`
    const frame = JSON.stringify({ id, jsonrpc: '2.0', method, params: params ?? {} })
    return new Promise<A>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.pushTransportLog(`[rpc] timeout: ${method}`)
          reject(new RawGatewayRequestError('timeout', `timeout: ${method}`))
        }
      }, REQUEST_TIMEOUT_MS)
      timer.unref()
      this.pending.set(id, {
        method,
        resolve: result => {
          clearTimeout(timer)
          resolve(result as A)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        }
      })
      try {
        ws.send(frame)
      } catch (cause) {
        const pending = this.pending.get(id)
        if (pending) {
          clearTimeout(timer)
          this.pending.delete(id)
        }
        reject(new RawGatewayRequestError('transport-down', cause instanceof Error ? cause.message : String(cause)))
      }
    })
  }

  private rejectAll(reason: string): void {
    for (const p of this.pending.values()) p.reject(new RawGatewayRequestError('transport-down', reason))
    this.pending.clear()
  }

  /** Close stdin (EOF → child exits) and stop. */
  stop(): void {
    this.clearStartupWatchdog()
    this.clearCloseWatchdog()
    this.pushTransportLog('[gateway] stopping')
    this.rejectAll('gateway stopping')
    const proc = this.proc
    const stdin = proc?.stdin
    this.transportAccepting = false
    this.proc = null
    this.closeSocket()
    this.attachUrl = undefined
    if (!proc || !stdin) return

    // Graceful EOF first. Because ownership is detached immediately (so a
    // teardown cannot trigger recovery), this captured-child watchdog is the
    // only bounded fallback if Python ignores EOF. It can never target a later
    // generation because it closes over `proc`, not `this.proc`.
    let closed = false
    const stopWatchdog = setTimeout(() => {
      if (!closed) this.terminateCaptured(proc)
    }, CHILD_CLOSE_GRACE_MS)
    proc.once('close', () => {
      closed = true
      clearTimeout(stopWatchdog)
    })
    try {
      // Close stdin → child sees EOF and exits.
      stdin.end()
    } catch {
      clearTimeout(stopWatchdog)
      this.terminateCaptured(proc)
    }
  }
}
