/**
 * DEV BENCH — large `/history` pager open/close resource proof.
 *
 * Seeds the production store with the SAME realistic 3,000-message fixture as
 * mem-bench (markdown, code, reasoning, and tool-heavy turns), then formats and
 * opens the bounded `/history` pager repeatedly. Records formatter time/size,
 * public native allocator counts, recursive renderables, retained JS/RSS, and
 * mount/remount latency. Closing the pager remounts the real windowed transcript
 * and waits for public CodeRenderable highlighting promises before sampling.
 *
 *   node scripts/build.mjs scripts/pager-bench.tsx .bench
 *   node --experimental-ffi --expose-gc --no-warnings .bench/pager-bench.js
 *
 * Knobs: PAGER_BENCH_MESSAGES (default 3000), PAGER_BENCH_CYCLES (default 3).
 */
import { CodeRenderable, type Renderable, resolveRenderLib } from '@opentui/core'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { KeymapProvider } from '@opentui/keymap/solid'
import { testRender, useRenderer } from '@opentui/solid'
import { createMemo } from 'solid-js'

import { installFfiCoordSafety } from '../src/boundary/ffiSafe.ts'
import { formatHistory } from '../src/logic/slash.ts'
import { createSessionStore } from '../src/logic/store.ts'
import { App } from '../src/view/App.tsx'
import { ThemeProvider } from '../src/view/theme.tsx'
import { materialize } from './fixture.ts'

installFfiCoordSafety()

const MESSAGE_COUNT = Math.max(1, Number.parseInt(process.env.PAGER_BENCH_MESSAGES ?? '3000', 10) || 3000)
const CYCLES = Math.max(1, Number.parseInt(process.env.PAGER_BENCH_CYCLES ?? '3', 10) || 3)
const lib = resolveRenderLib()

function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) throw new Error('pager-bench requires node --expose-gc')
  gc()
}

function descendantCount(node: Renderable): number {
  let count = 0
  for (const child of node.getChildren()) count += 1 + descendantCount(child)
  return count
}

function codeRenderables(node: Renderable, found: CodeRenderable[] = []): CodeRenderable[] {
  if (node instanceof CodeRenderable) found.push(node)
  for (const child of node.getChildren()) codeRenderables(child, found)
  return found
}

interface HighlightSettlement {
  readonly complete: boolean
  readonly elapsedMs: number
  readonly pending: number
}

async function settleHighlights(root: Renderable, timeoutMs = 1_000): Promise<HighlightSettlement> {
  const started = performance.now()
  const deadline = started + timeoutMs
  for (;;) {
    const pending = codeRenderables(root).filter(code => code.isHighlighting)
    if (pending.length === 0) return { complete: true, elapsedMs: performance.now() - started, pending: 0 }
    const remaining = deadline - performance.now()
    if (remaining <= 0) return { complete: false, elapsedMs: performance.now() - started, pending: pending.length }

    let timer: ReturnType<typeof setTimeout> | undefined
    const completed = await Promise.race([
      Promise.allSettled(pending.map(code => code.highlightingDone)).then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), remaining)
      })
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (!completed) {
      const stillPending = codeRenderables(root).filter(code => code.isHighlighting).length
      return { complete: false, elapsedMs: performance.now() - started, pending: stillPending }
    }
  }
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10

async function main(): Promise<void> {
  // Materialize before native renderer creation so throwaway fixture-store
  // proxies can be collected and never contaminate the pager samples.
  let fixture = materialize(MESSAGE_COUNT)
  const fixtureCount = fixture.length
  forceGc()
  const store = createSessionStore()
  store.apply({ type: 'gateway.ready' })
  store.commitSessionSnapshot('pager-bench', fixture, { model: 'fixture-model' }, () => true)
  fixture = []
  forceGc()

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

  const setup = await testRender(() => <Root />, { width: 100, height: 40, exitOnCtrlC: false })
  const settle = async () => {
    await setup.renderOnce()
    await setup.flush()
    await setup.renderOnce()
    await setup.flush()
  }

  const sample = (
    stage: string,
    cycle: number,
    elapsedMs: number,
    extra: {
      readonly formatMs?: number
      readonly highlightComplete?: boolean
      readonly highlightMs?: number
      readonly historyChars?: number
    } = {}
  ) => {
    forceGc()
    const memory = process.memoryUsage()
    return {
      active_allocations: lib.getAllocatorStats().activeAllocations,
      cycle,
      elapsed_ms: Math.round(elapsedMs * 100) / 100,
      format_ms: extra.formatMs === undefined ? undefined : Math.round(extra.formatMs * 100) / 100,
      heap_used_mb: mb(memory.heapUsed),
      highlight_complete: extra.highlightComplete,
      highlight_ms: extra.highlightMs === undefined ? undefined : Math.round(extra.highlightMs * 100) / 100,
      history_chars: extra.historyChars,
      renderables: descendantCount(setup.renderer.root),
      rss_mb: mb(memory.rss),
      stage
    }
  }

  try {
    await settle()
    const baselineHighlight = await settleHighlights(setup.renderer.root)
    if (!baselineHighlight.complete) {
      throw new Error(`baseline highlighting timed out (${baselineHighlight.pending} pending)`)
    }
    await settle()
    const results = [
      sample('baseline', 0, 0, {
        highlightComplete: baselineHighlight.complete,
        highlightMs: baselineHighlight.elapsedMs
      })
    ]
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const formatStarted = performance.now()
      let history: string | null = formatHistory(store.state.messages, '') ?? null
      const formatMs = performance.now() - formatStarted
      if (!history) throw new Error('realistic fixture produced no conversation history')
      const started = performance.now()
      store.openPager('History', history)
      await settle()
      results.push(
        sample('open', cycle, performance.now() - started, {
          formatMs,
          historyChars: history.length
        })
      )

      const closeStarted = performance.now()
      store.closePager()
      history = null
      await settle()
      const closeHighlight = await settleHighlights(setup.renderer.root)
      if (!closeHighlight.complete) {
        throw new Error(`close highlighting timed out (${closeHighlight.pending} pending)`)
      }
      await settle()
      results.push(
        sample('closed', cycle, performance.now() - closeStarted, {
          highlightComplete: closeHighlight.complete,
          highlightMs: closeHighlight.elapsedMs
        })
      )
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          cycles: CYCLES,
          fixture_messages: fixtureCount,
          messages: MESSAGE_COUNT,
          node: process.version,
          retained_messages: store.state.messages.length,
          results
        },
        null,
        2
      )}\n`
    )
  } finally {
    setup.renderer.destroy()
  }
}

await main()
