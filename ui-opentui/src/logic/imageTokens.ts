/**
 * Inline image tokens (`[Image #N]`) mark WHERE an attached image sits in the
 * composer; the gateway already holds the file in `session.attached_images`
 * and splices the vision content in at submit. Like Ink's `expandTokens`
 * (ui-tui/src/domain/attachments.ts), the model-facing text drops each live
 * token plus one adjacent leading space/tab so no gap is left mid-sentence,
 * then trims. Only tokens of currently attached images are removed: a literal
 * `[Image #3]` the user typed without an attachment is ordinary text.
 */
export function stripImageTokens(text: string, tokens: readonly string[]): string {
  if (tokens.length === 0) return text
  const live = new Set(tokens)
  return text.replace(/[ \t]?\[Image #\d+\]/g, match => (live.has(match.trimStart()) ? '' : match)).trim()
}
