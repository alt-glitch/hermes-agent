# OpenTUI engineering-reference refresh handoff

This change refreshes source documentation and the versioned maintainer
engineering reference only. It does not update dependencies or native code,
install skills, change a live profile, deploy the maintainer, start/retry work,
publish a branch, or prove that a later agent followed the new guidance.

## Read-only handoff reconciliation

The existing retained handoff archives were verified again without extraction
or installation changes:

| Archive                                          | SHA-256                                                            | Read-only result                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript-production-engineering-20260908.zip` | `21797c900240fae6c93fb54eacfd10a031d56a170a7d45cc8bf137e387533717` | Five substantive members byte-match all three installed roots; every member was scanned case-insensitively and contains no OpenTUI reference. |
| `effect-v4-production-20260908.zip`              | `e96580d9f2a8212677c4607f716231a6a442dc62cb88aa6c6e7a5fa77798a3b7` | Five substantive members byte-match all three installed roots.                                                                                |

The compared roots were `~/.agents/skills`,
`~/.hermes/skills/software-development`, and the isolated
`opentui-maintainer` profile's `skills/maintenance`. AppleDouble metadata was
excluded from the five-member count. This proves archive integrity and current
byte equality, not semantic adoption. The TypeScript skill remains deliberately
renderer-neutral; OpenTUI-specific guidance stays in the OpenTUI skills and the
maintainer engineering reference.

A representative strict TypeScript fixture also compiled and ran against the
existing daily-driver installation (`effect@4.0.0-beta.78`, TypeScript `5.9.3`,
Node `v26.3.0`). It exercised `Context.Service`, `Layer.succeed`,
`Schema.decodeUnknownOption`, exhaustive matching and scoped
`Effect.acquireRelease`. It made no dependency or installed-skill change.

## Coordinator deployment obligation

Only the coordinator may deploy this reference, after reviewing the committed
diff and retained evidence:

1. Wait for this worker and every owning maintainer execution/lease or
   restart-safe worker to reach a terminal state. Inspect authoritative process
   and run state; an observer timeout or unreaped zombie is not liveness proof.
2. Pause the existing profile-scoped cron with the supported Hermes command,
   confirm it is paused, and reconcile any deployment journal. Do not create a
   replacement job or deploy over an unobserved gate.
3. Run the reviewed candidate's
   `ops/opentui-fork-maintainer/scripts/configure.py --apply` transaction with
   the existing `--hermes-home`, `--job-id` and `--runtime-home`. Do not copy
   `engineering.md` by hand and do not use `--create-paused` for an existing
   installation.
4. While still paused, compare the deployed reference hash/readback with the
   reviewed candidate and retain the deployment receipt. Reconcile rollback or
   an interrupted journal before any resume. Restore the prior pause state only
   after the full asset set verifies.

The broader deployment sequence and its proof boundaries remain in
`docs/handoffs/opentui-maintainer-issue-deployment.md`. This handoff grants no
new credential, scheduler, issue or publication authority.

## Installed-reference migration

Do not choose a whole installed tree as the newest source. Compare each relevant
reference in isolated-profile, global-Hermes and coordinator installations with
its previously deployed version. During this audit, global/coordinator
`failure-learning.md` retained inserted recovery lessons while the isolated
`verification.md` retained newer runner, fixture and targeted-CI lessons. Their
reviewed rules are reconciled into the versioned references in this candidate;
recheck for later deltas before deployment. Preserve legitimate pending notes
in the designated `profile-learning.md` and route failed/retried runs to it.
Keep originals and hashes; do not automatically merge unknown instructions.

The generic shared OpenTUI documentation mirror and Hermes discovery of the
compact launcher/architecture guide also need explicit distribution readback.
The profile mirror audit does not certify other installed mirrors. Preserve
user-owned metadata and unique references, verify actual fresh-process discovery
before deciding a guide is missing, and do not recreate the already-matching
TypeScript/Effect bundles. These are deployment obligations, not claims that
this source commit changed any installed skill.

## Later-agent adoption obligation

After deployment, use a new wrapper-owned maintainer run rather than the run
that authored this change. Retain evidence that its routed packet selected the
maintainer, OpenTUI, TypeScript-production and Effect-v4 skills; that it read
their complete entrypoints and this `engineering.md`; and that it applied one
new rule to a bounded real decision. For example, the agent can compare a
proposed upstream API with the candidate's installed declaration and compile a
minimal fixture, or use exhaustive matching for a closed decoded union while
retaining an explicit fallback for an open domain.

A skill listing, installed-file hash or read event proves routing/presence only.
Adoption requires the decision, command/output and resulting review or patch to
show the reference changed how the work was evaluated. Report deployment and
later adoption separately; both remain outstanding at this source commit.
