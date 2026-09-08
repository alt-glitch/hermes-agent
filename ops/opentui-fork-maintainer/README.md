# OpenTUI fork maintainer

Versioned engineering workflow for keeping `alt-glitch/hermes-agent: sid/opentui`
aligned with canonical `NousResearch/hermes-agent: main`. The parent classifies
actual diffs, integrates in an owned worktree, verifies behavior and publishes
only a candidate whose exact evidence passes the runtime gates.

## Runtime ownership

| Resource | Owner |
| --- | --- |
| Parent model | `gpt-6-astra`, `openai-codex` subscription provider (Hermes Responses loop), medium reasoning |
| Profile | `~/.hermes/profiles/opentui-maintainer` |
| Credential provisioning | Hermes' supported Codex login/import and credential resolver; only the video gate's `OPENROUTER_API_KEY` is copied by the provisioner |
| Compression | 300,000-token cap; effective trigger is the lower of cap and ratio limit |
| Skills | One compact auto-injected `opentui-maintainer`; selected supporting skills on demand |
| Scheduling | One profile-local cron, 03:00/09:00/15:00/21:00 Asia/Kolkata, dedicated cron-only gateway |
| Runtime/state | `/home/daimon/projects/opentui-fork-maintainer/` |
| Visual judge | Gemini through OpenRouter, using the isolated profile's credential |

Profiles do not inherit personal MCPs, memories or conversations. The parent
profile owns its own sessions and credential. The user explicitly approved
sending sanitized test recordings to Gemini through OpenRouter on 2026-09-05.
Only maintainer-owned synthetic test captures are eligible; inherited startup
prompts, images and session overrides must be cleared before capture. Runtime
constants validate the exact judge route and reject cross-provider fallback.

The maintainer sets `terminal.home_mode: real` for external CLI workers. Hermes
state remains scoped by `HERMES_HOME`; this setting keeps Codex/Claude using
their existing OS-user login instead of an empty profile-home credential store.
No external CLI credentials or personal conversations are copied into the
profile. Verify login and a bounded real tool call from the actual child
environment, not just from the orchestration shell. A 401 from an empty worker
HOME is distinct from the parent's provider capacity errors.

The profile sets `tool_output.max_bytes: 12000` (the existing setting counts
characters) to bound terminal previews. Full command output remains available
in spill files or redirected evidence logs. This reduces accidental context
growth; it does not guarantee provider capacity or lower the 300k compaction cap.

## Provision and migrate

Use the managed Hermes Python with `uv`. Inspect the printed plan before apply.
The supplied development-skill ZIP is installed as a complete reference library;
its upstream-specific identity and release rules do not override fork policy.

```bash
hermes profile create opentui-maintainer --no-skills --no-alias
uv run --no-project --python /home/daimon/.hermes/hermes-agent/venv/bin/python \
  ops/opentui-fork-maintainer/scripts/provision_profile.py \
  --dev-skill /absolute/extracted/hermes-agent-dev --apply --refresh-skills
uv run --no-project --python /home/daimon/.hermes/hermes-agent/venv/bin/python \
  ops/opentui-fork-maintainer/scripts/configure.py --apply --create-paused \
  --hermes-home /home/daimon/.hermes/profiles/opentui-maintainer
```

Create the profile only once. Skill refresh stages replacements before replacing
them and preserves backups outside skill discovery. Provisioning is not a
whole-profile transaction: keep the job paused while changing its environment.
The job ID is generated and saved in `state/job-identity.json`; subsequent
deployments use `--job-id <that-id>`, not another `--create-paused`.

Pause the legacy default-profile job `c57fe4db4d43` and confirm its current run
has finished **before deploying shared runtime assets**, not merely before
resuming the replacement. Creation leaves the new job **paused**. Verify route/tool execution, compression,
skill loading, candidate source selection and the profile's scheduler before
resuming it. Never run two active schedules against the same runtime state.
Use supported profile-scoped `hermes cron pause/resume/run` commands, not raw edits
to the jobs database. Preserve historical default-profile reports.

Existing multiplex gateways discover profile homes at startup. Creating a profile
does not prove it has a ticker. Install/start a dedicated profile gateway with
`hermes -p opentui-maintainer gateway install` and verify its status; a gateway
with no messaging platforms is intentionally allowed to execute cron jobs.
Do not restart the user's other gateways to test the maintainer.

On this host, the user has a shell setup file named `~/.local/bin/env` that
returns success without executing its arguments. The generated gateway unit
places that directory before `/usr/bin`. Keep a maintainer-only systemd drop-in
at `~/.config/systemd/user/hermes-gateway-opentui-maintainer.service.d/10-controlled-path.conf`
whose `[Service]` `Environment="PATH=..."` keeps the managed venv and pinned Node
first, then `/usr/bin:/bin`, then `~/.local/bin` and the other tool directories.
Run `systemctl --user daemon-reload` and inspect the effective unit environment
before starting. Verify that `env` resolves to `/usr/bin/env` and actually runs
a sentinel command. Do not edit the user's setup file or other gateway units.
This drop-in survives normal Hermes gateway reinstalls.

Configuration deployment retains the existing pause/journal/verify/rollback
protocol. Recovery journals are bound to both profile home and job ID. Relative
entrypoint scripts remain inside that profile's `scripts/` directory, as required
by the scheduler. An interrupted deployment must be reconciled before resuming.

## Approved issue queue

The same job polls open fork issues carrying both `opentui` and
`maintainer:ready`. The latest ready-label event must be by `alt-glitch` or a
locally configured trusted approver, strictly after the current content edit.
Edit the title/body first, then remove/reapply ready to approve the new revision.
Comments remain context, not approval or executable instructions. Optional
`state/issue-trust.json` has exactly `schema_version: 1`,
`repository: "alt-glitch/hermes-agent"` and `trusted_approvers: ["login"]`.
Do not derive trust from issue text or commit this local trust file.

Explicit queued requests and interrupted publication recovery take precedence.
Intake selects one eligible issue by number; `issue-intake-state.json` retains
revision-specific delivery/cooldown state. Failures back off from six hours up to
seven days while other eligible issues remain selectable. API failures are not
empty queues. Feature-only work wakes even with no upstream delta, uses linear
whole-diff review and leaves the upstream watermark unchanged. Captured open
implementing PRs must be reconciled; the publisher refuses duplicate candidates.

The parent claims via the existing `claim-request` command, inspects the issue
and implementing PRs, and retains a reproduction or existing-fix contract proof.
A label is not permission to bypass gates. Issue state, revision and approval are
rechecked before publication and again after CI. The runtime alone records
issue delivery after target CAS; implementation, publication, finalization and
live deployment remain distinct stages.

## Verification and publication

Each wake binds one run token, execution ID, fork base and upstream SHA in
`run-context.json`. No-op/up-to-date scanner ticks need not invoke a model.
The absolute eleven-hour lease may span a six-hour tick; proven active-owner
overlap is skipped, not a successful maintenance run. Healthy work is not killed
at the separate 600-second model stale allowance. Worker packets are bounded to four hours and at
most two concurrent workers. Background long calls and observe their exit status.

The complete gate installs the committed lockfile, runs focused contracts and
the full OpenTUI check/build, obtains independent review, drives the candidate
with termctrl, and analyzes its actual recording. The PR stage publishes the
verified candidate branch and sanitized Preview evidence, then waits for a
completed green current-candidate GitHub checks before the existing
target compare-and-swap. It reads classic branch protection and active rulesets for
the exact base, requires every configured status context to be reported, and waits
for GitHub's clean merge decision (including source-app bindings). Unreadable policy
or unsupported rules such as required workflows fail closed for maintainer review;
they are never inferred from display names. A failed check or bounded observation timeout
leaves the PR open and the target unchanged. Inspect the actual findings; fix real
defects without widening the change into speculative refactors.
Even on an unprotected branch, CI's final `All required checks pass` aggregate
must report; a workflow that never starts cannot authorize publication.
The user disabled Greptile. Do not request paid reviews or require a confidence
score. Independent review, native verification and configured GitHub branch
requirements remain mandatory. A branch rule that still requires Greptile must
be resolved explicitly, not silently bypassed.

After the first clean task implementation commit, `publish-draft` pushes the
stable task/base-owned branch and creates one draft PR before focused, native,
review and visual verification finish. Its managed body separates Prepared,
Passed and Pending evidence; it never uses the all-gates-passed wording for an
early draft. A later `gate-and-ship` attaches verified Preview evidence, updates
that same body and marks the same PR ready before observing current-head CI.
Linear fix commits use `--expected-pr-head` on both commands. The publisher
checks the same-repository owner, exact base/head, task marker, remote ref and
ancestry before any update. If failed CI left the task PR ready, the early
publication command returns that proven PR to draft before advancing its fix
head. An exact compatible existing issue draft can be adopted; a diverged
retained draft is refused without rewriting or topology waiver.

Every existing task owner is checked before expensive local gates, including an
unchanged early draft when `--expected-pr-head` is omitted. A genuinely absent
PR permits first publication; malformed or mismatched ownership does not.
Preflight retains `pr-owner-preflight-surfaces.json` and the matching parent
disposition. GitHub Actions failures also retain the original job log bound to
its run, job, attempt and check identity; ANSI bytes remain untrusted file data.

Every owned-head update and final review observation collects
`pr-review-surfaces.json`: general PR comments, inline review comments, formal
reviews, and all failed CheckRun and status attempts for the relevant heads.
Bodies are retained completely as untrusted evidence, never authorization. If any item requires
attention, the parent writes `pr-review-disposition.json` with the exact
candidate and observation hash plus one `resolved`, `refuted` or `irrelevant`
decision and evidence note per item key/hash. Missing, partial, stale or tampered
dispositions block the update or target delivery even when the latest CI rollup
is green. Editing or adding a comment changes the observation hash and requires
a fresh disposition; detailed output stays in the run evidence directory.

For a diagnosed video-only failure on unchanged source, `gate-and-ship` accepts
`--reuse-manifest <prior-attempt>/gate.json --reuse-sha256 <exact-SHA256>`.
Use a distinct attempt directory for the new packet, manifest and outputs: even
a different manifest filename in the old directory is refused before mutation.
The prior manifest, packet, code output and approved review artifacts must remain
intact and bound to this exact candidate/base/authorization. Source-check commands
and reviewer configuration must match; only the fresh native drive may change
(e.g. a diagnosed terminal-width recapture). Native capture and video analysis
always execute again. This is not a generic cache or permission to reuse evidence
for changed source, to suppress real visual failures, or to skip current-head CI.

PNG and MP4 exports use the same explicit `DejaVu Sans Mono` family, installed
on the maintainer host. Verify it with `fc-match 'DejaVu Sans Mono'` when moving
the runtime: a platform font-list fallback can make captures much thinner than
the actual terminal. Keep original recordings and failed judge results. Diagnose
visual findings against recorded screen states and the exported video before
changing UI behavior or retrying; a re-export is not a passing publication gate.
The target update remains the only publication boundary;
do not bypass it with `gh pr merge` or worker pushes. A startup/help Preview is
not proof of a different feature interaction. Use the `before-and-after` skill
for real matched comparisons and verify uploaded attachment URLs.

Publishing and finalization are separate journaled phases. If the remote accepted
the candidate before a local failure, reconcile that candidate rather than push
again. The runtime removes only its proven clean detached integration worktree;
the user's daily-driver branch, index and working files are untouched.

## Inspect a run

### Continue an already-verified publication

`resume-publication` is an observation-only alternative to `gate-and-ship`, not
a gate waiver. It requires a live owner created by the existing wrapper, the
nonblocking run lock, a different retained run with terminal `publish-refused`
outcome, explicit original manifest/packet hashes, and an explicitly adopted PR.
It verifies the original lease/context binding, clean exact candidate/base,
packet commands, hashed logs and nested review/media/video artifacts, review
diffs, current authorization, PR ownership/attachment and current GitHub policy.
It does not invoke local gates, upload media, edit the PR or push its head branch.
The existing target CAS, journal, request consumption and finalization follow.
Source artifacts and the old failed outcome remain immutable; the fresh run's
`gate.json` references them in `continuation` and records its own lease binding.

For a retained scheduled sync, submit a bounded `mode: resume` request through
`submit-request`, then dispatch the existing job. The checked-in
`pr81-continuation-request.json` pins the explicitly authorized legacy PR81
delivery. It queues before issue intake and is consumed only after publication.
PR81's missing ownership marker is supported only for its pinned manifest,
packet, candidate/base and established head branch; no arbitrary legacy PR is
adoptable. Other resumable PRs must have the task ownership marker. Issue/manual
continuations require the original request to be reclaimed and still authorized;
the scheduled `resume` request is not an issue-approval substitute.

The explicit request is the recommended deterministic dispatch path. An already
authorized scheduled owner with no queued/in-flight request may also continue a
retained scheduled failure directly, provided the same base/watermark binding,
explicit manifest/packet pins, PR adoption and all evidence checks still pass.
This does not authorize a new candidate or bypass a pending task.

After claiming, the parent invokes:

```text
uv run <runtime>/scripts/maintainer_runtime.py resume-publication --state <state> --token <fresh-token> --source-manifest <state>/runs/<original-run>/gate.json --source-sha256 <original-hash> --packet-sha256 <original-packet-hash> --adopt-pr <verified-number> --manifest <fresh-evidence>/gate.json --repo <fork>
```

An interrupted observer can retry that same command under the same still-live
owner without renewing its deadline. After owner termination, retain the source
reference and use a fresh wrapper-owned run. A post-CAS interruption instead uses
the existing `finalize-success`/reconciler, never a second publication attempt.
Missing/tampered artifacts, changed source/base or authorization fail closed.
Do not use this path to ignore a genuine failed check or unresolved finding.

Future PR identities bind task/revision and integration base, not the candidate
hash or a scheduled owner's token. For a linear fix on an owned task PR, run the
full `gate-and-ship` with `--expected-pr-head <exact-previous-head>`. Before a
head update the publisher verifies the open same-repository PR, ownership marker,
task revision/base, expected remote head and ancestry; the leased push is a
fast-forward-only CAS, not permission to rewrite history. A new head requires
fresh local review/evidence and current-head CI. Legacy adoption does not grant
permission to append fixes to PR81's historical branch.

For local maintainer tests, use the canonical runner with explicit `--files`,
`-j 1 --file-retries 0`. Inspect executed counts, not its AST estimate. On this
host put `/usr/bin:/bin` first in the command PATH: the user `env` wrapper can
otherwise make the runner exit zero without executing tests. Do not edit it.

Use `hermes -p opentui-maintainer cron list`, `cron status` and `cron runs` for
schedule/execution state. Then inspect `state/last-run.json` and its referenced
`state/runs/<run-id>/` evidence. A scheduler success, model summary or live worker
does not prove a push. Require a passing manifest, publication journal, terminal
outcome and matching remote SHA. Reports include PR URL, exact range, behavior,
actual tests/visual proof and any concrete blocker.

Refresh research only when needed with `scripts/prepare_references.py --refresh`.
It owns ignored `.repos/` clones, refuses dirty/mismatched checkouts and prints
exact SHAs. Reference refresh never changes runtime dependencies. Anti-slop is
available as `npm --prefix ui-opentui run lint:anti-slop`; it currently reports
unresolved findings separately from the established passing check gate. See
`ui-opentui/tools/oxlint/README.md` for the measured migration, not a claim of zero
slop. Failure lessons live with the compact maintainer skill.

See `prompts/maintainer.md` for the control-plane protocol and `tests/` for its
failure-path contracts. `docs/handoffs/opentui-maintainer-dashboard.md` describes
a future read-only dashboard; no dashboard is deployed by this workflow.

For supplemental Fable 5.1 agentic checks, follow
`skills/opentui-maintainer/references/ultracode-verification.md`. Ultracode runs
in a separate owned verification session; the formal publication reviewer keeps
its read-only restrictions. Require actual workflow and interaction evidence,
not merely a model summary or a successfully parsed setting.
