/**
 * Markdown transforms — the pre-parse text pipeline (pi's `MarkdownTransformer`
 * shape). Each transform rewrites the markdown STRING before the native parser
 * sees it; the registry is a static ordered table (like `view/tools/registry`),
 * not a mutable registration surface — adding a transform is a one-line append.
 */
import { preprocessMath } from './mathPreprocess.ts'

export interface TransformContext {
  readonly streaming: boolean
}

export type MarkdownTransform = (markdown: string, context: TransformContext) => string

/** Tier-A LaTeX → unicode (see mathPreprocess.ts for the streaming semantics). */
const mathTransform: MarkdownTransform = (markdown, context) =>
  preprocessMath(markdown, { streaming: context.streaming })

/** Ordered pipeline — earlier transforms feed later ones. */
export const TRANSFORMS: readonly MarkdownTransform[] = [mathTransform]

export function applyTransforms(markdown: string, context: TransformContext): string {
  return TRANSFORMS.reduce((text, transform) => transform(text, context), markdown)
}
