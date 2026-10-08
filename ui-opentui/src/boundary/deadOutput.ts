/**
 * Dead-output-stream guard (Ink 296303302d `entry.tsx`).
 *
 * A dead PTY (terminal tab closed, SSH dropped without SIGHUP) turns every
 * stdout/stderr write into EIO/EPIPE. The renderer's own `uncaughtException`
 * handler (guarded in renderer.ts) reports and keeps the process alive, so each
 * failed frame write lands back there forever while the gateway child keeps
 * running: a zombie. Count consecutive dead-stream errors and exit for real
 * after `threshold` in a row; any other uncaught error resets the streak.
 *
 * Listens on `uncaughtExceptionMonitor`, which observes without changing
 * Node's default fatal behaviour (unlike adding an `uncaughtException`
 * listener, which would swallow errors when no other handler is installed).
 * The gateway child needs no explicit kill: its stdin pipe closes when this
 * process exits, which is the same EOF `RawGatewayClient.stop()` sends.
 */

export const DEAD_OUTPUT_EXIT_THRESHOLD = 5

const DEAD_STREAM_CODES = new Set(['EIO', 'EPIPE'])

export function deadStreamCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' && DEAD_STREAM_CODES.has(code) ? code : undefined
}

interface MonitorEmitter {
  on(event: 'uncaughtExceptionMonitor', listener: (error: unknown) => void): unknown
  off(event: 'uncaughtExceptionMonitor', listener: (error: unknown) => void): unknown
}

export interface DeadOutputGuardOptions {
  /** Called once when the streak reaches the threshold (log + exit). */
  readonly onDeadOutput: (code: string, count: number) => void
  readonly threshold?: number
  readonly emitter?: MonitorEmitter
}

/** Install the guard; returns a disposer. */
export function installDeadOutputGuard(options: DeadOutputGuardOptions): () => void {
  const threshold = options.threshold ?? DEAD_OUTPUT_EXIT_THRESHOLD
  const emitter: MonitorEmitter = options.emitter ?? process
  let consecutive = 0
  let fired = false
  const listener = (error: unknown) => {
    const code = deadStreamCode(error)
    if (!code) {
      consecutive = 0
      return
    }
    consecutive += 1
    if (consecutive >= threshold && !fired) {
      fired = true
      options.onDeadOutput(code, consecutive)
    }
  }
  emitter.on('uncaughtExceptionMonitor', listener)
  return () => {
    emitter.off('uncaughtExceptionMonitor', listener)
  }
}
