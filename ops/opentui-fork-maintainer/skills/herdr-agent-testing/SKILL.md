---
name: herdr-agent-testing
description: Verify a real Hermes agent lifecycle in an explicitly owned herdr session, with visible termctrl evidence and isolated profile state.
---

# herdr agent testing

Use the installed `herdr --skill` as the command authority. Verify `HERDR_ENV=1`
inside the managed control pane before issuing pane/agent commands. Do not control
the user's focused herdr session from outside it. For a requested isolated test
session, start an owned herdr UI through termctrl and execute the control commands
inside its own shell pane; do not spoof HERDR_ENV on an unrelated process.

Discover `herdr pane current --current` and create a sibling with explicit cwd,
direction and `--no-focus`. Read its ID from the returned JSON. Installed 0.8.2
uses `herdr agent start <name> --kind hermes --pane <id> -- <Hermes args>`.
It does not split or accept the old `--split`/`--cwd` agent-start examples.
Use `herdr agent prompt <name> <text> --wait --timeout <milliseconds>` to submit;
it includes Enter. `agent wait` defaults to settled idle/done/blocked; `unknown`
is not proof of completion. Read visible/recent-unwrapped output and verify the
expected response or artifact. On a blocked result inspect before answering.

Use the isolated maintainer profile, never copied personal sessions. Select
candidate Python/source/engine explicitly. Test a real tool call, not just an
HTTP probe; that exercises routing, streaming, tool execution and persistence.
Keep keys out of commands, logs and screenshots. Stop owned disposable panes
after collecting evidence; retain only the separately requested maintainer
control session. Use `terminal-control` for recordings and exact visible waits.
