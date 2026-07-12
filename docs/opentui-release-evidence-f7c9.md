# OpenTUI f7c9 release evidence

Evidence recorded 2026-07-12 for target `0ce042077` with a dirty feature
working tree. Runtime: Node 26.3, OpenTUI 0.4.1, Effect 4.0.0-beta.78.

## Quality gates

- OpenTUI full gate: 101 files, 1,430 tests, 40.72 s, one worker.
- Static/type/build: green. Lint: zero errors and 16 pre-existing warnings.
- Python gateway/release contracts: 27 passed, 2 skipped.
- Live PTY fallback: tmux exercised `/details` and `/model --refresh` at
  132x40, then resized to 90x28. PNG: `/tmp/hermes-opentui-final.png`.
  `termctrl --host opentui` sessions were stale because the host handshake did
  not complete, so they are not claimed as evidence for this final smoke.

## Startup and real-PTY fixture

Three startup runs measured first byte at 126/130/135 ms (median 130 ms),
session creation at 175/177/179 ms (median 177 ms), and VmHWM at
111,056/111,200/111,252 KB (median 111,200 KB). Event-loop lag stayed at or
below 1 ms with zero violations.

Raw startup results in `~/github/tui-bench/results/`:

- `2026-07-12T1121-0ce0420-startup-opentui-otui-capped-r0.json`
- `2026-07-12T1121-0ce0420-startup-opentui-otui-capped-r1.json`
- `2026-07-12T1121-0ce0420-startup-opentui-otui-capped-r2.json`

The real PTY 100-message fixture ended at RSS 223,604/226,812/212,536 KB and
VmHWM 224,592/253,848/257,284 KB, with 3 ms lag and zero violations. Raw
results:

- `2026-07-12T1123-0ce0420-mem100-opentui-otui-capped-r0.json`
- `2026-07-12T1123-0ce0420-mem100-opentui-otui-capped-r1.json`
- `2026-07-12T1124-0ce0420-mem100-opentui-otui-capped-r2.json`

## Component hydration and retained native state

All component fixtures contain 100 messages.

| Path | Adoption median | Total median | RSS median | Renderables | Native allocations |
|---|---:|---:|---:|---:|---:|
| Cold resume | 83.11 ms | 227.65 ms | 202.7 MB | 1,257 | 2,795 |
| Warm switch | 41.46 ms | 86.94 ms | 192.0 MB | 1,092 | 2,112 |
| Live fixture | - | - | 270.5 MB | 1,257 | 1,346 |

Cold run RSS was 202.7/205.1/201.5 MB; warm run RSS was
192.0/191.5/196.0 MB; live fixture RSS was 270.5/286.2/268.7 MB. Raw component
logs are `/tmp/opentui-resume-cold-r{0,1,2}.txt`,
`/tmp/opentui-resume-switch-r{0,1,2}.txt`, and
`/tmp/opentui-live-r{0,1,2}.txt`.

Ten repeated 100-message replacements passed the exact retained-state gate:

| Metric | Target | Previous | Result |
|---|---:|---:|---|
| Renderables | 1,092 | 1,257 | pass |
| RSS, cycles 5-10 | 222.0-224.0 MB | - | stable |
| Post-warm allocations | 2,243 -> 1,584 -> 863 | 2,757 -> 2,696 -> 2,476 | pass |

The repeated-cycle tolerance was zero, the harness required at least eight
non-vacuous cycles, and the gate passed. The full Vitest run
did not record an OS peak-RSS measurement; that omission is stated rather than
inferred from process-local fixture measurements.

## External release evidence still required

Published-image real-PTY starts on Linux x64/arm64 and the remote exact-wheel
matrix on Linux/macOS x64/arm64 require external CI/host evidence. The local
contracts and Linux x64 path are covered; this report does not claim those
remote executions occurred.
