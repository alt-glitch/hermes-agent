# OpenTUI fork maintainer

Versioned source for the Hermes cron that keeps `sid/opentui` aligned with
`upstream/main`. Runtime state remains in
`/home/daimon/projects/opentui-fork-maintainer/state`.

The production sync runs at 09:00 and 21:00 local time with Hermes Agent as
the parent (`openai/gpt-5.6-sol`, medium reasoning). It may delegate bounded
implementation work to Codex or Claude, but the parent owns integration,
evidence, and the final ship decision. At most two workers run concurrently.

Preview the pinned cron/configuration plan with
`uv run --project /home/daimon/side-quests/hermes-agent /home/daimon/side-quests/hermes-agent/ops/opentui-fork-maintainer/scripts/configure.py`.
Deploy the versioned policy, wrapper, classifier, worktree helper, required
skills, video routing, and cron fields with the same command plus `--apply`. The runnable cron
entrypoint is copied into `~/.hermes/scripts/` to satisfy the scheduler's
containment boundary; its versioned runtime dependencies and state remain under
`/home/daimon/projects/opentui-fork-maintainer/`. To exercise the same production workflow
against a bounded real commit, add `--backport <upstream-sha>`; the
request is one-shot, refuses to overwrite an unconsumed request, and is
resumed from its in-flight marker after an interrupted run. Long worker and
publish operations run as Hermes-managed background processes with completion
notification and an explicit process wait.

Each run is bound to one captured fork base and canonical upstream commit in a
hashed `run-context.json`. Its renewable lease has an absolute eleven-hour
deadline, so a crashed run cannot overlap the next twelve-hour tick forever. A
watchdog and the next-run reconciler converge interrupted publication journals
to a truthful terminal outcome. Manual backport requests remain queued until a
successful publish or an explicit, durable failure recovery.
The post-publish lease deadline is fixed at preparation time and cannot slide
through renewal; an expired structured run is reconciled before a later tick
may replace its lease.

Deployment is crash-safe: configuration records a durable recovery journal and
pauses the existing cron under Hermes' cron-store transaction before replacing
any live asset. The job is resumed only after all assets and persisted cron
fields verify. If the deploy process is killed, the paused job cannot execute a
mixed version; rerunning `configure.py --apply` converges the deployment from
the journal and resumes the job. Catchable failures still roll back both local
files and the original cron state. The cron stores the supported relative script
name `opentui_fork_sync.py`; Hermes resolves it inside `~/.hermes/scripts/`.

The maintainer is deliberately an engineering workflow, not a merge bot. It
classifies the upstream delta, delegates bounded implementation and review work,
integrates the results in an isolated worktree, and advances
`origin/sid/opentui` only through one atomic `gate-and-ship` operation. That
operation installs from the committed OpenTUI lockfile, runs focused and full
gates, invokes an external Codex/Claude reviewer on the exact diff, launches the
candidate under termctrl, analyzes the generated recording with Gemini 3.5
Flash through canonical OpenRouter, and performs a remote compare-and-swap. It
never changes the local daily-driver ref, index, or worktree.

Run evidence lives at `state/runs/<run-id>/`; `state/last-run.json` is the
durable terminal summary and `state/last_synced_upstream.sha` is advanced only
after the remote compare-and-swap succeeds. The notification drain is also
versioned here. It fails closed when cron delivery state cannot be read and
requeues messages whose previous delivery failed instead of silently dropping
them.

Use `hermes cron list` for the schedule and last result. For a specific run,
inspect `state/last-run.json`, its referenced evidence directory, and the
corresponding cron execution record; do not infer success from a worker summary
or a still-running terminal process.

See `prompts/maintainer.md` for the operational contract and
`tests/` for the cron-ingest security and configuration contracts.
