/**
 * Unit tests for the pure diff helpers (Epic 2.3 — logic/diff.ts): `+N −M`
 * counting (file headers excluded, trailing newline optional), cwd-relative
 * paths (exact prefix strip only — no `~`), and per-file splitting of
 * multi-file unified diffs (the native DiffRenderable parses only the first
 * file, so the renderer feeds it one section at a time).
 */
import { describe, expect, test } from 'vitest'

import { diffStats, relativizePath, splitUnifiedDiff } from '../logic/diff.ts'

const ONE_FILE = ['--- a/src/main.ts', '+++ b/src/main.ts', '@@ -1,3 +1,4 @@', ' ctx', '-old', '+new', '+more'].join(
  '\n'
)

describe('diffStats', () => {
  test('counts added/removed lines, excluding the +++/--- file headers', () => {
    expect(diffStats(ONE_FILE + '\n')).toEqual({ added: 2, removed: 1 })
  })

  test('handles a diff without a trailing newline', () => {
    expect(diffStats(ONE_FILE)).toEqual({ added: 2, removed: 1 })
  })

  test('a multi-file diff counts headers of every file out', () => {
    const diff = `${ONE_FILE}\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-x\n+y\n`
    expect(diffStats(diff)).toEqual({ added: 3, removed: 2 })
  })

  test('empty diff → zero stats', () => {
    expect(diffStats('')).toEqual({ added: 0, removed: 0 })
  })
})

describe('relativizePath', () => {
  test.each([
    // inside cwd → relative
    ['/home/u/proj/src/main.ts', '/home/u/proj', 'src/main.ts'],
    // outside cwd → unchanged
    ['/etc/hosts', '/home/u/proj', '/etc/hosts'],
    // exactly the cwd → '.'
    ['/home/u/proj', '/home/u/proj', '.'],
    // trailing slash on cwd tolerated
    ['/home/u/proj/a.txt', '/home/u/proj/', 'a.txt'],
    // sibling dir sharing the prefix string is NOT inside cwd
    ['/home/u/proj2/a.txt', '/home/u/proj', '/home/u/proj2/a.txt'],
    // no cwd → unchanged (and already-relative paths pass through)
    ['src/main.ts', undefined, 'src/main.ts']
  ])('%s relative to %s → %s', (path, cwd, expected) => {
    expect(relativizePath(path, cwd)).toBe(expected)
  })
})

describe('splitUnifiedDiff', () => {
  test('single-file diff → one section with the b/ path stripped', () => {
    const sections = splitUnifiedDiff(ONE_FILE + '\n')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.path).toBe('src/main.ts')
    expect(sections[0]?.diff).toBe(ONE_FILE)
  })

  test('multi-file diff splits at the next ---/+++ header pair', () => {
    const second = ['--- a/b.py', '+++ b/b.py', '@@ -1 +1 @@', '-x', '+y'].join('\n')
    const sections = splitUnifiedDiff(`${ONE_FILE}\n${second}\n`)
    expect(sections.map(s => s.path)).toEqual(['src/main.ts', 'b.py'])
    expect(sections[1]?.diff).toBe(second)
  })

  test('a removed line starting with --- does not split the file', () => {
    const tricky = ['--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,1 @@', '--- a heading rule', ' kept'].join('\n')
    const sections = splitUnifiedDiff(tricky)
    expect(sections).toHaveLength(1)
  })

  test('new-file diff (--- /dev/null) takes the +++ path', () => {
    const created = ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+hello'].join('\n')
    expect(splitUnifiedDiff(created)[0]?.path).toBe('new.txt')
  })

  // ── V4A hunk-less diffs (the bug this PR fixes) ─────────────────────────
  // Hermes' V4A (mode='patch') add-file path hand-builds a diff with a
  // `--- /dev/null` / `+++ b/<path>` header pair and `+` body lines but NO `@@`
  // hunk header. The native DiffRenderable regex-requires `@@ -a,b +c,d @@`, so
  // pre-fix these sections were DROPPED and the tool card fell back to raw
  // params. Now they're kept with a synthesized hunk header.
  test('V4A add-file diff with NO @@ header is kept + gets a synthesized hunk', () => {
    const v4aAdd = ['--- /dev/null', '+++ b/notes.md', '+# Title', '+', '+Body line'].join('\n')
    const sections = splitUnifiedDiff(v4aAdd)
    expect(sections).toHaveLength(1)
    expect(sections[0]?.path).toBe('notes.md')
    // a parseable hunk header was injected after the +++ line (add → -0,0)
    expect(sections[0]?.diff).toContain('@@ -0,0 +1,3 @@')
    // the native renderer's hunk regex must match the synthesized header
    expect(sections[0]?.diff).toMatch(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    // body lines preserved in order, after the header
    const lines = sections[0]!.diff.split('\n')
    expect(lines.slice(-3)).toEqual(['+# Title', '+', '+Body line'])
  })

  test('V4A hunk-less MODIFY diff (--- a / +++ b, +/- body) is kept + synthesized', () => {
    const v4aMod = ['--- a/x.ts', '+++ b/x.ts', ' kept', '-old', '+new'].join('\n')
    const sections = splitUnifiedDiff(v4aMod)
    expect(sections).toHaveLength(1)
    expect(sections[0]?.path).toBe('x.ts')
    // 1 context + 1 removed = 2 old lines (from 1); 1 context + 1 added = 2 new lines
    expect(sections[0]?.diff).toContain('@@ -1,2 +1,2 @@')
  })

  test('a comment-only section (# Moved: a -> b) with no header pair is dropped', () => {
    // V4A move emits a `# Moved:` line — nothing for the native renderer to show.
    const moved = '# Moved: old/x.ts -> new/x.ts'
    expect(splitUnifiedDiff(moved)).toEqual([])
  })

  test('a hunked file + a hunk-less add-file in one diff: both kept, both parseable', () => {
    const mix = `${ONE_FILE}\n--- /dev/null\n+++ b/created.txt\n+line one\n+line two`
    const sections = splitUnifiedDiff(mix)
    expect(sections.map(s => s.path)).toEqual(['src/main.ts', 'created.txt'])
    // the pre-hunked file is untouched; the add-file got a synthesized header
    expect(sections[0]?.diff).toBe(ONE_FILE)
    expect(sections[1]?.diff).toContain('@@ -0,0 +1,2 @@')
    sections.forEach(s => expect(s.diff).toMatch(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/))
  })
})
