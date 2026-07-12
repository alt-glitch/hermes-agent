import type { JourneyFrames } from '../boundary/schema/JourneyResponses.ts'
export type JourneyBucket = NonNullable<JourneyFrames['buckets']>[number]
export type JourneyNode = JourneyBucket['nodes'][number]
export type JourneyRow =
  | { kind: 'slice'; bucket: JourneyBucket }
  | { kind: 'node'; bucket: JourneyBucket; node: JourneyNode; last: boolean }
export function journeyRows(data: JourneyFrames | undefined): JourneyRow[] {
  const rows: JourneyRow[] = []
  for (const bucket of data?.buckets ?? []) {
    rows.push({ kind: 'slice', bucket })
    bucket.nodes.forEach((node, index) =>
      rows.push({ kind: 'node', bucket, node, last: index === bucket.nodes.length - 1 })
    )
  }
  return rows
}
export function journeyStep(rows: readonly JourneyRow[], from: number, delta: number): number {
  return Math.max(0, Math.min(Math.max(0, rows.length - 1), from + delta))
}
export function journeyWindowStart(cursor: number, length: number, height: number): number {
  return Math.max(0, Math.min(Math.max(0, length - height), cursor - Math.floor(height / 2)))
}
