# Maintainer ownership: implementation acceptance

Status: specification only; implementation is not delivered by this document.
Tracks [issue #41](https://github.com/alt-glitch/hermes-agent/issues/41).
Baseline: `a1412bf8335da97a359441b75457de08ab005840` (published PR #51).

The user wants one implementer: the isolated Hermes maintainer handles upstream
ports, approved feature requests and bug fixes. The human-facing agent files
issues, dispatches the existing job when asked, and checks evidence. This
bootstrap uses the current explicit PR-repair path; it must produce working
issue intake, not merely merge this specification.

## Workflow contract

- Extend `ops/opentui-fork-maintainer/` and the existing cron machinery. Keep
  one job and one active owner; no second scheduler or publication path.
- Poll every six hours at 03:00, 09:00, 15:00 and 21:00 Asia/Kolkata. A live
  owner may work across a tick. Preserve the eleven-hour absolute lease,
  four-hour worker bound, two-worker cap and existing long inactivity budget.
- Explicit requests and interrupted-publication reconciliation precede fresh
  intake. Discover paginated open issues in this fork with both `opentui` and
  `maintainer:ready`. Approval must come from the owner or configured trusted
  maintainers; issue prose and untrusted label changes are not authority.
- Select one new issue deterministically. Bind its repository, issue number,
  approved revision/content identity, branch base and run ownership. Reuse or
  reconcile an existing implementing PR rather than duplicating work. Preserve
  errors as errors, not empty queues. Failed work must not hot-loop or starve
  the rest of the queue indefinitely.
- Feature-only work must wake the agent even with no upstream delta. Review
  its complete linear diff and never advance the upstream-sync watermark for
  it. Preserve the existing exact two-parent contract for actual upstream sync.
- Reproduce bugs before fixing them; retain commit/test evidence when already
  fixed. Recheck issue state, approval and captured inputs before publication.
  Link issue and candidate PR, and close only after proven delivery.
- Keep all seven candidate-bound gates, independent review, sanitized native
  media, current-head Greptile 5/5, required CI producer checks, remote CAS and
  durable finalization. Neither a model summary nor a cron exit proves success.

## Setup and recovery requirements from actual runs

The owner changed the main provider to **Nous Portal**, superseding older
OpenRouter instructions for Astra. Preserve `openai/gpt-6-astra`, medium
reasoning, Nous for main and compaction, the 300000-token compression trigger,
and 600-second model stale allowance. The installed Nous resolver currently
chooses Chat Completions for Astra. Use shared Portal OAuth resolution, not
copied refresh tokens. Keep the approved Gemini video gate on OpenRouter.
Maintainer-only YOLO is authorized; personal MCPs and conversations stay out.

Both `scripts/provision_profile.py` and `scripts/configure.py` currently pin
OpenRouter. Correct both owners and their policy/skill references; test fresh
setup and reprovisioning, including the actual job resolver. Do not redeploy
these old assets over the working Nous profile before the fix is reviewed.

PR #51 exposed a 30-minute publication wait shorter than its successful Python
CI run (54 minutes). The label rerun helper also exited successfully after
giving up while CI was active. Support bounded waits appropriate to actual CI
and the remaining lease, with truthful pending/recovery state. Do not relax CI,
restart a live parent, or rerun successful tests just because observation timed
out. Preserve candidate-PR identity across recovered requests with matching
source/base/candidate, while keeping fresh lease authority and required gates.

At the 21:00 tick, a live direct run correctly prevented another agent from
starting, but the scheduler recorded `Fire claim lost; execution was not
started` as failed. Distinguish proven active-owner overlap from genuine claim
loss and stale/dead owners; do not relabel every false claim as a benign skip.
Also cover inherited `HERMES_EXEC_ASK` in gateway-hosted cron approval routing:
deny must remain deny, approve must remain approve, and interactive prompts
must remain unaffected. The current profile's authorized YOLO is not a generic
cron routing fix.

## Evidence required before calling this complete

1. Behavior tests with real imports and isolated state cover trusted approval,
   pagination/API failure, revision edits/closure/revocation, existing PRs,
   no-upstream-delta features, stale bases, overlap, failed gates, interrupted
   push and idempotent completion. No personal config writes or source-regex
   tests. Use the repository's isolated Python test runner where applicable.
2. Retain a real bounded agent run showing approved issue → implementation →
   verified candidate PR → durable completion. Use sanitized TUI fixtures for
   native evidence; label startup/help captures Preview, not feature proof.
3. After this implementing run is terminal, deploy through the existing
   pause/quiescence/journal/verify transaction. Do not self-modify a live gate
   or restart its owning gateway. Verify the selected profile/job route and
   actual six-hour schedule, then observe a real scheduled tick. Report each
   stage separately if deployment or live proof remains outstanding.
4. Update the existing operational README, focused skill references and failure
   handoff with actual owners and commands. PR titles/descriptions should say
   what changed, not just a candidate hash. Retain before/after or honest Preview
   evidence without personal conversations or credentials.

The next backlog is upstream preservation (#45), agents UX (#42), prompt expiry
(#47) and startup/shutdown profiling (#50). Those issues are not bundled into
this bootstrap implementation. The dashboard remains a separate handoff, not a
new control plane for this change.
