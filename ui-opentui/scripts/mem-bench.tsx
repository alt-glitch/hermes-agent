/**
 * DEV BENCH — NOT a test, NOT production code. Throwaway memory-measurement
 * harness for tuning the rolling `HERMES_TUI_MAX_MESSAGES` cap. Mounts the
 * production `<App store={createSessionStore()}>` under the `@opentui/solid` test
 * renderer and samples `process.memoryUsage()` + the mounted-renderable count +
 * `getAllocatorStats().activeAllocations`, forcing `global.gc()` before each
 * sample. Excluded from the test run (not a *.test.ts) and lint-clean.
 *
 * It pushes a REALISTIC heavy-session fixture (scripts/fixture.ts) — varied user
 * turns + fat multi-part assistant turns (markdown + reasoning + several tool
 * headers) — because per-message size varies hugely, so message-count is only a
 * LOOSE memory proxy and we're choosing a cap default.
 *
 *   node scripts/build.mjs scripts/mem-bench.tsx .bench   # build once (Solid+TS → JS)
 *   Live:       MEM_BENCH_MODE=live MEM_BENCH_TOTAL=4000 \
 *     node --experimental-ffi --expose-gc --no-warnings .bench/mem-bench.js
 *   Cold resume: MEM_BENCH_MODE=resume-cold MEM_BENCH_TOTAL=4000 \
 *     node --experimental-ffi --expose-gc --no-warnings .bench/mem-bench.js
 *   Warm switch: MEM_BENCH_MODE=resume-switch MEM_BENCH_TOTAL=4000 \
 *     node --experimental-ffi --expose-gc --no-warnings .bench/mem-bench.js
 *
 * Run each mode/cap as a SEPARATE node invocation so the native heap starts
 * fresh. Production clamps the requested cap to 3,000 with windowing or 1,000
 * without it, so this diagnostic never labels a clamped run "uncapped":
 *   for cap in 400 1500 3000; do \
 *     MEM_BENCH_MODE=live MEM_BENCH_TOTAL=4000 HERMES_TUI_MAX_MESSAGES=$cap \
 *       node --experimental-ffi --expose-gc --no-warnings .bench/mem-bench.js; done
 *
 * Signal: native `getAllocatorStats().activeAllocations` (the Zig-side allocator
 * count — every live renderable/layout subtree contributes) and the recursive
 * renderable descendant count under `renderer.root`. RSS is reported too but is
 * noisy and native allocator pools may not return promptly to the OS, so the
 * meaningful comparison is the STEADY-STATE plateau: a smaller requested cap
 * should flatten before the production 3,000-row ceiling.
 *
 * GC: forces `global.gc()` (synchronous) before each sample to measure RETAINED
 * memory, not garbage — the harness fails fast unless Node has `--expose-gc`.
 *
 * RESUME MODES are component benchmarks, not end-to-end RPC timings. They build
 * the mapped Message[] before measurement, then time `commitSessionSnapshot`,
 * a headless layout flush, and bounded public-API Tree-sitter settlement. Cold
 * starts from an empty mounted app; switch replaces an already-mounted session.
 * Gateway latency, `mapResumeHistory`, and terminal transport paint are
 * intentionally excluded and must be measured by the PTY suite.
 */
import { CodeRenderable, resolveRenderLib } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { testRender } from '@opentui/solid'

import { installFfiCoordSafety } from '../src/boundary/ffiSafe.ts'
import { createSessionStore } from '../src/logic/store.ts'
import { App } from '../src/view/App.tsx'
import { ThemeProvider } from '../src/view/theme.tsx'
import { applyTurn, materialize, rowsPerTurn } from './fixture.ts'

// `testRender` creates its own renderer instead of going through
// boundary/renderer.ts, so install the same Node-FFI coordinate guard that the
// production entrypoint uses before mounting any native renderables.
installFfiCoordSafety()

const lib = resolveRenderLib()

const TOTAL = Number.parseInt(process.env.MEM_BENCH_TOTAL ?? '4000', 10)
const SAMPLE_EVERY = Number.parseInt(process.env.MEM_BENCH_SAMPLE ?? '500', 10)
const CYCLES = Number.parseInt(process.env.MEM_BENCH_CYCLES ?? '1', 10)
const ALLOCATION_TOLERANCE = Number.parseInt(process.env.MEM_BENCH_ALLOCATION_TOLERANCE ?? '0', 10)
const HIGHLIGHT_TIMEOUT_MS = Number.parseInt(process.env.MEM_BENCH_HIGHLIGHT_TIMEOUT_MS ?? '750', 10)
const REQUESTED_CAP = process.env.HERMES_TUI_MAX_MESSAGES ?? '(production default)'
const MODE = (() => {
  const value = process.env.MEM_BENCH_MODE ?? 'live'
  if (value === 'live' || value === 'resume-cold' || value === 'resume-switch') return value
  throw new Error(`invalid MEM_BENCH_MODE: ${value}`)
})()

if (!Number.isInteger(CYCLES) || CYCLES < 1) throw new Error(`invalid MEM_BENCH_CYCLES: ${CYCLES}`)
if (CYCLES > 1 && CYCLES < 8) throw new Error('repeated switch proof requires at least 8 cycles')
if (MODE !== 'resume-switch' && CYCLES !== 1) {
  throw new Error('MEM_BENCH_CYCLES is only supported with MEM_BENCH_MODE=resume-switch')
}
if (!Number.isInteger(ALLOCATION_TOLERANCE) || ALLOCATION_TOLERANCE < 0) {
  throw new Error(`invalid MEM_BENCH_ALLOCATION_TOLERANCE: ${ALLOCATION_TOLERANCE}`)
}

const MB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

type DeadlineResult<T> = { readonly timedOut: true } | { readonly timedOut: false; readonly value: T }

async function completesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<DeadlineResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(value => ({ timedOut: false as const, value })),
      new Promise<DeadlineResult<T>>(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Force a synchronous full GC to measure RETAINED memory. */
const forceGc = (): void => {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) throw new Error('mem-bench requires node --expose-gc')
  gc()
}

/** Recursively count every Renderable under root (a proxy for live layout nodes). */
function descendantCount(node: Renderable): number {
  let n = 0
  for (const child of node.getChildren()) n += 1 + descendantCount(child)
  return n
}

function codeRenderables(node: Renderable, found: CodeRenderable[] = []): CodeRenderable[] {
  if (node instanceof CodeRenderable) found.push(node)
  for (const child of node.getChildren()) codeRenderables(child, found)
  return found
}

interface HighlightSettlement {
  readonly codeRenderables: number
  readonly elapsedMs: number
  readonly pending: number
  readonly rejected: number
  readonly complete: boolean
}

/** Await mounted code renderables through OpenTUI's public highlightingDone API. */
async function settleHighlights(root: Renderable): Promise<HighlightSettlement> {
  const startedAt = performance.now()
  const timeout = Number.isFinite(HIGHLIGHT_TIMEOUT_MS) ? Math.max(0, HIGHLIGHT_TIMEOUT_MS) : 750
  const deadline = startedAt + timeout
  let seen = codeRenderables(root)
  let rejected = 0
  for (;;) {
    const pending = seen.filter(code => code.isHighlighting)
    if (pending.length === 0) {
      return {
        codeRenderables: seen.length,
        elapsedMs: performance.now() - startedAt,
        pending: 0,
        rejected,
        complete: true
      }
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      return {
        codeRenderables: seen.length,
        elapsedMs: performance.now() - startedAt,
        pending: pending.length,
        rejected,
        complete: false
      }
    }
    const completed = await completesWithin(Promise.allSettled(pending.map(code => code.highlightingDone)), remaining)
    if (completed.timedOut) {
      seen = codeRenderables(root)
      return {
        codeRenderables: seen.length,
        elapsedMs: performance.now() - startedAt,
        pending: seen.filter(code => code.isHighlighting).length,
        rejected,
        complete: false
      }
    }
    rejected += completed.value.filter(result => result.status === 'rejected').length
    if (rejected > 0) {
      seen = codeRenderables(root)
      return {
        codeRenderables: seen.length,
        elapsedMs: performance.now() - startedAt,
        pending: seen.filter(code => code.isHighlighting).length,
        rejected,
        complete: false
      }
    }
    // Highlight callbacks may create/reveal another code renderable; re-scan
    // until the mounted tree is quiescent or the shared deadline expires.
    seen = codeRenderables(root)
  }
}

async function main(): Promise<void> {
  // Build resume fixtures before the renderer exists and GC the throwaway Solid
  // stores used by materialize(). Both old+new arrays intentionally remain live
  // for resume-switch, matching production while an RPC result replaces history.
  const targetFixture = MODE === 'live' ? undefined : materialize(TOTAL, MODE === 'resume-switch' ? 10_000 : 0)
  const previousFixture = MODE === 'resume-switch' ? materialize(TOTAL) : undefined
  forceGc()

  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })

  const setup = await testRender(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} />
      </ThemeProvider>
    ),
    { width: 100, height: 40, exitOnCtrlC: false }
  )
  try {
    await setup.renderOnce()
    await setup.flush()

    if (MODE === 'live') {
      process.stdout.write(
        `\n=== mem-bench (REALISTIC fixture) mode=live requestedCap=${REQUESTED_CAP} ` +
          `total=${TOTAL} sampleEvery=${SAMPLE_EVERY} ===\n`
      )
      process.stdout.write(
        'pushes | msgs | rss(MB) | heapUsed(MB) | external(MB) | arrayBuf(MB) | activeAllocs | renderables\n'
      )
      process.stdout.write(
        '-------+------+---------+--------------+--------------+--------------+--------------+------------\n'
      )

      async function sample(pushes: number): Promise<void> {
        await setup.renderOnce()
        await setup.flush()
        const settlement = await settleHighlights(setup.renderer.root)
        if (pushes > 0 && settlement.codeRenderables === 0) {
          throw new Error('fixture mounted zero CodeRenderables; check duplicate @opentui/core resolution')
        }
        if (!settlement.complete) {
          throw new Error(
            `highlight settlement failed (${settlement.pending} pending, ${settlement.rejected} rejected)`
          )
        }
        await setup.renderOnce()
        await setup.flush()
        forceGc() // synchronous, full GC — measure retained, not garbage
        const m = process.memoryUsage()
        const alloc = lib.getAllocatorStats()
        const renderables = descendantCount(setup.renderer.root)
        const cols = [
          String(pushes).padStart(6),
          String(store.state.messages.length).padStart(4),
          MB(m.rss).padStart(7),
          MB(m.heapUsed).padStart(12),
          MB(m.external).padStart(12),
          MB(m.arrayBuffers).padStart(12),
          String(alloc.activeAllocations).padStart(12),
          String(renderables).padStart(11)
        ]
        process.stdout.write(cols.join(' | ') + '\n')
      }

      await sample(0)
      // Pump turns inline, sampling each time the cumulative produced-row count
      // crosses a SAMPLE_EVERY boundary. Each boundary awaits mounted code
      // highlighting through the public OpenTUI promise before retained sampling.
      let pushed = 0
      let nextSample = SAMPLE_EVERY
      let turn = 0
      while (pushed < TOTAL) {
        applyTurn(store, turn)
        pushed += rowsPerTurn(turn)
        turn++
        if (pushed >= nextSample) {
          await sample(Math.min(pushed, TOTAL))
          while (nextSample <= pushed) nextSample += SAMPLE_EVERY
        }
      }
      process.stdout.write('highlight settlement: complete\n')
      return
    }

    if (!targetFixture) throw new Error(`missing target fixture for ${MODE}`)
    if (previousFixture) {
      store.beginBuffer()
      store.commitSessionSnapshot('bench-previous', previousFixture, { model: 'fixture-previous' }, () => true)
      await setup.renderOnce()
      await setup.flush()
      const previousSettlement = await settleHighlights(setup.renderer.root)
      await setup.renderOnce()
      await setup.flush()
      if (previousSettlement.codeRenderables === 0) {
        throw new Error('previous fixture mounted zero CodeRenderables')
      }
      if (!previousSettlement.complete) {
        throw new Error(
          `previous-session highlighting failed ` +
            `(${previousSettlement.pending} pending, ${previousSettlement.rejected} rejected)`
        )
      }
    }

    process.stdout.write(`\n--- resume component path (${MODE}; RPC/map/terminal paint excluded) ---\n`)
    process.stdout.write(`requested cap      : ${REQUESTED_CAP}\n`)
    process.stdout.write(`effective cap      : ${store.messageCap}\n`)
    process.stdout.write(`fixture msgs built : ${targetFixture.length}\n`)
    process.stdout.write(`cycles              : ${CYCLES}\n`)
    process.stdout.write(
      'cycle | fixture | mounted | rss(MB) | activeAllocs | renderables | adopt(ms) | layout(ms) | highlight(ms) | total(ms)\n'
    )

    const warmPlateau = new Map<string, { allocations: number; renderables: number }>()
    const plateauViolations: string[] = []
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const useTarget = cycle % 2 === 1 || !previousFixture
      const fixture = useTarget ? targetFixture : previousFixture
      const fixtureName = useTarget ? 'target' : 'previous'

      forceGc()
      const hydrateStartedAt = performance.now()
      store.beginBuffer()
      store.commitSessionSnapshot(
        `bench-${fixtureName}-${cycle}`,
        fixture,
        { model: `fixture-${fixtureName}` },
        () => true
      )
      const snapshotCommittedAt = performance.now()
      const expectedMounted = Math.min(fixture.length, store.messageCap)
      if (store.state.messages.length !== expectedMounted) {
        throw new Error(`message cap regression: mounted ${store.state.messages.length}, expected ${expectedMounted}`)
      }
      await setup.renderOnce()
      await setup.flush()
      const layoutFlushedAt = performance.now()
      const settlement = await settleHighlights(setup.renderer.root)
      await setup.renderOnce()
      await setup.flush()
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      await setup.renderOnce()
      await setup.flush()
      const postHighlightFlushAt = performance.now()
      forceGc()

      const memory = process.memoryUsage()
      if (memory.rss > 350 * 1024 * 1024) throw new Error(`RSS safety stop: ${MB(memory.rss)} MB`)
      const allocations = lib.getAllocatorStats().activeAllocations
      const renderables = descendantCount(setup.renderer.root)
      if (settlement.codeRenderables === 0) throw new Error('resume fixture mounted zero CodeRenderables')
      if (!settlement.complete) {
        throw new Error(`resume highlighting failed (${settlement.pending} pending, ${settlement.rejected} rejected)`)
      }

      process.stdout.write(
        [
          String(cycle).padStart(5),
          fixtureName.padStart(8),
          String(store.state.messages.length).padStart(7),
          MB(memory.rss).padStart(7),
          String(allocations).padStart(12),
          String(renderables).padStart(11),
          (snapshotCommittedAt - hydrateStartedAt).toFixed(2).padStart(9),
          (layoutFlushedAt - snapshotCommittedAt).toFixed(2).padStart(10),
          settlement.elapsedMs.toFixed(2).padStart(13),
          (postHighlightFlushAt - hydrateStartedAt).toFixed(2).padStart(9)
        ].join(' | ') + '\n'
      )

      // Two target/previous round trips warm native allocator pools. Each
      // fixture's next visit establishes its plateau; later visits must match it.
      if (cycle > 4) {
        const warm = warmPlateau.get(fixtureName)
        if (warm === undefined) {
          warmPlateau.set(fixtureName, { allocations, renderables })
        } else {
          if (renderables !== warm.renderables) {
            plateauViolations.push(
              `renderable leak: cycle ${cycle} has ${renderables}, warm ${fixtureName} had ${warm.renderables}`
            )
          }
          if (allocations > warm.allocations + ALLOCATION_TOLERANCE) {
            plateauViolations.push(
              `allocation leak: cycle ${cycle} has ${allocations}, warm ${fixtureName} had ${warm.allocations} ` +
                `(tolerance ${ALLOCATION_TOLERANCE})`
            )
          }
        }
      }
    }
    if (plateauViolations.length > 0) throw new Error(plateauViolations.join('; '))
    process.stdout.write(
      `repeated-switch plateau: pass (renderables exact, active allocation tolerance ${ALLOCATION_TOLERANCE})\n`
    )
  } finally {
    setup.renderer.destroy()
  }
}

await main()
