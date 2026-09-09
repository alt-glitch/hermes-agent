# OpenTUI retained-publication recovery ordering

This runtime-repair run prepares a commit only. It does not deploy the maintainer
runtime or advance `sid/opentui`. PR90's retained proof remains bound to fork
base `6ddcdf00bd5984dc864f10edf8ea61dd48289aa9` and exact candidate
`58e83efe5e395f3d4481717b2954d2dd4e9bc13c`. That candidate and its retained
evidence must not be rewritten.

The PR91 draft is intentionally stacked above unchanged PR90. Its exact repair
head starts from `44d6be19979367ce150eea3497b28763ffcf0c1f`; this run adds only the
pre-evidence continuation correction. Temporary Git publication fixtures prove
that both the same live owner and a terminal prior owner can retain the exact
draft/manifest/packet/check identities, republish the hash-bound Preview, create
genuinely missing publication evidence, and reach the existing guarded target CAS. No replacement PR,
force-push, ancestry waiver, or new controller is introduced.

The coordinator-controlled sequence is:

1. Inspect this prepared draft and its evidence. Pause the maintainer job and
   reach quiescence, then deploy the reviewed control-plane source through the
   existing pause/journal/verify transaction without changing `sid/opentui`.
2. Under a fresh authorized owner, resume PR90 at base
   `6ddcdf00bd5984dc864f10edf8ea61dd48289aa9` and candidate
   `58e83efe5e395f3d4481717b2954d2dd4e9bc13c`. Recheck current authorization,
   PR surfaces, required CI, target CAS and finalization. The repaired
   continuation retains the prior run as the cleanup owner for its clean
   detached `integration` worktree. Its missing `pr-evidence.json` is recoverable
   only through the hash-bound `pr-draft.json`, exact live owner/base/head/marker,
   and republished hash-bound source Preview. Pending or failed CI still refuses.
3. After PR90 finalizes at `58e83efe5e395f3d4481717b2954d2dd4e9bc13c`, reconcile
   ancestry on the same PR91 before release. PR91 retains the older PR90
   prerequisite and is not yet descended from this newer PR90 head. Do not
   treat exact-head adoption alone as sufficient, replace the PR, or waive
   ancestry checks. Preserve both heads and use the separately authorized
   same-PR reconciliation step. Changed source/base then requires fresh
   candidate-bound review, local gates, native/visual evidence and current-head
   CI before guarded publication.

PR90's retained review covers only PR90. It is reused unchanged for metadata
recovery and is never rerun solely to recreate publisher state. Any review
performed before this runtime correction or against PR91's old base does not
cover changed code or replace the required new-base PR91 review and gates. If quiescent runtime
deployment cannot precede PR90 recovery, stop with that ordering blocker; do not
relax ancestry, rewrite either candidate, or fabricate replacement evidence.
