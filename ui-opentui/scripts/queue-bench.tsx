/**
 * DEV BENCH — NOT a test and not production code. Exercises the production
 * busy-queue view/composer under OpenTUI's native test renderer and records the
 * memory/latency invariants that keep renderer-side input bounded.
 *
 * Build and run in a fresh Node process so native allocator/RSS samples are not
 * contaminated by the test runner:
 *
 *   node scripts/build.mjs scripts/queue-bench.tsx .bench
 *   node --experimental-ffi --expose-gc --no-warnings .bench/queue-bench.js
 *
 * The useful comparisons are renderables/native allocations and retained heap.
 * RSS includes OpenTUI/Node baseline pools and is reported for device-level
 * regressions, not as an allocation attribution claim.
 */
import { resolveRenderLib } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { KeymapProvider } from '@opentui/keymap/solid'
import { testRender, useRenderer } from '@opentui/solid'
import { createMemo } from 'solid-js'

import { installFfiCoordSafety } from '../src/boundary/ffiSafe.ts'
import { BUSY_QUEUE_MAX_CHARS, BUSY_QUEUE_MAX_EDIT_CHARS, BUSY_QUEUE_MAX_ITEMS } from '../src/logic/busyQueue.ts'
import { createSessionStore } from '../src/logic/store.ts'
import { App } from '../src/view/App.tsx'
import { ThemeProvider } from '../src/view/theme.tsx'

installFfiCoordSafety()

const lib = resolveRenderLib()
const EDIT_SAMPLES = 20

const forceGc = (): void => {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) throw new Error('queue-bench requires node --expose-gc')
  // External ArrayBuffer backing stores can require a second major collection
  // after wrapper finalization. Three synchronous passes keep samples focused
  // on retained memory instead of pending finalizer noise.
  gc()
  gc()
  gc()
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10

function descendantCount(node: Renderable): number {
  let count = 0
  for (const child of node.getChildren()) count += 1 + descendantCount(child)
  return count
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0
}

interface Sample {
  readonly activeAllocations: number
  readonly arrayBuffersMb: number
  readonly externalMb: number
  readonly heapUsedMb: number
  readonly renderables: number
  readonly rssMb: number
}

function sample(root: Renderable): Sample {
  forceGc()
  const memory = process.memoryUsage()
  return {
    activeAllocations: lib.getAllocatorStats().activeAllocations,
    arrayBuffersMb: mb(memory.arrayBuffers),
    externalMb: mb(memory.external),
    heapUsedMb: mb(memory.heapUsed),
    renderables: descendantCount(root),
    rssMb: mb(memory.rss)
  }
}

async function main(): Promise<void> {
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  for (let index = 0; index < 3; index += 1) {
    if (!store.enqueuePrompt(`short queue row ${index}`)) throw new Error('failed to seed three-row queue')
  }

  function Root() {
    const renderer = useRenderer()
    const keymap = createMemo(() => createDefaultOpenTuiKeymap(renderer))
    return (
      <KeymapProvider keymap={keymap()}>
        <ThemeProvider theme={() => store.state.theme}>
          <App store={store} />
        </ThemeProvider>
      </KeymapProvider>
    )
  }

  const setup = await testRender(() => <Root />, {
    width: 100,
    height: 40,
    exitOnCtrlC: false,
    kittyKeyboard: true
  })
  const settle = async (): Promise<void> => {
    await setup.renderOnce()
    await setup.flush()
    await setup.renderOnce()
    await setup.flush()
  }

  try {
    await settle()
    const threeRows = sample(setup.renderer.root)

    const hundredStarted = performance.now()
    for (let index = 3; index < BUSY_QUEUE_MAX_ITEMS; index += 1) {
      if (!store.enqueuePrompt(`short queue row ${index}`)) throw new Error(`failed to seed queue row ${index}`)
    }
    await settle()
    const hundredElapsedMs = performance.now() - hundredStarted
    const hundredRows = sample(setup.renderer.root)

    store.clearQueue()
    let nearLimitBody = 'α'.repeat(BUSY_QUEUE_MAX_CHARS - 1)
    const nearLimitCodeUnits = nearLimitBody.length
    if (!store.enqueuePrompt(nearLimitBody)) throw new Error('failed to seed near-limit body')
    const nearLimitStarted = performance.now()
    setup.mockInput.pressArrow('up')
    await settle()
    const nearLimitSelectMs = performance.now() - nearLimitStarted
    const nearLimit = sample(setup.renderer.root)

    store.clearQueue()
    // Do not let the benchmark's own local retain the large fixture while the
    // independent edit-cycle sample is taken.
    nearLimitBody = ''
    const editableBody = 'β'.repeat(BUSY_QUEUE_MAX_EDIT_CHARS)
    if (!store.enqueuePrompt(editableBody)) throw new Error('failed to seed editable body')
    const editDurations: number[] = []
    for (let index = 0; index < EDIT_SAMPLES; index += 1) {
      if (index > 0) {
        setup.mockInput.pressEscape()
        await settle()
      }
      const started = performance.now()
      setup.mockInput.pressArrow('up')
      await settle()
      editDurations.push(performance.now() - started)
    }
    const editable = sample(setup.renderer.root)

    const report = {
      config: {
        editCodeUnits: BUSY_QUEUE_MAX_EDIT_CHARS,
        editSamples: EDIT_SAMPLES,
        maxCodeUnits: BUSY_QUEUE_MAX_CHARS,
        maxItems: BUSY_QUEUE_MAX_ITEMS
      },
      editLatencyMs: {
        median: Number(percentile(editDurations, 0.5).toFixed(3)),
        p95: Number(percentile(editDurations, 0.95).toFixed(3)),
        sample: editable
      },
      nearLimit: {
        codeUnits: nearLimitCodeUnits,
        sample: nearLimit,
        selectMs: Number(nearLimitSelectMs.toFixed(3))
      },
      queue: {
        hundredRows,
        hundredRowsMountMs: Number(hundredElapsedMs.toFixed(3)),
        nativeAllocationGrowth: hundredRows.activeAllocations - threeRows.activeAllocations,
        renderableGrowth: hundredRows.renderables - threeRows.renderables,
        threeRows
      }
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    setup.renderer.destroy()
  }
}

await main()
