# OpenTUI retained-publication recovery ordering

This issue41 run prepares a draft only. It does not deploy the maintainer
runtime or advance `sid/opentui`. PR90's retained proof remains bound to fork
base `6ddcdf00bd5984dc864f10edf8ea61dd48289aa9` and exact candidate
`c69ce49b54d2a9f126086800a9392f57de9dfbc7`. That candidate and its retained
evidence must not be rewritten.

The issue41 draft is intentionally stacked above unchanged PR90. Its exact head
contains `c69ce49b54d2a9f126086800a9392f57de9dfbc7` as the prerequisite, followed by
the retained issue41 implementation and this cleanup-ownership correction. A
local publisher fixture proves that when the fork base advances exactly to the
prerequisite, the same candidate can be adopted on the same issue PR: no
replacement PR, force-push, ancestry waiver, or new controller is needed.

The coordinator-controlled sequence is:

1. Inspect this prepared draft and its evidence. Pause the maintainer job and
   reach quiescence, then deploy the reviewed control-plane source through the
   existing pause/journal/verify transaction without changing `sid/opentui`.
2. Under a fresh authorized owner, resume PR90 at base
   `6ddcdf00bd5984dc864f10edf8ea61dd48289aa9` and candidate
   `c69ce49b54d2a9f126086800a9392f57de9dfbc7`. Recheck current authorization,
   PR surfaces, required CI, target CAS and finalization. The repaired
   continuation retains the prior run as the cleanup owner for its clean
   detached `integration` worktree.
3. After PR90 finalizes, `sid/opentui` is exactly the issue41 prerequisite.
   Reclaim issue41 with the new captured base and adopt the same draft and exact
   candidate. Refresh its task/base marker and run fresh candidate-bound review,
   local gates, native/visual evidence and current-head CI before guarded
   publication.

PR90's retained review covers only PR90. Any review performed before this
cleanup correction or against the old issue41 base does not cover changed code
or replace the required new-base issue41 review and gates. If quiescent runtime
deployment cannot precede PR90 recovery, stop with that ordering blocker; do not
relax ancestry, rewrite either candidate, or fabricate replacement evidence.
