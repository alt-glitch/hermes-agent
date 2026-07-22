/**
 * Chart primitives — pure string builders, THE charting layer for widget
 * apps. A 1:1 port of `ui-tui/src/lib/charts.ts` (the shared widget sdk
 * exposes the same functions on both engines). Everything returns plain
 * strings the caller colors with theme tones; everything auto-scales to the
 * series' min/max and pads to a stable width so cards never resize.
 */

const BLOCKS = '▁▂▃▄▅▆▇█'

const normalize = (series: number[], window: number): { min: number; range: number; window: number[] } => {
  const view = series.slice(-Math.max(1, window))
  const min = Math.min(...view)
  return { min, range: Math.max(...view) - min || 1, window: view }
}

/** One-row sparkline: `▂▃▅▇█▆…`, last `width` samples, always exactly
 *  `width` cells (short series pad-left). */
export function sparkline(series: number[], width = series.length): string {
  if (!series.length) return ' '.repeat(Math.max(0, width))
  const { min, range, window } = normalize(series, width)
  return window
    .map(v => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(((v - min) / range) * BLOCKS.length))])
    .join('')
    .padStart(width)
}

/** Multi-row column chart, top line first. Each column resolves to
 *  `rows * 8` vertical levels (partial eighth-blocks at the value). */
export function sparkRows(series: number[], width: number, rows: number): string[] {
  if (!series.length) return Array.from({ length: rows }, () => ' '.repeat(width))
  const { min, range, window } = normalize(series, width)
  const levels = window.map(v => Math.max(1, Math.round(((v - min) / range) * rows * 8)))
  return Array.from({ length: rows }, (_, lineIdx) => {
    const rowFromBottom = rows - 1 - lineIdx
    return levels
      .map(level => {
        const filled = Math.min(8, Math.max(0, level - rowFromBottom * 8))
        return filled === 0 ? ' ' : BLOCKS[filled - 1]
      })
      .join('')
      .padStart(width)
  })
}

/** Horizontal fill gauge: `█████░░░` for a 0..1 ratio. */
export function gauge(ratio: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

/** Horizontal bar chart: one `███▌`-style bar per value, scaled to the max,
 *  each padded to exactly `width` (stable card sizing). */
export function hbars(values: number[], width: number): string[] {
  const max = Math.max(...values, 0) || 1
  return values.map(v => {
    const cells = (Math.min(max, Math.max(0, v)) / max) * width
    const full = Math.floor(cells)
    const rest = Math.round((cells - full) * 8)
    return ('█'.repeat(full) + (rest > 0 ? '▏▎▍▌▋▊▉█'[rest - 1] : '')).padEnd(width)
  })
}
