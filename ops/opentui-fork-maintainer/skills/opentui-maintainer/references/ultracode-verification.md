# Independent Claude verification

The user authorized Claude Code source review and Fable 5.1 Ultracode verification
on 2026-09-05. Keep source review separate from interactive verification: the
publication gate's read-only reviewer must not acquire deployment or shell rights
just to run a UI check.

## Verify the installed capability

Claude Code 2.1.261 accepted exact model `claude-fable-5-1` in a real API probe.
With the settings below, a live session exposed the built-in `Workflow` tool and
confirmed Ultracode orchestration instructions. This is a capability check, not
evidence that a workflow ran. Later versions may differ: inspect local help and
the session's init event before relying on these options.

```bash
claude -p --model claude-fable-5-1 \
  --setting-sources '' --strict-mcp-config \
  --settings '{"ultracode":true,"enableWorkflows":true,"workflowSizeGuideline":"small"}' \
  --effort xhigh --permission-mode dontAsk \
  --no-session-persistence --output-format stream-json --verbose \
  'Report available workflow tools without taking actions.'
```

`--safe-mode` disables workflows. It remains correct for the formal publication
reviewer's read-only diff review, but is incompatible with the separate Ultracode
interaction check. Do not remove safe mode from that gate. Never bypass an account,
organization, or permission restriction to make a workflow appear available.

## Bound the verification workflow

The parent supplies a complete task file: exact candidate/base SHAs, owned scratch
directory, relevant skill paths, allowed behaviors, observable assertions and
forbidden actions. Use a scratch cwd, empty setting sources and strict MCP config
to avoid inheriting personal project hooks and MCPs. Grant only the tools needed
for that packet; `dontAsk` denies unapproved operations instead of waiting forever.

Use at most two verification agents, counted against the maintainer's two-worker
limit. They may inspect candidate source and create scratch harnesses, but may not
edit candidate code, installed profiles, credentials, cron, systemd or git state.
No worker may push or publish. Any test process must have an owned name; never
attach to or stop a user's session. Model-call tests require a separately scoped
packet; startup/help testing must not silently submit a prompt.

Useful independent lanes are real termctrl interaction and temporary-store
control-plane failure tests. For native UI checks, read terminal-control, select
the candidate source explicitly, build a fresh allowlisted environment and verify
hydration before sending input. Assert actual visible frames after actions and
resizes; logs are not alternate-screen state. Stop disposable sessions in cleanup.
For lifecycle checks, require actual pytest counts and failure-path assertions,
not a zero exit from a help command. Do not mutate production state to test it.

Retain the exact CLI version/model, init event, `Workflow` invocation/run identity,
child results, commands, exit codes and sanitized screenshots. Join the workflow
and inspect findings against code. Report each behavior as passed, failed or
unverified. A requested workflow that never invoked `Workflow` is not an Ultracode
verification run. An enabled but inactive gateway is not a running scheduler.

These supplemental results do not replace the candidate-bound publication gate.
If they uncover a defect, repair and retest it before starting `gate-and-ship`.
Only the existing publication workflow may upload eligible sanitized media; do
not send arbitrary terminal recordings or personal sessions to an external judge.
