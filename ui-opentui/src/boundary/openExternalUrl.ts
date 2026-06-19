/**
 * Open an external URL in the user's default browser/handler. Ported verbatim
 * from the Ink TUI (`ui-tui/src/lib/openExternalUrl.ts`); pure Node
 * `child_process` (no Ink, no Effect), so it runs unchanged on the engine's
 * Bun/Node runtime. Used by the billing overlay's "Manage on portal" action.
 *
 * Safety:
 * - http(s) only. Anything else (`file:`, `data:`, `javascript:`, etc.) is
 *   rejected — a hostile model could otherwise emit a `file:///` link and trick
 *   a click into running an arbitrary local handler.
 * - Hostname is parsed via `URL`; only well-formed URLs are forwarded.
 * - Spawned via `child_process.spawn` with an arg array (no shell), so a URL
 *   containing shell metacharacters cannot be interpreted as a command.
 *
 * Returns `true` if the spawn was attempted, `false` if the open could not
 * proceed (URL rejected, no known opener for the platform, or `spawn()` threw
 * synchronously). Async failures after spawn are absorbed by a no-op 'error'
 * listener so the TUI never crashes — the user just doesn't see their browser.
 */
import { spawn, type SpawnOptions } from 'node:child_process'
import { platform } from 'node:os'

export type OpenDependencies = {
  spawn?: typeof spawn
  platform?: () => string
}

export function openExternalUrl(rawUrl: string, dependencies: OpenDependencies = {}): boolean {
  const url = parseSafeUrl(rawUrl)
  if (!url) return false

  const spawnFn = dependencies.spawn ?? spawn
  const platformId = dependencies.platform?.() ?? platform()
  const command = openCommand(platformId)
  if (!command) return false

  try {
    const child = spawnFn(command.command, [...command.args, url.toString()], {
      // Detach so closing the TUI doesn't kill the browser; ignore stdio so a
      // browser's stderr can't land in our alt screen.
      detached: true,
      stdio: 'ignore'
    } satisfies SpawnOptions)
    // spawn returns a ChildProcess synchronously even when the binary is
    // missing/unusable; the failure surfaces later as an 'error' event. Without
    // a handler an unhandled 'error' crashes Node → tears down the TUI. Attach a
    // no-op consumer before unref().
    child.once('error', () => {
      // intentional no-op
    })
    child.unref()
    return true
  } catch {
    // spawn can throw synchronously on argv-validation failures (e.g. NUL in the
    // path). Treat it as a no-op rather than crashing.
    return false
  }
}

/** Validate and normalize a URL for opening externally. Exported for testing. */
export function parseSafeUrl(value: string): null | URL {
  if (!value || typeof value !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  // http(s) only — opening file://, data:, javascript:, etc. would let a
  // malicious model run a local handler on a single click.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  // Reject empty/whitespace hostnames defensively (`http:///foo` parses on some
  // Node versions).
  if (!parsed.hostname.trim()) return null
  return parsed
}

type OpenCommand = { command: string; args: readonly string[] }

/**
 * Per-platform open command. We avoid `cmd.exe /c start` on Windows (a cmd
 * builtin that reparses the URL through cmd's tokenizer, breaking `&` query
 * strings and undermining the protocol allowlist); `explorer.exe <url>` invokes
 * the registered http(s) handler without a shell. Linux/BSD use `xdg-open`.
 * Returns null for platforms with no known safe opener so the caller surfaces
 * "no opener" honestly.
 */
export function openCommand(platformId: string): OpenCommand | null {
  if (platformId === 'darwin') return { command: 'open', args: [] }
  if (platformId === 'win32') return { command: 'explorer.exe', args: [] }
  const XDG_OPEN_PLATFORMS = new Set(['linux', 'freebsd', 'openbsd', 'netbsd', 'dragonfly'])
  if (XDG_OPEN_PLATFORMS.has(platformId)) return { command: 'xdg-open', args: [] }
  return null
}
