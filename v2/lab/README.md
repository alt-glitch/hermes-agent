# v2 trace lab

Use Hermes the way you normally do, and record which Hermes code each run actually executes.

## Setup (once per machine, and again after PM rebuilds the runtime)

```bash
v2/lab/trace/install.sh            # adds an inert .pth hook to the interpreters your `hermes` uses
ln -sf "$PWD/v2/lab/trace/hermes-traced" ~/.local/bin/hermes-traced
```

`install.sh --uninstall` removes it. The hook does nothing unless `V2_TRACE_DIR` is set, and
`hermes-traced` is the only thing that sets it.

## Day to day

```bash
V2_TRACE_TAG=tui-normal-day   hermes-traced --tui
V2_TRACE_TAG=skill-run        hermes-traced -q "use the github skill to list my open PRs"
V2_TRACE_TAG=subagents        hermes-traced          # then ask for a delegated task
V2_TRACE_TAG=mcp-list         hermes-traced mcp list
V2_TRACE_TAG=config           hermes-traced config show
```

Each Python process of the run (the CLI, the TUI's gateway child, workers) writes one JSONL file
under `~/.hermes/v2-traces/<stamp>-<tag>/`. Records are function names, file paths, line numbers,
first caller and thread name. No arguments, values or environment contents are recorded.

Then, in this worktree:

```bash
uv run --no-project python v2/lab/trace/analyze.py            # all runs
uv run --no-project python v2/lab/trace/analyze.py ~/.hermes/v2-traces/<run>   # one run
open ~/.hermes/v2-traces/_report/REPORT.md
```

The report shows, per process: what it was launched as, how many Hermes functions it entered, and the
order in which it first entered each package (the startup timeline). Across all runs: the share of
each package's functions that anything has executed, and the modules no run has entered yet.
`data.json` has the first-call tree edges for richer views later.

## Cost

On Python 3.12+ the tracer uses `sys.monitoring` and switches each function off after its first call,
so a traced session runs at normal speed. Your daily venv is 3.11, which falls back to
`sys.setprofile`: noticeably slower on call-heavy work, fine for interactive sessions. Runs launched
through PM's managed 3.14 runtime use the fast path.

## Reading the results

"Never entered" means nothing you traced reached it, not that it is dead. The more ordinary days you
trace (CLI, TUI, gateway, cron, skills, subagents), the more that list means.
