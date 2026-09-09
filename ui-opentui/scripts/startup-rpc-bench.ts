/**
 * Measure the post-session RPC chain against the real Python gateway.
 *
 * This is intentionally renderer-free: termctrl measurements own visible paint
 * and terminal restoration, while this probe identifies which local RPC stage
 * delays initial-prompt readiness. Run it only with an isolated HERMES_HOME and
 * a credential-free custom provider.
 *
 * Build and run from ui-opentui:
 *   node scripts/build.mjs scripts/startup-rpc-bench.ts dist/startup-rpc-bench
 *   node --no-warnings dist/startup-rpc-bench/startup-rpc-bench.js
 *
 * Set HERMES_LATENCY_RPC_MODE=parallel to measure the independent requests
 * concurrently. The default `serial` mode matches the production baseline.
 */
import { Effect, ManagedRuntime } from 'effect'
import { performance } from 'node:perf_hooks'

import { GatewayService, type GatewayTransport } from '../src/boundary/gateway/GatewayService.ts'
import { liveGatewayLayer } from '../src/boundary/gateway/liveGateway.ts'

const READY_TIMEOUT_MS = 20_000

interface Stage<A> {
  readonly endMs: number
  readonly method: string
  readonly startMs: number
  readonly value: A
}

function timedRequest<A>(
  gateway: GatewayTransport,
  method: string,
  params: unknown,
  origin: number
): Effect.Effect<Stage<A>, unknown> {
  return Effect.gen(function* () {
    const startMs = performance.now() - origin
    const value = yield* gateway.request<A>(method, params)
    return { endMs: performance.now() - origin, method, startMs, value }
  })
}

async function main(): Promise<void> {
  const mode = process.env.HERMES_LATENCY_RPC_MODE === 'parallel' ? 'parallel' : 'serial'
  const origin = performance.now()
  const runtime = ManagedRuntime.make(liveGatewayLayer)
  let readyAtMs: number | undefined
  let resolveReady: (() => void) | undefined
  const ready = new Promise<void>(resolve => {
    resolveReady = resolve
  })

  const program = Effect.gen(function* () {
    const gateway = yield* GatewayService
    yield* gateway.subscribe(event => {
      if (event.type !== 'gateway.ready' || readyAtMs !== undefined) return
      readyAtMs = performance.now() - origin
      resolveReady?.()
    })
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('gateway.ready timeout')), READY_TIMEOUT_MS)
          void ready.then(() => {
            clearTimeout(timer)
            resolve()
          })
        }),
      catch: cause => cause
    })

    const session = yield* timedRequest<{
      readonly session_id: string
      readonly stored_session_id?: string
    }>(gateway, 'session.create', { cols: 120, cwd: process.env.HERMES_CWD }, origin)
    const sid = session.value.session_id
    let modelOptionsEndMs: number | undefined
    const modelOptionsStartMs = performance.now() - origin
    const modelOptions = Effect.runPromise(gateway.request('model.options', { session_id: sid }))
      .then(() => {
        modelOptionsEndMs = performance.now() - origin
      })
      .catch(() => {
        modelOptionsEndMs = performance.now() - origin
      })

    const requests = {
      catalog: timedRequest<unknown>(gateway, 'startup.catalog', { session_id: sid }, origin),
      commands: timedRequest<unknown>(gateway, 'commands.catalog', {}, origin),
      config: timedRequest<unknown>(gateway, 'config.get', { key: 'full' }, origin)
    }
    const stages =
      mode === 'parallel'
        ? yield* Effect.all(requests, { concurrency: 3 })
        : {
            catalog: yield* requests.catalog,
            commands: yield* requests.commands,
            config: yield* requests.config
          }
    const chainEndMs = performance.now() - origin
    yield* gateway.request('session.close', { session_id: sid })
    yield* Effect.promise(() => modelOptions)

    return {
      chainEndMs,
      mode,
      modelOptionsEndMs,
      modelOptionsStartMs,
      readyAtMs,
      session: {
        endMs: session.endMs,
        startMs: session.startMs,
        storedSessionId: session.value.stored_session_id
      },
      stages: {
        catalog: { endMs: stages.catalog.endMs, startMs: stages.catalog.startMs },
        commands: { endMs: stages.commands.endMs, startMs: stages.commands.startMs },
        config: { endMs: stages.config.endMs, startMs: stages.config.startMs }
      }
    }
  })

  let result: unknown
  try {
    result = await runtime.runPromise(program)
  } finally {
    const disposeStartMs = performance.now() - origin
    await runtime.dispose()
    const disposeEndMs = performance.now() - origin
    console.log(JSON.stringify({ disposeEndMs, disposeStartMs, result }))
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
