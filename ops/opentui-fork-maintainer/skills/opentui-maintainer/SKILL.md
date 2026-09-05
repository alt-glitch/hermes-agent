---
name: opentui-maintainer
description: Maintain the sid/opentui Hermes fork in an isolated cron profile, with upstream integration, native TUI verification, reviewed publication, and durable run evidence.
---

# OpenTUI maintenance

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

## Execution

The parent uses `openai/gpt-6-astra` through OpenRouter Responses with medium
reasoning. Do not send temperature/top-p/logprobs. Route settings belong in this
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
