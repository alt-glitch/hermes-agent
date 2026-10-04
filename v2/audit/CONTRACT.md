# CONTRACT — Hermes code-health architecture audit (read-only readers)

Every reader reads this file in full before doing anything else. If a rule here conflicts
with your habits, this file wins.

## 0. Who asked and what for

Sid (engineer at Nous Research, maintainer on this repo) asked for a thermonuclear
code-quality audit of `hermes-agent`, held to the standard of large, well-run Python
projects. His words, condensed:

> Do a deep audit of how many low-hanging but also important fruits exist in working with this
> project. Figure out which anti-patterns and codebase smells exist, and use good architectural
> standards plus the reference repos to guide us into fixing them. Give me a good map of things
> to kill and simplify. Be extremely aggressive in holding this repo to proper large-Python-project
> standards.

The parent agent turns your reports into one interactive HTML walkthrough. Your report is
evidence for that page, so it must be precise, cited and structured exactly as section 6 says.

## 1. Repo, revision, and your permissions

- Checkout: `/Users/sid/main-quests/nous-research/hermes-agent` at `origin/main` =
  `ea81748579` (the working tree has a few untracked local dirs; ignore them unless your seam
  is the kill list).
- **Read-only.** Do not edit, create, or delete anything inside the checkout except under
  this lab: `/Users/sid/main-quests/nous-research/hermes-agent/.scratch/code-health-audit/`.
  No git commands that write (no checkout, stash, commit, worktree add). No `uv sync`,
  `pip`, `npm`. Running Python from inside the checkout with `uv run` syncs the project and
  rewrites `.venv`; if you need a helper script, put it in the lab `scripts/` and run it with
  `cd / && uv run --no-project python <abs path>` (stdlib only), or `uvx --from ruff==0.15.10 ruff ...`.
- **Never run tests or CI locally** (Sid, explicit): no pytest, `scripts/run_tests.sh`, vitest,
  `npm test`/`npm run check`, tsc, `gh run`/`gh workflow`, act. The parent already ran the only
  static passes needed (ruff, AST metrics). Read code only.
- Reference repos live in `/Users/sid/main-quests/nous-research/hermes-agent/.repos/`
  (gitignored, shallow). Manifest: `inputs/reference-repos.md`. Read only.
- You may spawn your own subagents if your seam is too large for one pass, but you remain
  responsible for the single report and every claim in it.

## 2. Mandatory first steps (in this order)

1. `skill_view(name="hermes-agent-dev")` — how this repo is worked on: facade + siblings
   layout, shape gates, the rules maintainers actually enforce.
2. `skill_view(name="thermo-nuclear-code-quality-review")` — the review standard. Apply it.
   Be ambitious: look for the "code judo" restructure that deletes whole layers, not renames.
3. `read_file` the root `AGENTS.md` IN FULL (it is ~38k chars; page with offset until done),
   then the `AGENTS.md` of every directory your seam covers.
4. Read `inputs/metrics/SUMMARY.md` (parent-computed numbers; use them, do not recount
   them) and `notes/parent-facts.md` (verified facts and decisions).
5. Read `inputs/gist/0-plan.md` (the maintainer's lint/ratchet plan). Section 7 explains how
   your audit relates to it.
6. Write your report skeleton (section 6) to disk BEFORE deep reading. Then fill it section by
   section. A reader that dies mid-run with nothing on disk wasted the run.

## 3. Scope

**In scope (user-facing runtime paths):** `agent/`, `run_agent.py`, `model_tools.py`,
`toolsets.py`, `cli.py`, root `hermes_*.py` (including all `hermes_state*.py`), `utils.py`,
`mcp_serve.py`, `hermes_cli/`, `tools/`, `gateway/`, `tui_gateway/`, `cron/`, `plugins/`,
**`pm/` (Sid: "PM is extremely important")**, `acp_adapter/`, `hermes_platform/`,
`providers/`, `pyproject.toml`/`setup.py` packaging, and the installer entry
(`setup-hermes.sh`, `hermes_bootstrap.py`) where they are the user's first contact.

**Out of scope — do not audit, do not recommend changes inside:** `apps/desktop/`, `tests/`,
`tests-js/`, `scripts/`, `evals/`, `environments/`, `tinker-atropos/`, `mini-swe-agent/`,
`skills/`, `optional-skills/`, `website/`, `docs/`, `web/` and `ui-tui/` TypeScript internals
(the JSON-RPC contract boundary to them is in scope for the TUI seam). Exception: the kill-list
seam measures how much of the off-path code exists and how core is coupled to it.

Python is the standard. TypeScript is out of scope except where Python owns a contract.

## 4. Evidence rules

- Every code claim: `path:line` or `path::symbol` against the checkout. Every reference-repo
  claim: `.repos/<name>/<path>:<line>`.
- Anything you did not check yourself: prefix `UNVERIFIED:` and say what would verify it.
  A gap stays a gap; never turn it into a recommendation.
- Counts: say how you counted (the `rg`/AST command). Prefer the parent's metrics files.
- Distinguish "this is how it works today" from "this is what I propose". Never blend them.
- Before calling something dead, unused, or duplicated, search for every caller
  (`rg -n "symbol"` over the in-scope tree AND `plugins/`), including string-based dynamic
  dispatch (`importlib`, registry names, `getattr`).
- Before calling a design wrong, read why it exists: `git log -S "<symbol>" --oneline | head`
  and the area AGENTS.md. If the oddity is deliberate (AGENTS.md calls it a rule), say so and
  argue against the rule explicitly if you still think it is wrong. That is allowed; ignoring
  the rule is not.

## 5. What a finding is

A finding is a structural problem with a concrete fix, not a lint count. Prioritise in the
order the review skill gives: structural regressions → missed code-judo simplifications →
spaghetti/branching → boundary/type problems → file size → modularity → legibility. No nits.

Each finding carries:

- `id`: seam prefix + number (`AGT-03`).
- `title`: one line, states the problem.
- `severity`: `critical` (hurts every contributor or user daily, or a correctness hazard across
  the tree) | `high` | `medium` | `low`.
- `effort`: `S` (< 1 day, one PR) | `M` (a few PRs, < 1 week) | `L` (multi-week campaign) |
  `XL` (re-architecture).
- `kind`: `kill` (delete it) | `collapse` (merge N things into 1) | `restructure` (move/redraw
  a boundary) | `boundary` (type/contract/ownership) | `hygiene`.
- `low_hanging`: true only if effort is S or M AND severity is high or critical.
- `evidence`: list of `path:line` strings (at least two for anything above `low`).
- `problem`: what is wrong and what it costs, literally (who pays, how often).
- `move`: the concrete restructure. Name the files that disappear or merge, the new boundary,
  the new type. "Refactor X" is not a move.
- `reference`: `{repo, path, pattern}` — the reference-repo code that shows the target shape.
  `null` only if no reference applies.
- `loc_delta`: rough net lines removed (negative) or added; say `null` if you cannot estimate.
- `risk`: what could break, and the behaviour that must be preserved.
- `depends_on`: other finding ids (yours or another seam's prefix) this needs first, or `[]`.

Target 8–15 findings, high conviction. Fewer strong findings beat many weak ones.

## 6. Output (exact paths and shapes)

Write two files under `reports/`, named `NN-<seam>.md` and `NN-<seam>.json` (NN and seam from
your brief). Validate the JSON after each write:
`cd / && uv run --no-project python -m json.tool <path> > /dev/null && echo ok`.

### 6a. Markdown report skeleton (write this first)

```
# NN <seam title>

## TL;DR
(5 lines max: the one structural problem that matters most, the biggest kill, the biggest
simplification, the low-hanging fruit count, your answer to the seam question)

## What this area is
(scope you covered with LOC, entry points, the 5–10 modules that matter and what each owns)

## How it works end to end
(one or two flows a user actually triggers, step by step, `path::symbol` per hop, with the
inputs that change the path. Mirrors `flows` in the JSON.)

## Findings
(one subsection per finding, same fields as the JSON, ordered by severity)

## Kill list
(table: target | why | importers/callers | evidence)

## Simplify list
(table: what N things | become what 1 thing | lines saved | evidence)

## Reference patterns to copy
(table: repo | path | pattern | where it applies here)

## Answer to the seam question
(direct answer, a paragraph)

## Cross-seam notes
(things you saw that belong to another seam: one line each, seam id + path:line + observation)

## UNVERIFIED
```

### 6b. JSON companion (the HTML page is built from this)

```json
{
  "seam": "agent-loop",
  "nn": "04",
  "title": "Agent loop",
  "prefix": "AGT",
  "tldr": ["...", "..."],
  "scope": {"paths": ["run_agent.py", "agent/"], "loc": 131790, "files": 317},
  "modules": [{"path": "agent/conversation_loop.py", "loc": 1835, "owns": "the turn loop"}],
  "flows": [
    {
      "id": "cli-turn",
      "title": "User types a prompt in the CLI and gets an answer",
      "trigger": "hermes chat, user presses Enter",
      "inputs": [
        {"name": "tool_calls_in_reply", "type": "bool", "default": true,
         "meaning": "model answers with tool calls instead of final text"}
      ],
      "steps": [
        {"n": 1, "where": "cli.py::HermesCLI.handle_enter", "loc": "cli.py:812",
         "does": "reads the composer buffer and starts a turn", "when": null, "finding": null},
        {"n": 2, "where": "agent/tool_executor.py::execute_tool_calls", "loc": "agent/tool_executor.py:140",
         "does": "runs each tool call", "when": {"input": "tool_calls_in_reply", "equals": true},
         "finding": "AGT-04"}
      ]
    }
  ],
  "findings": [
    {"id": "AGT-01", "title": "...", "severity": "high", "effort": "M", "kind": "collapse",
     "low_hanging": true, "evidence": ["agent/x.py:10", "agent/y.py:20"],
     "problem": "...", "move": "...",
     "reference": {"repo": "pydantic-ai", "path": "pydantic_ai_slim/pydantic_ai/_agent_graph.py:120", "pattern": "..."},
     "loc_delta": -800, "risk": "...", "depends_on": []}
  ],
  "kill_list": [{"target": "path or path::symbol", "why": "...", "callers": 0, "evidence": "..."}],
  "simplify_list": [{"from": ["a.py", "b.py"], "to": "one module c.py", "loc_saved": 400, "evidence": "..."}],
  "reference_patterns": [{"repo": "svcs", "path": "src/svcs/_core.py:200", "pattern": "...", "applies_to": "..."}],
  "seam_answer": "...",
  "cross_seam": [{"seam": "08-state", "note": "...", "evidence": "path:line"}],
  "unverified": ["..."]
}
```

Rules for `flows`: 1–3 flows, 5–15 steps each, every step a real `path::symbol` and `path:line`
you opened. `inputs` are the user-visible conditions that change the path (busy session,
provider type, config key set, platform). A step's `when` is `null` (always runs) or
`{"input": name, "equals": value}`. Link a step to a finding id where the smell lives.
These flows become the page's step-through debugger, so they must be true.

## 7. How this relates to the maintainer's ratchet plan (`inputs/gist/`)

The gist is a plan for lint ratchets and invariant checks (CC caps, file caps, swallowed
excepts, profile-scope lint, hang lint, prompt-cache tests). It is about **enforcement**.
This audit is about **design**: which modules, layers, mechanisms and concepts should not
exist, which N things should be one thing, which boundaries are drawn in the wrong place, and
which reference-repo shape replaces them.

- Do not re-propose a lint rule as a finding. If a lint count is evidence of a structural
  cause (e.g. 2,700 F821s because of a globals-rebinding mechanism), the finding is the
  mechanism, and the count is evidence.
- Cite gist numbers when they support you (`inputs/gist/C-fix-commit-classes.md` has bug-class
  counts from 22k fix commits; a structural fix that removes a bug class is worth saying so).
- Where your structural fix makes a gist rule unnecessary, say so.

## 8. Writing standard

Literal, direct prose. No metaphor, no flourish, no "it's not X, it's Y", no hype words.
Short sentences, one idea each, active voice. Name things by their real names. A reader who
has never opened the file must understand the problem from your sentence plus the citation.

## 9. Final message to the parent

Exactly: the two paths you wrote, a five-line summary, and your `UNVERIFIED` list. Nothing else.
