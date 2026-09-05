// Bench-only live node-count sampler (dark by default). When
// HERMES_TUI_MEMSAMPLE_FD is set to a writable file descriptor, periodically
// walks the forked reconciler's root DOM tree and writes one NDJSON line per
// sample to that fd: {"t":<epoch ms>,"dom":<DOM nodes>,"yoga":<live Yoga nodes>}.
//
// Used by the tui-bench repo (the instrumented node-count runs — see
// docs/plans/opentui-bench-suite.md). RSS from instrumented runs is flagged and
// never headlined; this sampler exists ONLY as the mechanism witness for the
// transcript-growth claim. It writes to a dedicated fd (3 by convention), never
// stdout/stderr, so it cannot perturb the rendered frame stream.
//
// Failure policy: any error (bad fd, closed pipe) disables the sampler
// silently — production behavior must be identical with the env unset.

import { writeSync } from 'node:fs'

interface WalkableNode {
  childNodes?: WalkableNode[]
  yogaNode?: unknown
}

/** Count DOM nodes and nodes holding a live Yoga node under `root` (inclusive). */
export function countNodes(root: WalkableNode): { dom: number; yoga: number } {
  let dom = 0
  let yoga = 0
  const stack: WalkableNode[] = [root]

  while (stack.length > 0) {
    const node = stack.pop() as WalkableNode
    dom++

    if (node.yogaNode !== undefined && node.yogaNode !== null) {
      yoga++
    }

    const children = node.childNodes

    if (children) {
      for (let i = 0; i < children.length; i++) {
        stack.push(children[i] as WalkableNode)
      }
    }
  }

  return { dom, yoga }
}

/**
 * Start the env-gated sampler. Returns a stop function (no-op when the gate is
 * off). `intervalMs` falls back to HERMES_TUI_MEMSAMPLE_MS, then 1000.
 */
export function maybeStartMemSampler(root: WalkableNode, intervalMs?: number): () => void {
  const rawFd = process.env['HERMES_TUI_MEMSAMPLE_FD']

  if (!rawFd) {
    return () => {}
  }

  const fd = Number.parseInt(rawFd, 10)

  if (!Number.isInteger(fd) || fd < 0) {
    return () => {}
  }

  const rawMs = Number.parseInt(process.env['HERMES_TUI_MEMSAMPLE_MS'] ?? '', 10)
  const period = intervalMs ?? (Number.isFinite(rawMs) && rawMs > 0 ? rawMs : 1000)

  let disabled = false

  const tick = () => {
    if (disabled) {
      return
    }

    try {
      const counts = countNodes(root)

      writeSync(fd, `${JSON.stringify({ t: Date.now(), dom: counts.dom, yoga: counts.yoga })}\n`)
    } catch {
      // Bad/closed fd: go dark permanently rather than risk the render loop.
      disabled = true
      clearInterval(timer)
    }
  }

  const timer = setInterval(tick, period)

  // Never keep the process alive for the sampler.
  timer.unref?.()

  return () => {
    disabled = true
    clearInterval(timer)
  }
}
