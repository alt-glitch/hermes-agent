import { decodeSystemBatteryResponse } from '../boundary/schema/SessionCommandResponses.ts'

export type BatteryCategory = 'bad' | 'critical' | 'dim' | 'good' | 'warn'

export interface BatteryInfo {
  readonly available: boolean
  readonly category: BatteryCategory
  readonly percent: number | null
  readonly plugged: boolean | null
}

export interface BatteryPoller {
  readonly dispose: () => void
  readonly enabled: () => boolean
  readonly setEnabled: (enabled: boolean) => void
}

const CATEGORIES: ReadonlySet<BatteryCategory> = new Set(['bad', 'critical', 'dim', 'good', 'warn'])

function categoryFrom(raw: string | undefined): BatteryCategory {
  return raw && CATEGORIES.has(raw as BatteryCategory) ? (raw as BatteryCategory) : 'dim'
}

export function batteryInfoFromResponse(raw: unknown): BatteryInfo | null {
  const response = decodeSystemBatteryResponse(raw)
  if (!response) return null
  const percent =
    typeof response.percent === 'number' && Number.isFinite(response.percent)
      ? Math.max(0, Math.min(100, Math.round(response.percent)))
      : null
  return {
    available: response.available,
    category: categoryFrom(response.category),
    percent,
    plugged: typeof response.plugged === 'boolean' ? response.plugged : null
  }
}

/** Compact status-bar label. An available battery with an unknown charge keeps
 * its stable chip width and reports `--` rather than leaking `null`. */
export function batteryLabel(info: BatteryInfo): string {
  return `${info.plugged === true ? '⚡' : '🔋'} ${info.percent ?? '--'}%`
}

export function batteryEnabledFromConfig(config: Record<string, unknown>): boolean {
  const rawDisplay = config.display
  if (typeof rawDisplay !== 'object' || rawDisplay === null) return false
  const raw = (rawDisplay as Record<string, unknown>).battery
  return raw === true || (typeof raw === 'string' && ['1', 'on', 'true', 'yes'].includes(raw.trim().toLowerCase()))
}

/** One leak-free 30s poller, armed only while the indicator is enabled.
 * Transient failures retain the last good reading. Generation fencing prevents
 * a late result from repainting after disable (or after a fast off/on cycle). */
export function createBatteryPoller(options: {
  readonly apply: (reading: BatteryInfo | null) => void
  readonly intervalMs?: number
  readonly request: () => Promise<unknown>
}): BatteryPoller {
  const intervalMs = options.intervalMs ?? 30_000
  let active = false
  let generation = 0
  let interval: ReturnType<typeof setInterval> | undefined
  let inFlightGeneration: number | undefined

  const clearTimer = () => {
    if (interval !== undefined) clearInterval(interval)
    interval = undefined
  }

  const poll = async (epoch: number): Promise<void> => {
    if (!active || epoch !== generation || inFlightGeneration === epoch) return
    inFlightGeneration = epoch
    try {
      const reading = batteryInfoFromResponse(await options.request())
      if (epoch === generation) options.apply(reading)
    } catch {
      // Keep the last-good reading on a transient RPC failure.
    } finally {
      if (inFlightGeneration === epoch) inFlightGeneration = undefined
    }
  }

  return {
    dispose() {
      active = false
      generation += 1
      clearTimer()
    },

    enabled: () => active,

    setEnabled(enabled) {
      if (active === enabled) return
      active = enabled
      generation += 1
      clearTimer()
      if (!enabled) {
        options.apply(null)
        return
      }

      const epoch = generation
      void poll(epoch)
      interval = setInterval(() => void poll(epoch), intervalMs)
      interval.unref()
    }
  }
}
