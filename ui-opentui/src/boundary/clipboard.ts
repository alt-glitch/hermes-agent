/**
 * Clipboard (item 1) — copy via OSC 52 (works over SSH/tmux) + a native platform
 * command, and read a clipboard IMAGE for paste-to-attach. Ported/trimmed from
 * opencode `clipboard.ts`. A boundary concern (spawns processes / writes stdout);
 * everything is best-effort and never throws into the view.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'

const POWERSHELL_READ_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))'
] as const

/** Whether `cmd` resolves on PATH (cached). We DON'T spawn missing tools: a failed
 *  spawn + writing to its dead stdin pipe raises EPIPE/SIGPIPE, and OpenTUI used to
 *  treat SIGPIPE as a shutdown signal — i.e. a clipboard miss would quit the TUI.
 *  Skipped on Windows (the built-in `clip` is always present; PATHEXT complicates
 *  a filename probe). */
const commandCache = new Map<string, boolean>()
function commandExists(cmd: string): boolean {
  if (platform() === 'win32') return true
  const cached = commandCache.get(cmd)
  if (cached !== undefined) return cached
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  const found = dirs.some(dir => existsSync(join(dir, cmd)))
  commandCache.set(cmd, found)
  return found
}

/** Run a command, optionally piping `input` to stdin; resolve its stdout bytes.
 *  Best-effort and crash-proof: every stream error (incl. EPIPE → SIGPIPE on a
 *  clipboard tool that exits early) is swallowed so a failed copy never throws out
 *  of the boundary or signals the process. */
function run(cmd: string, args: string[] = [], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, {
        stdio: [input === undefined ? 'ignore' : 'pipe', input === undefined ? 'pipe' : 'ignore', 'ignore']
      })
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error(String(cause)))
      return
    }
    const out: Buffer[] = []
    child.on('error', reject)
    child.stdout?.on('error', () => {}) // a closed stdout pipe must not throw
    child.stdout?.on('data', (c: Buffer) => out.push(c))
    child.on('close', code => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exit ${code}`))))
    if (input !== undefined) {
      // Copy is best-effort during shutdown: do not let its child keep Node alive.
      // Its stdout is ignored above because a referenced stdout pipe defeats
      // child.unref(); reads stay referenced and piped because they need output.
      child.unref()
      if (child.stdin) {
        // Writing to a tool that died/closed early raises EPIPE (→ SIGPIPE). Swallow it.
        child.stdin.on('error', () => {})
        try {
          child.stdin.end(input)
        } catch {
          // pipe already gone — nothing to flush
        }
      }
    }
  })
}

/** OSC 52 copy — the terminal puts `text` on the system clipboard (SSH/tmux-safe). */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const seq = `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`
  // tmux/screen need the sequence wrapped in their passthrough escape.
  process.stdout.write(process.env.TMUX || process.env.STY ? `\x1bPtmux;\x1b${seq}\x1b\\` : seq)
}

/** Native copy commands to try, in order, for the current platform. */
function copyCandidates(): Array<[string, string[]]> {
  const os = platform()
  if (os === 'darwin') return [['pbcopy', []]]
  if (os === 'win32') return [['clip', []]]
  // linux: prefer Wayland, then X11 tools
  const list: Array<[string, string[]]> = []
  if (process.env.WAYLAND_DISPLAY) list.push(['wl-copy', []])
  list.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']])
  return list
}

interface TextCandidate {
  readonly args: readonly string[]
  readonly base64?: boolean
  readonly cmd: string
}

function textCandidates(os: NodeJS.Platform, env: NodeJS.ProcessEnv): TextCandidate[] {
  if (os === 'darwin') return [{ args: [], cmd: 'pbpaste' }]
  if (os === 'win32') {
    return [{ args: POWERSHELL_READ_ARGS, base64: true, cmd: 'powershell.exe' }]
  }
  const list: TextCandidate[] = []
  if (env.WSL_INTEROP || env.WSL_DISTRO_NAME) {
    list.push({ args: POWERSHELL_READ_ARGS, base64: true, cmd: 'powershell.exe' })
  }
  if (env.WAYLAND_DISPLAY) list.push({ args: ['--type', 'text'], cmd: 'wl-paste' })
  list.push({ args: ['-selection', 'clipboard', '-out'], cmd: 'xclip' })
  return list
}

export function isUsableClipboardText(text: string | undefined): text is string {
  if (!text || !/[^\s]/u.test(text) || text.includes('\u0000')) return false
  let suspicious = 0
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if ((code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') || ch === '\ufffd') suspicious += 1
  }
  return suspicious <= Math.max(2, Math.floor(text.length * 0.02))
}

/** Explicit Ctrl/Cmd+V text fallback. Native bracketed paste remains the fast
 * path; this covers terminals (notably macOS) that surface only the hotkey. */
export async function readClipboardText(
  os: NodeJS.Platform = platform(),
  execute: typeof run = run,
  env: NodeJS.ProcessEnv = process.env,
  exists: (cmd: string) => boolean = commandExists
): Promise<string | undefined> {
  for (const candidate of textCandidates(os, env)) {
    if (!exists(candidate.cmd)) continue
    try {
      const stdout = await execute(candidate.cmd, [...candidate.args])
      const text = candidate.base64
        ? Buffer.from(stdout.toString('utf8').trim(), 'base64').toString('utf8')
        : stdout.toString('utf8')
      if (isUsableClipboardText(text)) return text
    } catch {
      // try the next backend
    }
  }
  return undefined
}

/** Copy `text` to the clipboard: OSC 52 (always) + the first native command that works. */
export async function writeClipboard(text: string): Promise<void> {
  writeOsc52(text) // primary path — SSH/tmux-safe, no subprocess
  for (const [cmd, args] of copyCandidates()) {
    if (!commandExists(cmd)) continue // never spawn a missing tool (avoids EPIPE/SIGPIPE)
    try {
      await run(cmd, args, text)
      return
    } catch {
      // try the next candidate
    }
  }
}

/** Read a clipboard IMAGE as base64 PNG (for paste-to-attach); undefined if none. */
export async function readClipboardImage(): Promise<{ data: string; mime: string } | undefined> {
  const os = platform()
  const tries: Array<[string, string[]]> = []
  if (os === 'linux') {
    if (process.env.WAYLAND_DISPLAY) tries.push(['wl-paste', ['-t', 'image/png']])
    tries.push(['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']])
  } else if (os === 'darwin') {
    tries.push(['pngpaste', ['-']]) // brew install pngpaste
  } else if (os === 'win32') {
    tries.push([
      'powershell.exe',
      [
        '-NonInteractive',
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $img=[System.Windows.Forms.Clipboard]::GetImage(); if($img){$ms=New-Object System.IO.MemoryStream; $img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([System.Convert]::ToBase64String($ms.ToArray()))}'
      ]
    ])
  }
  for (const [cmd, args] of tries) {
    if (!commandExists(cmd)) continue // skip missing tools (no pointless failing spawns)
    try {
      const buf = await run(cmd, args)
      if (buf.length) {
        // powershell already returns base64 text; the others return raw PNG bytes.
        const data = os === 'win32' ? buf.toString('utf8').trim() : buf.toString('base64')
        if (data) return { data, mime: 'image/png' }
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined
}
