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

import type { Log } from '../log.ts'
import { resolvePython, resolveSrcRoot } from './python.ts'

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  method: string
}

export interface RawClientOptions {
  readonly log: Log
  /** Called with each server-pushed event's `params` object (still unknown — decoded upstream). */
  readonly onEvent: (params: unknown) => void
  /** Called when the child exits / errors (so the layer can reject pending + reconnect). */
  readonly onExit?: (reason: string) => void
}

const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.HERMES_TUI_RPC_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? Math.max(5000, raw) : 120_000
})()

const STARTUP_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.HERMES_TUI_STARTUP_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? Math.max(2000, raw) : 20_000
})()

export const TRANSPORT_LOG_RING_LIMIT = 200
export const TRANSPORT_LOG_LINE_LIMIT = 4096
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
  private pending = new Map<string, Pending>()
  private reqId = 0
  private stdinBuffer = ''
  private startupTimer: ReturnType<typeof setTimeout> | undefined
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
    if (this.proc) return
    const srcRoot = resolveSrcRoot()
    const python = resolvePython(srcRoot)
    const cwd = process.env.HERMES_CWD?.trim() || srcRoot
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    env.PYTHONPATH = env.PYTHONPATH ? `${srcRoot}:${env.PYTHONPATH}` : srcRoot
    env.HERMES_PYTHON_SRC_ROOT = srcRoot

    this.log.info('gateway', 'spawning tui_gateway', { python, cwd, srcRoot })
    this.pushTransportLog(`[gateway] spawning python=${python} cwd=${cwd}`)

    const proc = spawn(python, ['-m', 'tui_gateway.entry'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    // Identity guard: a stale child's late exit/error must not act after a restart
    // has already installed a new `this.proc` (else it'd null the live child).
    // Nulling `this.proc` here makes a subsequent finish() a no-op (idempotent),
    // covering the ENOENT case where 'error' fires and 'exit' does not.
    const finish = (reason: string) => {
      if (this.proc !== proc) return
      this.log.warn('gateway', reason)
      this.pushTransportLog(`[gateway] ${reason}`)
      this.rejectAll(reason)
      this.proc = null
      this.onExit?.(reason)
    }
    proc.on('exit', (code, signal) => finish(`gateway exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`))
    proc.on('error', err => finish(`gateway spawn error: ${err instanceof Error ? err.message : String(err)}`))
    this.proc = proc
    this.readStdout(proc)
    this.readStderr(proc)

    // Startup-readiness watchdog: a child that hangs on import (wrong python /
    // missing dep) never emits the unsolicited `gateway.ready` handshake, leaving
    // a silent blank UI. Emit `gateway.start_timeout` so the store can surface a
    // failure line + the captured stderr tail. Cleared on ready (dispatch) / stop.
    // A recovery-respawn re-enters start(), so this re-arms per respawn — desired.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      this.pushTransportLog(`[gateway] no gateway.ready within ${STARTUP_TIMEOUT_MS}ms`)
      this.onEvent({
        type: 'gateway.start_timeout',
        payload: { message: `no gateway.ready within ${STARTUP_TIMEOUT_MS}ms` }
      })
    }, STARTUP_TIMEOUT_MS)
  }

  private readStdout(proc: ChildProcessWithoutNullStreams): void {
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.stdinBuffer += chunk
      let nl: number
      while ((nl = this.stdinBuffer.indexOf('\n')) >= 0) {
        const line = this.stdinBuffer.slice(0, nl)
        this.stdinBuffer = this.stdinBuffer.slice(nl + 1)
        if (line.trim()) this.dispatch(line)
      }
    })
    proc.stdout.on('error', cause => {
      const detail = String(cause)
      this.log.error('gateway', 'stdout read loop failed', { cause: detail })
      this.pushTransportLog(`[stdout] read loop failed: ${detail}`)
    })
  }

  private readStderr(proc: ChildProcessWithoutNullStreams): void {
    let buf = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) {
          this.log.debug('gateway.stderr', line)
          this.pushTransportLog(`[stderr] ${line}`)
          // Surface as a synthetic gateway.stderr event (matches Ink).
          this.onEvent({ type: 'gateway.stderr', payload: { line } })
        }
      }
    })
    // stderr pipe closing on exit is expected; ignore errors.
    proc.stderr.on('error', () => {})
  }

  private dispatch(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      this.log.warn('gateway', 'unparseable frame', { preview: line.slice(0, 120) })
      this.pushTransportLog(`[protocol] unparseable frame: ${line.slice(0, 120)}`)
      this.onEvent({ type: 'gateway.protocol_error', payload: { preview: line.slice(0, 120) } })
      return
    }
    if (!msg || typeof msg !== 'object') return
    const frame = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

    // Response: has an id matching a pending request.
    const pending = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined
    if (typeof frame.id === 'string' && pending) {
      const p = pending
      this.pending.delete(frame.id)
      if (frame.error) {
        const err = frame.error as { code?: unknown; message?: unknown }
        this.pushTransportLog(formatRpcErrorLog(p.method, err))
        const message = typeof err.message === 'string' && err.message.trim() ? err.message : undefined
        const code = typeof err.code === 'number' && Number.isFinite(err.code) ? err.code : '?'
        p.reject(new Error(message ?? `rpc error (${code})`))
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
        if (this.startupTimer) clearTimeout(this.startupTimer)
        this.startupTimer = undefined
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
    // Do NOT auto-start here: during the recovery backoff window `this.proc` is
    // null, and a respawn here would BYPASS the backoff (the first spawn always
    // comes from subscribe() → client.start()). A null proc rejects below.
    const proc = this.proc
    const stdin = proc?.stdin
    if (!stdin) return Promise.reject(new Error('gateway not running'))

    const id = `r${++this.reqId}`
    const frame = JSON.stringify({ id, jsonrpc: '2.0', method, params: params ?? {} }) + '\n'

    return new Promise<A>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.pushTransportLog(`[rpc] timeout: ${method}`)
          reject(new Error(`timeout: ${method}`))
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
        stdin.write(frame)
      } catch (cause) {
        this.pending.delete(id)
        clearTimeout(timer)
        this.pushTransportLog(`[rpc] write failed: ${method}: ${String(cause)}`)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  private rejectAll(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }

  /** Close stdin (EOF → child exits) and stop. */
  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.pushTransportLog('[gateway] stopping')
    this.rejectAll('gateway stopping')
    const stdin = this.proc?.stdin
    if (stdin) {
      try {
        // Close stdin → child sees EOF and exits.
        stdin.end()
      } catch {
        // already gone
      }
    }
    this.proc = null
  }
}
