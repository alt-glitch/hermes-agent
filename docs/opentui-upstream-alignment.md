# OpenTUI upstream alignment

Hermes consumes published OpenTUI packages without patching them. This document
defines how to compare a newer upstream with the runtime Hermes actually ships.
It is an upgrade and compatibility ledger, not the Ink-parity ledger; current
feature status remains in `docs/opentui-parity-matrix.md`.

## The contract in this checkout

`ui-opentui/package.json` and `package-lock.json` currently pin all three
OpenTUI packages exactly to `0.4.1`:

- `@opentui/core`
- `@opentui/keymap`
- `@opentui/solid`

The same manifest pins `effect@4.0.0-beta.78` and `solid-js@1.9.12`, and declares
Node `>=26.3`. The lockfile plus the declarations installed from it are the API
contract. A source checkout, a documentation mirror, or a successful example
against another installation cannot expand that contract.

The OpenTUI documentation reviewed on 2026-09-10 byte-matched upstream revision
`ac753b48d386707a931dcf881d0741905b64b4f9`. It describes a newer Node deployment
floor (`26.4.0`) and a composed clipboard surface (`createClipboard`,
`createHostClipboard`, `createRendererClipboardAdapter`) that are absent from the
installed `0.4.1` declarations. Do not import those APIs or raise Hermes' runtime
floor from documentation alone. By contrast, the installed declarations do
contain `createTestRenderer`, `waitForVisualIdle`, `getNativeStats`, the Keymap
host/test APIs, `TextTableRenderable`, and `TimeToFirstDrawRenderable`; each still
needs a candidate test before use.

## Why upstream improvements remain cheap to adopt

Transcript windowing drives stock OpenTUI and Solid surfaces: scrollbox geometry,
frame callbacks, and ordinary Solid mount/unmount behavior. Hermes does not carry
a modified `@opentui/core`, so an upgrade is a manifest-and-lock change followed
by compatibility verification. Keep OpenTUI-specific adaptations in
`ui-opentui/src/boundary/` and keep ordinary view and state code on public APIs.

"Unpatched dependency" does not mean "no compatibility code." The following
wrappers isolate reproduced differences in the installed Node FFI path:

| Boundary           | Current reason                                                                                                                                                      | Removal proof                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ffiSafe.ts`       | Prevent invalid negative draw coordinates from reaching unsigned Node FFI calls.                                                                                    | Disable the wrapper and pass its focused regression plus the affected live scroll/diff flow on the candidate.                                                     |
| `nativeHandles.ts` | Degrade syntax styling when the installed native handle registry is exhausted instead of crashing the mount.                                                        | Prove the candidate removes the exhaustion class, then pass the large-session resource probe with the wrapper disabled.                                           |
| `renderer.ts`      | Own renderer acquisition/finalization, restrict non-shutdown signals, guard upstream error handlers, and request a full repaint without resetting the input parser. | Disable one workaround at a time; pass lifecycle/error and redraw tests plus a real PTY copy/input/repaint smoke.                                                 |
| `clipboard.ts`     | Provide Hermes' bounded subprocess/OSC 52 behavior and keep clipboard failures out of input handlers.                                                               | Adopt an available upstream service only after its installed declarations and behavior cover the Hermes contract, including cleanup and remote-terminal fallback. |

Do not delete a wrapper because a similarly named API appears on upstream main.
Removal requires the candidate package to expose it and the original regression
to pass with the wrapper disabled. Upstream filing or publication is a separate,
explicitly authorized action.

## Upgrade procedure

1. Work in an isolated clean branch. Record the Hermes base, old exact package
   versions, intended upstream tag/commit, selected Node identity, platform and
   architecture.
2. Read the candidate release source and the testing, rendering diagnostics,
   native crash, clipboard, keymap, component and deployment documentation.
   Compare every proposed API with the candidate's installed declarations.
3. Update the three OpenTUI manifest pins and lockfile together. Use the
   repository's selected Node/npm; do not reuse native modules produced by a
   different Node ABI. A lockfile diff is part of the review surface.
4. Run `npm ci`, `npm run check`, and `npm run build` in `ui-opentui`. Record the
   actual test count and output from that candidate; do not copy totals from an
   earlier release.
5. Audit each boundary independently. First preserve the baseline with all
   wrappers enabled, then disable only the wrapper whose upstream fix is being
   evaluated and rerun its focused regression. Keep a wrapper when the result is
   ambiguous.
6. Run resource probes in fresh Node processes. `ui-opentui/scripts/mem-bench.tsx`,
   `pager-bench.tsx`, and `queue-bench.tsx` contain their current build/run
   commands and measurement semantics. Compare like-for-like inputs and runtime
   identities; RSS alone is not allocation attribution.
7. Exercise a fresh real PTY through the complete launcher/gateway path: initial
   render, typing and paste, queued input, scroll, resize, selection/copy,
   suspend/resume or external input, redraw, session switch and clean shutdown.
   Headless forced frames cannot prove spontaneous repaint or native input.
8. Verify the packaged-runtime path as well as the source tree. The launcher in
   `hermes_cli/main_tui_launch.py` selects a runtime, re-inspects it under the
   refresh lock, and delegates transactional build/promotion to
   `hermes_cli/opentui_runtime.py`. A successful source build does not prove the
   installed bundle, native package, Python source root or selected profile.
9. Update this ledger only with reproduced changes. Keep current measurements in
   retained release evidence rather than turning historical numbers into future
   gates. Preserve Ink as the recovery renderer.

## Research snapshot

On 2026-09-10, read-only remote checks observed OpenTUI main at
`ac753b48d386707a931dcf881d0741905b64b4f9`. That revision's test renderer uses
visual-idle/native-cell signals, and its clipboard source exposes the composed
service described above. Those observations are upgrade leads, not evidence that
Hermes `0.4.1` has the same surface. Exact multi-project provenance and the
installed-versus-reference policy are maintained in the maintainer engineering
reference.
