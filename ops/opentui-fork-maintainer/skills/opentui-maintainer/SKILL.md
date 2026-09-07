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
- Failed/retried runs: read [failure-learning.md](references/failure-learning.md).

Do not inject every installed skill. Keep the full development archive available
on disk without loading all its references into every run. The profile must not
inherit personal MCP connections or conversation memory.

External Codex/Claude workers do not inherit Hermes' skill catalog. Put verified
absolute paths to the relevant `SKILL.md` files in their task packets, not just
skill names. Resolve them under the actual isolated profile's `skills/` directory;
do not treat absence from a worker's advertised catalog as absence from disk.
Have the worker read each relevant entrypoint and its task-specific references;
do not paste the whole development archive into every worker prompt.

## Execution

The parent uses `gpt-6-astra` through `openai-codex` subscription auth with medium
reasoning and Hermes' normal `codex_responses` loop. Use Hermes' credential
resolver and supported login/import flow, never hand-copy refresh tokens or
modify the user's Codex configuration. Compaction uses the same provider; do not
fall back to Nous. Preserve maintainer-only YOLO and the 600-second model stale
allowance. The separate Gemini video gate stays on OpenRouter.
Do not send temperature/top-p/logprobs. Route settings belong in this
profile/job, never the default profile. The 300,000-token compression cap is a
trigger; Hermes may compress earlier at its ratio limit.

Continue authorized implementation through its verified terminal outcome.
Delegate independent bounded work with file ownership, acceptance checks and
retained output. Respect runtime concurrency/deadline limits. Background long
commands, retain their process IDs and observe completion rather than restarting
unobserved work. Worker summaries are not evidence. Never fabricate a repro,
review finding, screenshot or passing test. Diagnose a failed check before retry.
Do not weaken a gate or manufacture a refactor to make a run look productive.

## Learning

Save exact commands/results, log paths, candidate SHA, cause and next action in
the run directory. After proving a correction, update its smallest owning test
or reference. Use profile memory for stable navigation facts, not transcripts,
credentials, giant diffs or transient state. Distinguish scheduler completion
from verified publication in every report.
