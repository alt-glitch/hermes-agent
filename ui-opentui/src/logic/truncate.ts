/**
 * One-line string truncation helpers shared by the chrome views (status bar,
 * agents dashboard, background panel) — keep them here so the ellipsis rule
 * doesn't drift between copies.
 */

import stringWidth from 'string-width'

/** Keep the HEAD of a string, suffixing `…` when it must clip (e.g. a goal/command row). */
export function truncRight(s: string, max: number): string {
  if (max <= 1) return s.length > max ? '…' : s
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/** Keep the HEAD within a terminal-cell budget, preserving grapheme clusters. */
export function truncRightCells(s: string, max: number): string {
  if (max <= 0) return ''
  if (stringWidth(s) <= max) return s
  if (max === 1) return '…'

  let clipped = ''
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)
  for (const { segment } of segments) {
    if (stringWidth(clipped + segment + '…') > max) break
    clipped += segment
  }
  return clipped + '…'
}

/** Keep the TAIL of a string, prefixing `…` when it must clip (e.g. a deep cwd path). */
export function truncLeft(s: string, max: number): string {
  if (max <= 1) return s.length > max ? '…' : s
  return s.length <= max ? s : '…' + s.slice(s.length - max + 1)
}
