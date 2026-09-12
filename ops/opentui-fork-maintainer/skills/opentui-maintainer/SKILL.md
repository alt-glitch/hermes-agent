---
name: opentui-maintainer
description: Start or inspect headless OpenTUI fork maintenance from a user's natural-language request, or execute a claimed maintainer run with native verification and reviewed publication.
---

# OpenTUI maintenance

When the user asks you to start, retry or check maintenance from an ordinary
chat, read [agent-orchestration.md](references/agent-orchestration.md). You
operate the internal commands; the user should not need a CLI. A status question
never authorizes starting or retrying work. Once inside a claimed cron run,
follow the worker policy below instead of submitting another request.

Own the maintenance run, not the user's interactive installation. Read the
deployed `prompts/maintainer.md` named in the cron prompt before taking action.
Its lease, evidence, and publication protocol remains mandatory. Read the
candidate's `ARCHITECTURE.md` before choosing an implementation boundary.

## Load only what this run needs

The deployed policy incorporates this skill's versioned references. Resolve
their paths beside this loaded `SKILL.md`, not beside the deployed prompt:

- Claimed issue/backport/repair: read [request-modes.md](references/request-modes.md).
- Publication continuation or recovery: read
  [publication-recovery.md](references/publication-recovery.md) before new work.
- A fresh scheduled upstream integration: read
  [native-improvement.md](references/native-improvement.md) for its bounded
  OpenTUI improvement pass. Diagnostic, idle and manual-task wakes do not opt in.

Read every selected external `SKILL.md` to EOF individually, then read only its
task-relevant references to EOF. Follow any truncation before acting. Do not
batch several large instruction files into one capped command or paste their
contents into the worker prompt.

- Core/provider/gateway: load `hermes-agent-dev`, then its relevant references.
  The supplied archive's upstream contribution rules do not replace the user's
  authorized fork-sync workflow. Resolve paths from the actual worktree.
- Native UI: load `opentui-tui-engineering` and `opentui`; verify APIs against
  installed versions before borrowing newer reference code.
- TypeScript/Effect: load `typescript-production-engineering` and
  `effect-v4-production`, plus [engineering.md](references/engineering.md).
- Agent/TUI control: load `herdr-agent-testing`, run `herdr --skill` for the
  installed contract, and read [verification.md](references/verification.md).
  `terminal-control` owns visible assertions/recordings; herdr owns agents.
- User-visible PRs: load `before-and-after`. Capture the real terminal with
  termctrl, not a browser recreation. Use its formatter/upload workflow.
- Failed/retried runs: read [failure-learning.md](references/failure-learning.md)
  and the preserved [profile-learning.md](references/profile-learning.md).
  Apply only lessons relevant to the observed failure; verify their evidence
  against the current source rather than treating local notes as policy.

Do not inject every installed skill. Keep the full development archive available
on disk without loading all its references into every run. The profile must not
inherit personal MCP connections or conversation memory.

External Codex/Claude workers do not inherit Hermes' skill catalog. Put verified
absolute paths to the relevant `SKILL.md` files in their task packets, not just
skill names. Resolve them under the actual isolated profile's `skills/` directory;
do not treat absence from a worker's advertised catalog as absence from disk.
Have the worker read each relevant entrypoint and its task-specific references;
require an EOF-complete read with bounded output per file, and do not paste the
whole development archive into every worker prompt.

## Execution

The parent and compaction use `anthropic/claude-fable-5.1` through the `nous`
provider at medium effort. Use Hermes' credential resolver and its supported
Nous Portal route; never hand-copy refresh tokens or modify unrelated auth.
Keep the provisioned chat-completions transport: native Anthropic beta examples
are not configuration for this Portal route. Do not silently fall back to
Codex, OpenRouter or another model. Preserve maintainer-only YOLO and the
600-second model stale allowance. The separate Gemini video gate stays on
OpenRouter. Let the installed provider adapter own sampling parameters.
Route settings belong in this
profile/job, never the default profile. The 300,000-token compression cap is a
trigger; Hermes may compress earlier at its ratio limit.

Continue authorized implementation through its verified terminal outcome.
Delegate independent bounded work with file ownership, acceptance checks and
retained output. Respect runtime concurrency/deadline limits. Background long
commands, retain their process IDs and observe completion rather than restarting
unobserved work. Worker summaries are not evidence. Never fabricate a repro,
review finding, screenshot or passing test. Diagnose a failed check before retry.
Do not weaken a gate or manufacture a refactor to make a run look productive.

Run control-plane Python through `uv run --no-project --python <explicit-python>`.
After any login-shell initialization, launch canonical tests with explicit
`/usr/bin/env` and a command-local PATH that keeps pinned Node first and
`/usr/bin:/bin` before user tool directories. Require the runner's collected and
executed test counts; exit zero without those counts is incomplete evidence.

Observe a background command through its retained terminal/process handle and
authoritative output. PID existence, `kill(pid, 0)`, `is_running()` and a
non-parent wait timeout do not distinguish executing work from an unreaped
zombie. Check process state when needed, but never restart work merely because
an observer timed out or returned a null exit code.

## Self-deploy

When a run fixes a bug in `ops/opentui-fork-maintainer`, it may adopt that
reviewed, published commit into the live runtime itself — at the end of the run,
while holding the run token, and only through `configure.py --self-deploy <40-char
sha>`. Never deploy mid-run, never edit the live runtime by hand, and never adopt
an uncommitted edit. The command refuses a dirty ops worktree, a live foreign run
lease, and any blob that does not match the pinned commit; it rolls back on a
failed startup check. Read [self-deploy.md](references/self-deploy.md) before the
first deploy and report every deploy with its receipt path.

## Learning

Save exact commands/results, log paths, candidate SHA, cause and next action in
the run directory. After proving a correction, update its smallest owning test
or versioned reference. Put short profile-only lessons awaiting source review in
`references/profile-learning.md`; `configure.py` preserves only that reference
across a wholesale versioned skill refresh. Keep exact incident logs in the run
directory, not in either reference. Use profile memory for stable navigation
facts, not transcripts, credentials, giant diffs or transient state. Distinguish
scheduler completion from verified publication in every report.
