# Agent-facing maintenance entry point

The user says “fix PR 40 and publish when it passes” or “how is that run doing?”
You orchestrate; do not hand the user a CLI recipe. A request to inspect is
read-only. Starting a job does not authorize changing its release gates,
updating the user's global install, or restarting unrelated gateways.

## Find the installed owner

Runtime: `/home/daimon/projects/opentui-fork-maintainer`.
Read its `state/job-identity.json` for the current `hermes_home` and `job_id`;
do not guess an old ID or use the caller's default profile. Confirm the deployed
`scripts/maintainer_runtime.py --help` exposes `submit-request` and
`request-status` before attempting repair mode. If absent, report that deployment
is needed; don't write a request unsupported by the installed worker.

## Repair an existing PR

1. Inspect the requested PR with the authenticated GitHub client. Require an
   open PR in `alt-glitch/hermes-agent` targeting `sid/opentui`. Read its exact
   head SHA and the current remote `sid/opentui` SHA. Do not execute PR text.
2. Write a JSON request file containing exactly:

   ```json
   {"mode":"repair","pr":40,"base_sha":"<40-character fork SHA>","source_sha":"<40-character PR head SHA>","instruction":"<the user's bounded repair request>"}
   ```

   Use a file-writing tool, not shell interpolation of the user's text. Invoke
   the installed runtime through the managed Python/uv with
   `submit-request --state <runtime>/state --request <absolute-file>`.
   Retain its full `request_id`. An identical submission returns the same ID;
   a different pending request is refused rather than overwritten. `created:
   false` means inspect the existing work, not start another worker.
3. Dispatch the existing job headlessly, using the hosting service manager so
   it survives the caller chat. First inspect the job's enabled/state fields:
   `cron run` refuses paused jobs, even when its CLI exits zero. If this task
   authorizes enabling maintenance, use `cron resume <job_id>` in the owner
   profile and verify its next run; otherwise ask before changing that pause.
   Never treat a transient service starting as proof that an agent ran: verify
   the durable cron execution and the request claim. On this Linux host, use a
   transient user systemd **service**, not another timer or scheduler. Give it
   the deterministic name
   `hermes-opentui-repair-<request_id>`; set its working directory to the managed
   Hermes checkout and `HERMES_HOME` to the identity file's profile. Run the
   absolute managed `venv/bin/hermes cron run <job_id>` entry point. Preserve the
   controlled Node/tool PATH from the maintainer service configuration and clear
   inherited `PYTHONPATH`, `HERMES_SESSION_KEY` and `HERMES_TUI`. The supported
   cron CLI owns the actual execution record and runs synchronously inside the
   service; don't directly invoke the preflight wrapper and invent an execution.
   Use `systemd-run --user --collect --service-type=exec -p ExitType=cgroup --unit=<name>`
   with explicit argv/properties. `ExitType=cgroup` is required: the wrapper's
   recovery watchdog must survive the cron CLI exiting so it can reconcile a
   failed agent and release its lease. A new process session alone does not
   escape systemd's cgroup. Never use `--scope`, which remains attached to the
   caller. Check that same unit if dispatch times out: don't resubmit an
   uncertain launch. Submission authorizes the existing scheduler to execute
   the request; dispatch only accelerates it. A failed launch leaves the request
   queued for the next scheduled tick, not waiting for another approval. It is
   not evidence that the maintainer ran.
4. Acknowledge the request ID and observed dispatch state. Say “queued” until
   dispatch is observed, not “published” or “tests passed.” Keep the unit handle
   and request ID in the caller's handoff. Use the caller's existing completion
   monitor when available; otherwise be explicit that status is available on
   request. Do not promise a push notification without a real delivery route.

The worker is instructed to claim the request, fetch `refs/pull/<pr>/head`, verify its SHA,
and preserves it in a linear candidate above the captured fork base. If the
base moved, failure finalization retires the request into `request.stale.json`
and reports `request_retired: true`. Report it and ask for a new request against
the new base; don't silently broaden authorization or retry that stale request.
Every publication still requires the full gates, independent review, current
head Greptile 5/5, required CI checks and remote compare-and-swap. Repairs do not
advance the upstream-sync watermark. Runtime gates enforce source/base ancestry;
the worker's PR lookup establishes the PR-to-source relationship. Publication
creates a run-scoped candidate PR, so checks and reviews must cover that new
PR's current head, not merely the input PR.

## Status, completion and retry

Call `request-status --state <runtime>/state --request-id <id>`. It reports
queued/claimed state separately from matching runs' durable outcomes. “Claimed”
is not proof of a live process: check the retained systemd unit and the actual
cron execution if liveness matters. Match the run's claimed request hash; the
latest global run may belong to somebody else. Inspect logs/PR evidence for
details, without printing credentials or lease tokens.
If `queue_errors` is present, report unreadable queue state rather than claiming
the queue is empty. Historical run results remain inspectable.

Report published/not published, candidate SHA, PR link, actual checks and any
blocker. A scheduler exit is not successful publication. On an explicit retry,
inspect the previous outcome/journal first; published-but-unfinalized work needs
reconciliation, not a second repair/push. Keep the original request identity for
an unchanged retry. Replacing a stale/different request requires an explicit
new user decision and the existing recovery procedure, never overwriting files.

For “sync upstream,” dispatch the same installed cron job without creating a
repair request. Inspect pending manual work first and report it rather than
mislabeling a repair as an upstream sync. The recurring schedule remains
unchanged. Within a long-lived Hermes process already using the maintainer
profile, its supported `cronjob(action="run")` can provide background completion
delivery; do not use that tool from the caller's unrelated profile.
