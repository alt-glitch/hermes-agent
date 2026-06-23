/**
 * DelegateTool — renderer for `delegate_task` (glitch 2026-06-23: the tool
 * dumped its raw JSON result — `output { "status": "dispatched", … }` /
 * `output { "results": [ … ] }` — into the transcript because it fell back to
 * the default renderer's JSON body. Give it a clean, structured inline render.
 *
 * delegate_task returns ONE of two shapes (tools/delegate_tool.py):
 *
 *   Background dispatch (`background:true`, accepted by the async pool):
 *     {status:"dispatched", mode:"background", count:N, delegation_id:"deleg_…",
 *      goals:["…", …], note:"…"}
 *
 *   Synchronous / joined completion (sync path OR background pool at capacity):
 *     {results:[{task_index, status, summary, error?, duration_seconds, model},…],
 *      total_duration_seconds:N}
 *
 * Collapsed subtitle: `N agents dispatched (background)` /
 * `N agents · all done` / `N agents · 2 ok · 1 failed`.
 * Expanded body: one row per task — a status glyph + the goal + (when settled) a
 * one-line summary/error preview. The goals come from the result (`goals` on
 * dispatch) or, for completions, from the call args (`tasks[].goal` / `goal`),
 * matched by `task_index`. The raw JSON never shows.
 */
import { createMemo, For, Show } from 'solid-js'

import type { ToolPartState } from '../../logic/store.ts'
import { truncate } from '../../logic/toolOutput.ts'
import { useTheme } from '../theme.tsx'
import { DefaultToolBody, defaultSubtitle, structuredArgs, structuredResult } from './defaultTool.tsx'
import type { ToolBodyProps, ToolRenderer } from './registry.tsx'

/** A single task row for the expanded body. */
export interface DelegateRow {
  /** Status glyph state — drives glyph + color. */
  state: 'dispatched' | 'ok' | 'failed' | 'running'
  /** The task goal (verbatim, flattened). */
  goal: string
  /** One-line summary (completed) or error (failed) preview, if any. */
  detail?: string
}

/** The structured shape of a delegate_task result, normalized to rows + a header. */
export interface DelegateInfo {
  /** True for the background dispatch shape; false for a completion. */
  dispatched: boolean
  rows: DelegateRow[]
  /** Counts for the subtitle (completion only). */
  okCount: number
  failedCount: number
}

/** Flatten a goal string to one line. */
function flat(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
}

/** Goals declared in the call args, indexed by task position (for completions). */
function argGoals(part: ToolPartState): string[] {
  const args = structuredArgs(part)
  if (!args) return []
  const tasks = args['tasks']
  if (Array.isArray(tasks)) {
    return tasks.map(t => (t && typeof t === 'object' ? flat((t as Record<string, unknown>)['goal']) : ''))
  }
  const single = flat(args['goal'])
  return single ? [single] : []
}

/** Parse a delegate_task result into normalized rows, or undefined if it's not
 *  one of the two known shapes (then the default renderer takes over). */
export function delegateInfoOf(part: ToolPartState): DelegateInfo | undefined {
  const r = structuredResult(part)
  if (!r) return undefined

  // ── Background dispatch shape ──
  if (r['status'] === 'dispatched' && Array.isArray(r['goals'])) {
    const rows: DelegateRow[] = (r['goals'] as unknown[]).map(g => ({
      state: 'dispatched' as const,
      goal: flat(g)
    }))
    return { dispatched: true, rows, okCount: 0, failedCount: 0 }
  }

  // ── Synchronous / joined completion shape ──
  if (Array.isArray(r['results'])) {
    const goals = argGoals(part)
    let okCount = 0
    let failedCount = 0
    const rows: DelegateRow[] = (r['results'] as unknown[]).map((entry, i) => {
      const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      const idx = typeof e['task_index'] === 'number' ? e['task_index'] : i
      const status = flat(e['status']).toLowerCase()
      const ok = status === 'ok' || status === 'success' || status === 'complete'
      if (ok) okCount++
      else failedCount++
      const summary = flat(e['summary'])
      const error = flat(e['error'])
      const row: DelegateRow = {
        state: ok ? 'ok' : 'failed',
        goal: goals[idx] || flat(e['goal']) || `task ${String(idx + 1)}`
      }
      const detail = ok ? summary : error || summary
      if (detail) row.detail = detail
      return row
    })
    return { dispatched: false, rows, okCount, failedCount }
  }

  return undefined
}

/** Subtitle: `N agents dispatched (background)` / `N agents · all done` / `… 2 ok · 1 failed`. */
export function delegateSubtitle(part: ToolPartState): string {
  const info = delegateInfoOf(part)
  if (!info) return defaultSubtitle(part)
  const n = info.rows.length
  const agents = `${n} agent${n === 1 ? '' : 's'}`
  if (info.dispatched) return `${agents} dispatched (background)`
  if (info.failedCount === 0) return `${agents} · all done`
  if (info.okCount === 0) return `${agents} · all failed`
  return `${agents} · ${info.okCount} ok · ${info.failedCount} failed`
}

/** Glyph + theme color for a row state. */
function rowGlyph(state: DelegateRow['state']): string {
  switch (state) {
    case 'ok':
      return '✓'
    case 'failed':
      return '✗'
    case 'dispatched':
      return '→'
    default:
      return '⚡'
  }
}

/** Expanded body: one row per task (glyph + goal + optional summary/error preview). */
export function DelegateToolBody(props: ToolBodyProps) {
  const theme = useTheme()
  const info = createMemo(() => delegateInfoOf(props.part))
  return (
    <Show when={info()} fallback={<DefaultToolBody part={props.part} width={props.width} />}>
      {i => (
        <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          <For each={i().rows}>
            {row => {
              const color = () => {
                const c = theme().color
                if (row.state === 'ok') return c.ok
                if (row.state === 'failed') return c.error
                if (row.state === 'dispatched') return c.accent
                return c.warn
              }
              return (
                <box style={{ flexDirection: 'column', minWidth: 0 }}>
                  <text selectionBg={theme().color.selectionBg}>
                    <span style={{ fg: color() }}>{`${rowGlyph(row.state)} `}</span>
                    <span style={{ fg: theme().color.text }}>{truncate(row.goal, Math.max(1, props.width - 2))}</span>
                  </text>
                  <Show when={row.detail}>
                    <text selectionBg={theme().color.selectionBg}>
                      <span style={{ fg: theme().color.muted }}>
                        {`  ${truncate(row.detail ?? '', Math.max(1, props.width - 2))}`}
                      </span>
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
        </box>
      )}
    </Show>
  )
}

export const delegateRenderer: ToolRenderer = {
  Body: DelegateToolBody,
  // Ink-parity monitor tip — `/agents` opens the live subagent dashboard.
  hint: () => '(/agents to monitor)',
  // Expandable whenever we parsed a known shape with at least one task row.
  expandable: part => (delegateInfoOf(part)?.rows.length ?? 0) > 0,
  // Honest "(N lines)": goal rows (+ a detail row each when present).
  lines: part => {
    const info = delegateInfoOf(part)
    if (!info) return []
    const out: string[] = []
    for (const row of info.rows) {
      out.push(`${rowGlyph(row.state)} ${row.goal}`)
      if (row.detail) out.push(`  ${row.detail}`)
    }
    return out
  },
  subtitle: delegateSubtitle
}
