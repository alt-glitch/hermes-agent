# Upstream alignment — how we inherit OpenTUI's performance work for free

Context (maintainer, 2026-06-11): opencode's 100-message cap was a November-era
performance workaround, since obsoleted. Our current OpenTUI 0.4.1 pin ships
native Yoga (the earlier WASM ratchet is historical), while opencode still does
not use virtualization.

## The invariant that makes alignment free

**We are dependency-forkless, and windowing is public-API-only.** The windowing
layer (S1+S2) drives the STOCK `<scrollbox>` through documented surface only —
`onSizeChange`, `setFrameCallback`, `scrollTop`/`viewport`/`scrollHeight`, Solid
`<Show>` mount/unmount. Zero patches to `@opentui/core`. Every upstream release
therefore drops in by bumping three pinned versions in `ui-opentui/package.json`
(`@opentui/{core,keymap,solid}`, currently 0.4.1). Keep it that way: any new
code that needs core behavior goes through a `boundary/` wrapper, never a
patched dependency. The compatibility shims in the ledger below do monkey-patch
exported prototypes or manipulate public frame buffers; they are isolated,
tested exceptions to the broader application rule, not dependency forks.

## What native Yoga changed for us (and what it didn't)

- **Killed the WASM ratchet** (grow-only linear memory → freeable native
  allocations). This retro-justifies S2 less, but S2's append-time windowing
  remains correct: transient mounted peaks still cost handles and RSS.
- **Does NOT obsolete windowing.** The binding constraint is the 65,535-slot
  native handle table: ~47 handles/row × 3,000 stored rows ≈ 141k handles —
  over the table at ANY layout speed. Windowing is what makes the 3,000-row
  scrollback possible; yoga's backend is irrelevant to that math.
- **Makes windowing feel even better**: 2× layout = cheaper margin remounts =
  smaller window margins viable and less exposure for the one accepted limit
  (estimate-height snap under scrollbar jumps). After the bump, re-tune margin/
  hysteresis against the scroll cell.

## The shim ledger (delete-on-upstream-fix; all in `ui-opentui/src/boundary/`)

| shim                                  | what it papers over                                                                                                                                                                                  | delete when                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ffiSafe.ts`                          | u32 draw coords go negative under Node FFI (Bun silently wraps) — ERR_INVALID_ARG_VALUE loop                                                                                                         | upstream clamps, or Node FFI path is officially supported                                      |
| `nativeHandles.ts`                    | SyntaxStyle exhaustion crashes mid-mount; degrade-to-unstyled                                                                                                                                        | handle table widened (INDEX_BITS>16) or per-kind tables                                        |
| `renderer.ts` lifecycle/repaint guard | core 0.4.1 treats SIGPIPE (clipboard spawn) as an exit signal; its uncaughtException handler can allocate during handle exhaustion; suspend/resume repaint can drop later bytes from one input chunk | signals/error handling fixed upstream and a public full-repaint primitive preserves the parser |
| `clipboard.ts` hardening              | same SIGPIPE incident class                                                                                                                                                                          | with the above                                                                                 |

Each is (a) isolated, (b) inert if upstream fixes the behavior, (c) worth
reporting upstream — four concrete, reproduced, root-caused issues. Filing them
is the cheapest alignment lever we have: it converts our workarounds into
upstream regression tests. (Needs glitch's go-ahead — public repo activity.)

## The upgrade playbook (per upstream release)

1. Branch `chore/opentui-X.Y.Z`, bump the three pins, `npm ci`.
2. `npm run check` (1,003 tests at the f7c9 parity baseline; the windowing
   invariants — identical scrollHeight ON/OFF and byte-stable frames across
   corrections — are literal assertions and will catch behavioral drift).
3. Bench acceptance, sequential: `--cell gate` (determinism digest; EXPECT a
   new digest if upstream changed rendering — eyeball the frame, re-bless),
   `--cell mem3000 --msgs 2000` + `--cell scroll --msgs 3000` against the
   versioned baseline for the current pin, then `--cell pipeline` (frame pacing
   ≥22fps). The often-cited 300–375MB / p99 6–8ms figures are historical
   pre-0.4.1 references, not the native-Yoga release gate; capture the 0.4.1
   baseline before the next bump.
4. Shim audit: try each boundary shim OFF; delete the ones upstream fixed.
5. Live tmux smoke (scroll sweep / resize / selection-copy), screenshots.
6. Windowing re-tune if layout got faster: margins up or hysteresis down,
   re-run scroll cell, keep p99 ≤ 17ms gate.

The bench suite IS the upgrade contract — it's exactly the harness that lets
us take every upstream improvement within a day of release, with proof.

## Questions worth relaying to the maintainer

1. Any plan to widen the 16-bit native handle table (or split per-kind)?
   That's our hard ceiling, independent of yoga.
2. Is the Node `--experimental-ffi` path on their support radar, or Bun-only?
   (Native yoga adds new FFI surface; we run Node.)
3. Would they take the windowing layer's core-agnostic pieces (exact-height
   spacer pattern, correction-legality rule) as a documented recipe or
   framework-level utility? We have it production-shaped with tests.
