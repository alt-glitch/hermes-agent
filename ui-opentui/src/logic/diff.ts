/**
 * Pure unified-diff helpers for the file-tool renderer (Epic 2.3). No
 * OpenTUI/Solid imports — just string work, trivially unit-testable (like
 * `toolOutput.ts`). The gateway ships the FULL raw unified diff on file-edit
 * `tool.complete` (`diff_unified`); these helpers turn it into the collapsed
 * `+N −M` summary and per-file sections for the native `<diff>` renderable
 * (which parses only the FIRST file of a multi-file diff — so we split).
 *
 * Robustness to HUNK-LESS sections (V4A patches): some emitters ship a valid
 * file diff with `--- /+++ ` headers and `+`/`-` body lines but NO `@@` hunk
 * header — notably Hermes' V4A (`mode='patch'`) add-file path, which hand-builds
 * `--- /dev/null\n+++ b/<path>\n+line…` with no `@@`. The native DiffRenderable
 * needs a `@@ -a,b +c,d @@` header to parse (regex-gated), so `splitUnifiedDiff`
 * keeps such sections AND synthesizes the missing hunk header from the body's
 * `+`/`-`/` ` line counts (`synthesizeHunkHeader`). Sections with neither a
 * header pair nor an `@@` (prose, comment-only `# Moved:` diffs) are still
 * dropped — there's nothing for the native renderer to show.
 */

/** Added/removed line counts for the collapsed header summary (`+N −M`). */
export interface DiffStats {
  added: number
  removed: number
}

/** Count changed lines in a unified diff, excluding the `+++`/`---` file headers. */
export function diffStats(diff: string): DiffStats {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

/**
 * Path relative to the session cwd: exact prefix strip only (no `~` for home —
 * deliberately simple). Paths outside cwd come back unchanged; the cwd itself
 * becomes `.`. A trailing slash on cwd is tolerated.
 */
export function relativizePath(path: string, cwd?: string): string {
  if (!path || !cwd) return path
  const base = cwd.endsWith('/') && cwd !== '/' ? cwd.slice(0, -1) : cwd
  if (path === base) return '.'
  const prefix = base === '/' ? '/' : base + '/'
  if (path.startsWith(prefix)) return path.slice(prefix.length) || '.'
  return path
}

/** One file's section of a (possibly multi-file) unified diff. */
export interface DiffFileSection {
  /** Target path from the `+++ b/…` header (or `--- a/…` for deletions); '' if unknown. */
  path: string
  /** The section's unified diff text, parseable on its own. */
  diff: string
}

/** Extract the path from a `--- a/x` / `+++ b/x` header line ('' for /dev/null). */
function headerPath(line: string): string {
  let p = line.slice(4).trim()
  const tab = p.indexOf('\t') // difflib may append a date after a tab
  if (tab !== -1) p = p.slice(0, tab)
  if (!p || p === '/dev/null') return ''
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2)
  return p
}

function sectionPath(lines: string[]): string {
  const to = lines.find(l => l.startsWith('+++ '))
  const from = lines.find(l => l.startsWith('--- '))
  return (to ? headerPath(to) : '') || (from ? headerPath(from) : '')
}

/** Whether a section is a real, renderable file diff: a `--- `/`+++ ` header
 *  pair (covers a hunk-less V4A add/replace section) OR an `@@` hunk (covers a
 *  bodyless/odd diff that at least declares a hunk). A comment-only or prose
 *  section (e.g. `# Moved: a -> b`) has neither and is dropped. */
function isRenderableSection(lines: string[]): boolean {
  const hasHeaderPair = lines.some(l => l.startsWith('--- ')) && lines.some(l => l.startsWith('+++ '))
  return hasHeaderPair || lines.some(l => l.startsWith('@@'))
}

/**
 * Ensure a section has a `@@` hunk header the native DiffRenderable can parse.
 * Already-hunked sections pass through untouched. For a hunk-LESS section (a
 * `--- /+++ ` header pair with `+`/`-`/` ` body lines but no `@@`) we count the
 * body lines and inject a single synthesized `@@ -<oldStart>,<oldLines> +1,<newLines> @@`
 * right after the `+++ ` header. oldStart is 0 for an add (`--- /dev/null`),
 * else 1; new content starts at line 1. Body line ORDER is preserved (the
 * renderable colors by `+`/`-`/` ` prefix, not by the counts).
 */
function withHunkHeader(lines: string[]): string[] {
  if (lines.some(l => l.startsWith('@@'))) return lines
  const plusIdx = lines.findIndex(l => l.startsWith('+++ '))
  if (plusIdx === -1) return lines // no header pair — nothing to anchor a hunk to
  let oldLines = 0
  let newLines = 0
  for (const l of lines) {
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) newLines++
    else if (l.startsWith('-')) oldLines++
    else if (l.startsWith(' ')) {
      oldLines++
      newLines++
    }
  }
  if (oldLines === 0 && newLines === 0) return lines // bodyless — leave as-is (will be dropped if no @@)
  const isAdd = lines.some(l => l.startsWith('--- ') && headerPath(l) === '')
  const oldStart = isAdd || oldLines === 0 ? 0 : 1
  const header = `@@ -${oldStart},${oldLines} +1,${newLines} @@`
  return [...lines.slice(0, plusIdx + 1), header, ...lines.slice(plusIdx + 1)]
}

/**
 * Split a unified diff into per-file sections (the gateway concatenates one
 * difflib diff per edited file; `patch`-mode diffs can also be multi-file). A
 * new section starts at a `--- ` header that is FOLLOWED by `+++ ` and comes
 * after the current section already opened its own header pair — so a removed
 * line that merely starts with `--` (or a content `--- ` inside a hunk) can't
 * split a file in half. Hunk-less-but-valid sections are kept and given a
 * synthesized hunk header so the native renderable can paint them.
 */
export function splitUnifiedDiff(diff: string): DiffFileSection[] {
  const lines = diff.replace(/\n$/, '').split('\n')
  const sections: string[][] = []
  let current: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // A new file section begins at a `--- ` + `+++ ` header pair, but only once
    // the current section has already declared its OWN header pair (a `+++ `):
    // before that the `--- ` IS this section's header; a later `--- ` followed
    // by `+++ ` is the next file. This keeps both hunked and hunk-less sections
    // splitting correctly, and a content `--- ` line (no `+++ ` next) never splits.
    if (current.some(l => l.startsWith('+++ ')) && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sections.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) sections.push(current)
  return sections
    .filter(isRenderableSection)
    .map(s => withHunkHeader(s))
    .map(s => ({ diff: s.join('\n'), path: sectionPath(s) }))
}
