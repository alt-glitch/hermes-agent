# OpenTUI fork maintainer

Versioned engineering workflow for keeping `alt-glitch/hermes-agent: sid/opentui`
aligned with canonical `NousResearch/hermes-agent: main`. The parent classifies
actual diffs, integrates in an owned worktree, verifies behavior and publishes
only a candidate whose exact evidence passes the runtime gates.

## Runtime ownership

| Resource | Owner |
| --- | --- |
| Parent model | `openai/gpt-6-astra`, OpenRouter Responses, medium reasoning |
| Profile | `~/.hermes/profiles/opentui-maintainer` |
| Credential provisioning | Only `OPENROUTER_API_KEY` from the explicitly selected demo profile |
| Compression | 300,000-token cap; effective trigger is the lower of cap and ratio limit |
| Skills | One compact auto-injected `opentui-maintainer`; selected supporting skills on demand |
| Scheduling | Profile-local cron, 09:00 and 21:00 local time, dedicated cron-only gateway |
| Runtime/state | `/home/daimon/projects/opentui-fork-maintainer/` |
| Visual judge | Gemini through OpenRouter, using the isolated profile's credential |

Profiles do not inherit personal MCPs, memories or conversations. The parent
profile owns its own sessions and credential. The user explicitly approved
sending sanitized test recordings to Gemini through OpenRouter on 2026-09-05.
Only maintainer-owned synthetic test captures are eligible; inherited startup
prompts, images and session overrides must be cleared before capture. Runtime
constants validate the exact judge route and reject cross-provider fallback.

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

## Verification and publication

Each wake binds one run token, execution ID, fork base and upstream SHA in
`run-context.json`. No-op/up-to-date scanner ticks need not invoke a model.
The absolute eleven-hour lease fits inside the twelve-hour cadence; healthy work
is not killed at 600 seconds. Worker packets are bounded to four hours and at
most two concurrent workers. Background long calls and observe their exit status.

The complete gate installs the committed lockfile, runs focused contracts and
the full OpenTUI check/build, obtains independent review, drives the candidate
with termctrl, and analyzes its actual recording. The PR stage publishes the
verified candidate branch and sanitized Preview evidence, then waits for a
current-candidate Greptile 5/5 and completed green GitHub checks before the existing
target compare-and-swap. A lower score, failed check or 30-minute observation timeout
leaves the PR open and the target unchanged. Inspect the actual findings; fix real
defects without gaming the score or widening the change into speculative refactors.
The target update remains the only publication boundary;
do not bypass it with `gh pr merge` or worker pushes. A startup/help Preview is
not proof of a different feature interaction. Use the `before-and-after` skill
for real matched comparisons and verify uploaded attachment URLs.

Publishing and finalization are separate journaled phases. If the remote accepted
the candidate before a local failure, reconcile that candidate rather than push
again. The runtime removes only its proven clean detached integration worktree;
the user's daily-driver branch, index and working files are untouched.

## Inspect a run

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
