# Native OpenTUI improvement during upstream maintenance

The user authorizes a bounded, proactive improvement pass alongside each fresh
scheduled upstream integration. This supplements required compatibility work;
it is not permission to rewrite Hermes or manufacture a change every run.

## Enter only from the scheduled lane

Require a valid wrapper-owned run token and captured fork/upstream SHAs, with
the ordinary scheduled sync selected and actual upstream changes to integrate.
Ownerless probe-error wakes, locked/idle ticks, approved issue work, manual
backports/repairs and publication continuations do not start this pass. Preserve
the scheduler's existing no-agent behavior when no work is eligible.

After establishing the integration candidate, delegate two independent scouting
questions using the existing worker packet runner and model routing:

1. Native performance/resource use: a reproducible rendering, input, streaming,
   scroll/windowing, startup or cleanup cost in `ui-opentui`.
2. Native ownership/code quality: a demonstrated duplicate transformation,
   unnecessarily broad reactive update, resource-lifetime defect or avoidable
   complexity within an existing OpenTUI boundary.

Keep the existing limit of two external workers total, including adaptation
and verification workers. Reuse a relevant adaptation worker's investigation
rather than launching a duplicate scout; serialize conflicting ownership.
Scouts start read-only, get narrow file areas and at most two findings each,
and must return once they have checked those areas. Keep working on independent
integration tasks while they run. The four-hour packet timeout is a hard outer
limit, not an exploration target; do not invent unsupported packet fields.

## Ground the investigation

Supply absolute paths to the installed `opentui-tui-engineering`, `opentui`,
`typescript-production-engineering` and `effect-v4-production` entrypoints as
relevant. Require complete reads and only their task-relevant references.
Read [engineering.md](engineering.md) for the existing source inventory and
installed-version precedence. OpenCode, Effect, Executor and newer OpenTUI
sources are comparison material, not replacement architectures or dependencies.

Before proposing a change, inspect current candidate behavior, existing tests
and prior open work for that behavior. An upstream improvement already present,
a previously rejected idea, or an active overlapping PR is not fresh work.
Explain an actual improvement in native user behavior, measured resource use,
or named code complexity; lint findings and aesthetic preference alone are not
acceptance evidence. Check author intent before removing compatibility behavior.

Each finding returns: owning file/symbol; observed problem and reproduction;
relevant reference/version; proposed minimal change; baseline measurement or
behavior contract; risks and required tests; retained evidence paths. Full logs
stay in artifacts, not the parent response. Distinguish measured facts from
hypotheses and say when no worthwhile finding was established.

## Select and implement without broadening scope

The parent may select up to two small, independent, well-supported improvements
per scheduled run. Zero is valid. Do not repeatedly rescan just to meet a quota.
Required upstream preservation takes priority; optional work must not consume
the remaining lease needed to verify and publish it. Record unselected leads
without opening or approving issues automatically or starting another pipeline.

Proactive edits are limited to `ui-opentui/`, including its existing tests and
directly relevant package documentation. No new features, dependency upgrades,
renderer/framework migration, generalized managers, shared Python backend,
launcher, Ink, desktop, website, maintainer configuration or core-agent changes
are authorized by this pass. Required upstream adaptations outside that fence
remain separately scoped compatibility work under the normal run policy.

Each writer gets an isolated worktree, exact allowed files, behavioral acceptance
and relevant installed skill paths. Writers may not publish or spawn children.
Before accepting its commits, the parent inspects the real changed-path list,
including renames and deletions, and rejects anything outside the proactive
fence. These are review-enforced file boundaries, not an OS security sandbox.
Inspect the full diff and reproduce claimed results before cherry-picking.

## Prove value and finish through the same release path

Performance claims compare the same input, source baseline, Node/native package,
terminal dimensions and measurement method. Record sample counts and variability;
do not call noise an improvement. Resource work proves cleanup and interruption.
Ownership/refactoring work preserves the relevant behavior and names the metric;
moving branches between files is not lower complexity. Follow neighboring test
scope rather than committing every scratch probe.

Keep all accepted improvements in separate linear commits on the scheduled
candidate, documented in `capability-preservation.md` and the run's
`native-improvement.md` receipt. Record each scout, selected/refuted/deferred
finding, allowed and actual changed paths, baseline/result, commit and test
evidence. This receipt supports review; it never authorizes publication.

Complete the pass before final candidate gates. Reuse the task's existing PR;
do not create one PR per scout or alter a head already waiting for CI merely to
add optional cleanup. Every accepted change is covered by the normal complete
candidate review, native check/build, real terminal proof and current-head CI.
No self-deployment or change to gates, approvals, credentials or the schedule.
The final report distinguishes required upstream adaptations, proactive
improvements actually delivered, and unimplemented findings.
