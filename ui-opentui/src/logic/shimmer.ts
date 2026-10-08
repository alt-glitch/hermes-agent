/**
 * Shimmer skeleton band math (Ink `components/loaders.tsx` parity, 0ada7837e4).
 * A highlight band sweeps across a block run; rows offset their phase for a
 * diagonal shimmer. Pure — the view owns the clock and the theme tones.
 */

export const SHIMMER_BAND = 7
export const SHIMMER_TICK_MS = 90
/** Animation budget per mount: a catalog that never lands freezes the skeleton
 *  in place (still reads as loading) instead of repainting forever. */
export const SHIMMER_ANIMATE_MS = 30_000

/** Skeleton row shapes `[label cells, value cells]`, mirroring a typical
 *  toolsets listing. Three rows (Ink uses six): terminal rows are scarce and the
 *  home panel must not push the tagline/readiness warning out of short screens. */
export const SHIMMER_SKELETON_ROWS: ReadonlyArray<readonly [number, number]> = [
  [7, 30],
  [14, 12],
  [10, 13]
]

/** `[pre, band, post]` cell widths for a sweep at `phase`; the band enters from
 *  off-left and exits off-right, wrapping. */
export function shimmerSegments(width: number, phase: number, band = SHIMMER_BAND): [number, number, number] {
  const cycle = width + band
  const start = (((phase % cycle) + cycle) % cycle) - band
  const from = Math.max(0, start)
  const to = Math.min(width, start + band)
  return to <= from ? [width, 0, 0] : [from, to - from, width - to]
}
