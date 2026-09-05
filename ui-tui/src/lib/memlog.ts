/**
 * memlog — in-process 1Hz memory self-sampling to NDJSON (Ink engine).
 *
 * Byte-for-byte the Ink counterpart of OpenTUI's
 * `ui-opentui/src/boundary/memlog.ts`: every TUI session logs its OWN samples
 * when enabled, keyed by pid + boot time, into `~/.hermes/logs/memwatch/`.
 * Both engines write to the SAME directory with the SAME filename scheme and
 * the SAME line schema so a single `memwatch-report.mjs`
 * (github.com/NousResearch/tui-bench) aggregates Ink and OpenTUI sessions into
 * one fleet table. That cross-engine compatibility IS the deliverable — it's
 * what lets the bench show a true side-by-side real-world memory arc instead of
 * "OpenTUI has dogfood data, Ink only has the harness."
 *
 * Gating: `HERMES_TUI_MEMLOG` — defaults to the `HERMES_TUI_DIAGNOSTICS`
 * master switch, individually overridable either way. One
 * `export HERMES_TUI_DIAGNOSTICS=1` in a dev's shell rc therefore covers every
 * session they ever start, on EITHER engine; regular users write nothing.
 *
 * Cost when on: one `process.memoryUsage()` + one short append per second
 * (~50 bytes/s). The interval is unref'd — it never keeps the process alive.
 * Every failure path disables the logger silently (diagnostics must never break
 * the TUI; this is the one place the "errors propagate" rule is intentionally
 * inverted, matching the OpenTUI collector). Retention: files older than 14
 * days are pruned at start, best-effort.
 *
 * Sample shape (one JSON object per line):
 *   { t, rss_kb, heap_used_kb, external_kb }
 * Ink has no windowing, so it emits NO `mounted`/`peak_mounted` field (those
 * are OpenTUI-windowing-specific). The rss/heap_used/external core is the
 * apples-to-apples comparison — and rss-vs-heap is exactly the native-RSS-gap
 * signal the memory story is about. `memwatch-report.mjs` treats `mounted` as
 * optional, so Ink lines aggregate cleanly alongside OpenTUI's.
 */
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const RETENTION_DAYS = 14
const SAMPLE_MS = 1000

const truthy = (v?: string) => /^(?:1|true|yes|on)$/i.test((v ?? '').trim())
const falsy = (v?: string) => /^(?:0|false|no|off)$/i.test((v ?? '').trim())

/**
 * Resolve a per-flag toggle against a default. Mirrors OpenTUI's `envFlag`:
 * an explicit truthy/falsy value on the flag wins; otherwise the default
 * (here, the diagnostics master switch) decides. Read per call so a wrapper
 * that mutates env before launch sees the live value.
 */
function memlogEnabled(): boolean {
  const diag = truthy(process.env.HERMES_TUI_DIAGNOSTICS)
  const raw = (process.env.HERMES_TUI_MEMLOG ?? '').trim()

  if (truthy(raw)) {
    return true
  }

  if (falsy(raw)) {
    return false
  }

  return diag
}

function memwatchDir(): string {
  const home = process.env.HERMES_HOME?.trim()
  const base = home && home.length > 0 ? home : join(homedir(), '.hermes')

  return join(base, 'logs', 'memwatch')
}

function pruneOld(dir: string): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000

  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) {
        continue
      }

      const p = join(dir, name)

      try {
        if (statSync(p).mtimeMs < cutoff) {
          unlinkSync(p)
        }
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Start the self-sampler (no-op unless enabled). Returns a stop function. */
export function startMemlog(): () => void {
  if (!memlogEnabled()) {
    return () => {}
  }

  try {
    const dir = memwatchDir()
    mkdirSync(dir, { recursive: true })
    pruneOld(dir)
    const boot = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
    const file = join(dir, `${boot}-${process.pid}.jsonl`)

    const timer = setInterval(() => {
      try {
        const m = process.memoryUsage()

        const line = JSON.stringify({
          t: Math.floor(Date.now() / 1000),
          rss_kb: Math.floor(m.rss / 1024),
          heap_used_kb: Math.floor(m.heapUsed / 1024),
          external_kb: Math.floor(m.external / 1024)
        })

        appendFileSync(file, line + '\n')
      } catch {
        clearInterval(timer) // a failing diagnostic must not retry forever
      }
    }, SAMPLE_MS)

    timer.unref?.()

    return () => clearInterval(timer)
  } catch {
    return () => {}
  }
}
