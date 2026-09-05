# Astra maintenance campaign — verification ledger

Prepared on 2026-09-05 in `codex/astra-maintainer`, based on fork
`07d5e99c2b59f3a39f546966160a59ba250ee1ee`. This is a preparation ledger, not a
claim that the replacement cron has been activated or these changes published.

## Environment and real model tests

- Created `~/.hermes/profiles/opentui-maintainer` without bundled skill seeding or
  shell aliases. Copied only the demo profile's OpenRouter key; source untouched.
- Direct OpenRouter Responses tool-call/result round trip returned `ASTRA_PROBE_OK`.
- Real Hermes tool loop returned `MAINTAINER_RESPONSES_OK Linux`, session
  `20260905_180811_167970`, after honoring explicit OpenRouter Responses routing.
- Real `AIAgent` initialization reported OpenRouter / `codex_responses`, Astra,
  context length 1,050,000, configured cap 300,000 and effective trigger 300,000.
  This proves configuration reaches the compressor, not that a 300k-token live
  conversation was generated and compressed.
- Owned herdr session `opentui-maintainer`, termctrl handle `maintainer-herdr`,
  agent `maintainer-smoke`: candidate OpenTUI booted; real terminal `uname -s`
  and visible `HERDR_MAINTAINER_OK Linux` completed. Herdr's first prompt wait
  returned nonzero even though the answer subsequently appeared. The driver
  originally discarded stderr; do not invent the precise cause. It was changed
  to preserve diagnostics and inspect state without resubmitting accepted input.
- Herdr control runs inside the owned pane, not against a user's focused session.
  The initial driver wrongly assumed every successful command returns JSON;
  `pane run` can succeed silently, and `agent read` returns text. Corrected.
- Full supplied development archive and selected skills installed with backups
  outside discovery; three focused skill entrypoints pass skill validation.

Raw local artifacts are under `/tmp/opentui-maintainer-20260905/`; they are
temporary diagnostics, not durable publication evidence or public attachments.
The final cron proof must use the runtime-owned run directory.

## Regression evidence

- OpenRouter resolver: initial four failures reproduced; focused provider suite
  81 passed after repair, including suppression of a mismatched custom-provider
  probe warning. Default OpenRouter routing remains unchanged unless configured.
- Disabled toolsets: real composite-resolution tests reproduced the TUI losing
  disable policy; fixed primary/background/preview and tools-show paths.
- Telemetry: decoder owns optional finite metrics; malformed metrics are omitted
  individually. Status aliases use a typed lookup, preserving prototype-name
  unknowns and normalization behavior.
- Journey: explicit visual schemas replace duplicate interfaces/double assertion.
  Installed Effect beta78 StructWithRest could overwrite repaired fields with
  raw malformed data. Explicit top-level Struct avoids that behavior. Real Python
  render_frames output round-trips through the actual TS decoder for empty and
  populated graphs; 27 focused/native-renderer tests pass.
- Full native check: 128 files, 2,014 tests passed; typecheck, formatting and
  ESLint passed (18 existing warnings). Candidate build completed.
- Anti-slop official rules vendored unchanged at `e8c4880`, with matching
  Oxlint/plugin 1.81.0. Initial 1,124 findings became 1,089 after the first cleanup;
  later Journey cleanup is additional. Audit remains nonzero, separate from the
  existing check gate. It includes genuine work and rule/domain mismatches;
  no claim that the whole codebase is now slop-free.
- Deployment/provision tests exercise real temporary profile stores, repeatable
  refresh, copy/rename failure rollback, credential isolation and recurring-job
  preservation. New jobs remain paused. Generated entry tests use actual cron
  execution records under conflicting ambient identity.
- PR publication tests cover lost acknowledgements, candidate/media binding,
  unchanged unrelated prose and refusal before target CAS on attachment failure.
  Independent review identified inherited startup input as a privacy-provenance
  gap; it must be repaired and retested before any real upload.

## Research inputs

Owned reference snapshots: OpenTUI `7581976f4d2c`, OpenCode v2 `2960c61f9c5c`,
Effect v4 main `f9235832c463`, Executor `38915a32cfa0`, anti-slop `e8c4880471b2`.
Read the supplied Effect pattern-matching page, official latest-model guidance,
and matklad architecture guidance. Reference refresh did not upgrade OpenTUI or
Effect runtime pins. `prepare_references.py` verifies clean, correctly routed
owned checkouts and emits their exact SHAs.

## Remaining release work

No production cron cutover, upstream integration publication or new-model cron
cycle is claimed by this ledger. Initial video-route changes were refused by the
permission checker and were not bypassed. The user subsequently explicitly
approved sanitized test recordings to Gemini through OpenRouter. Implement and
verify that route with the isolated profile's credential; do not borrow default
profile authentication. Record actual route verification below when complete.

Approved-route check completed: a fresh 160×48 `/help` capture through the
allowlisted environment passed the real Gemini 3.5 Flash judge at
`https://openrouter.ai/api/v1`, ending `VERDICT: PASS`. Recording SHA-256:
`89a569f5d49cc21a3515d9bafcbb18ec82d4da77dddfab1070f9eaef5ecf3aee`.
Raw verdict SHA-256:
`3a75894ea11d076b096cb77eaba39f2a89be9500316b38b4de02dadce914f9d3`.
The legacy job was paused after confirming its latest execution completed and
no run lease or in-flight deployment journal remained.

Before cutover: finish independent review fixes, keep the legacy job paused while
replacing shared runtime assets, verify the generated profile entry identity,
install/verify a dedicated cron-only gateway, run a fresh real integration cycle,
and check its PR, full gate, exact remote commit and finalized journal. Preserve
old history and other gateways. Update this ledger with actual outcomes rather
than replacing the missing proof with a successful unit-test summary.

## Reviewed preservation follow-up, 2026-09-06

PR #40 carries the extraction-preservation work and subsequent corrections:
`cefd1b6b466`, `2d435410aef`, and `5b173e13612`. Gateway and cron correction
reviews both returned APPROVED from Fable 5.1 with real source reads. Cron's final
review recorded no permission denials. These were static reviews, not test runs.

- Cron: 380 passing tests across 14 fresh processes; root independently confirmed
  the 21-case regression file. Includes real subprocess crash/no-replay coverage.
- Gateway: combined suite 1,780 passed, one skipped; fresh-process sweep 1,779
  passed, one failed, one skipped. The hosted-room migration failure passed on a
  standalone 39-test rerun. Keep the original failure as a caveat.
- Root's three focused gateway files: 21 passed. Pre-fix gateway reproduction:
  10 failures and three passing controls.
- Actual compression parser/trigger probe: configured 300k cap becomes 300k for
  1.05M context, and 96k for 128k context. Not a live 300k summary-quality test.

Local evidence index:
`~/projects/opentui-fork-maintainer/state/verification/20260905-preservation-candidate/README.md`.
The target/global install and paused cron have not been advanced by these tests.
Require fresh current-head CI and Greptile 5/5; older approvals do not carry over.
