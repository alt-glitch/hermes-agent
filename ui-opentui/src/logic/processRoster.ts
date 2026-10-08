/**
 * Background `terminal(background=true)` processes owned by this session, as
 * the gateway's `process.list` reports them (Ink `app/processRoster.ts`).
 * Pure: the store keeps the raw snapshot; views derive rows against a clock.
 */
import type { ProcessEntry } from '../boundary/schema/ProcessResponses.ts'

export type ProcessRowStatus = 'done' | 'failed' | 'killed' | 'lost' | 'running'

export interface ProcessRow {
  readonly command: string
  /** `last: <latest output line>` while running; the exit verdict once finished. */
  readonly detail: string
  readonly elapsedSeconds: number
  readonly id: string
  /** Seconds since exit; 0 while running. */
  readonly sinceExitSeconds: number
  readonly status: ProcessRowStatus
}

/** A finished process stays on the dock long enough to read its exit line, then
 * leaves; the completion notification in the transcript is the durable record. */
export const PROCESS_RETAIN_SECONDS = 60

const REASON_STATUS: Readonly<Record<string, ProcessRowStatus>> = {
  failed_start: 'failed',
  killed: 'killed',
  lost: 'lost'
}

export function processStatus(entry: ProcessEntry): ProcessRowStatus {
  if (entry.status !== 'exited') return 'running'
  return REASON_STATUS[entry.completion_reason ?? ''] ?? (entry.exit_code ? 'failed' : 'done')
}

function lastOutputLine(preview: string | undefined): string {
  for (const line of (preview ?? '').split('\n').reverse()) {
    const text = line.replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return ''
}

function verdict(status: ProcessRowStatus, detail: string, sinceExit: number, exitCode: number | null | undefined) {
  if (status === 'running') return detail ? `last: ${detail}` : 'starting'
  const head = status === 'killed' || status === 'lost' ? status : `exit ${exitCode ?? '?'}`
  return `${head} · ${sinceExit}s ago`
}

/** Running processes first (longest running first), then recently exited ones
 * newest-exit first; exits older than the retention window (or with no
 * `exited_at`) are dropped. */
export function buildProcessRows(processes: readonly ProcessEntry[], nowMs: number): ProcessRow[] {
  const nowS = nowMs / 1000
  const rows: ProcessRow[] = []

  for (const entry of processes) {
    const status = processStatus(entry)
    const exitedAt = status === 'running' ? 0 : (entry.exited_at ?? 0)
    const sinceExitSeconds = exitedAt ? Math.max(0, Math.floor(nowS - exitedAt)) : 0
    if (status !== 'running' && (!exitedAt || sinceExitSeconds > PROCESS_RETAIN_SECONDS)) continue

    rows.push({
      command: (entry.command ?? '').replace(/\s+/g, ' ').trim() || 'background process',
      detail: verdict(status, lastOutputLine(entry.output_preview), sinceExitSeconds, entry.exit_code),
      elapsedSeconds: Math.max(0, (entry.uptime_seconds ?? 0) - sinceExitSeconds),
      id: entry.session_id,
      sinceExitSeconds,
      status
    })
  }

  return rows.sort((a, b) => {
    const ar = a.status === 'running'
    const br = b.status === 'running'
    if (ar !== br) return ar ? -1 : 1
    return ar ? b.elapsedSeconds - a.elapsedSeconds : a.sinceExitSeconds - b.sinceExitSeconds
  })
}

/** `3 running · 1 done` header summary. */
export function processSummary(rows: readonly ProcessRow[]): string {
  const running = rows.filter(row => row.status === 'running').length
  const done = rows.length - running
  return [running ? `${running} running` : '', done ? `${done} done` : ''].filter(Boolean).join(' · ')
}

export const PROCESS_GLYPH: Readonly<Record<ProcessRowStatus, string>> = {
  running: '⚙',
  done: '✔',
  failed: '✘',
  killed: '✘',
  lost: '?'
}

/** Ink `fmtDuration` (subagentTree): `42s`, `3m`, `3m 5s`. */
export function fmtProcessDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds - m * 60)
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

/** `42s · last: …` while running; the verdict alone once finished. */
export function processActivity(row: ProcessRow): string {
  return row.status === 'running' ? `${fmtProcessDuration(row.elapsedSeconds)} · ${row.detail}` : row.detail
}
