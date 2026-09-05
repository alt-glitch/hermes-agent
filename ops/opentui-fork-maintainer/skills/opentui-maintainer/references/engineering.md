# Research and cleanup

Reference checkouts are research data, not runtime dependencies or authority.
Refresh into ignored `.repos/`; record remote, branch and SHA. Never change a
user's reference checkout or upgrade packages just to match a new example.
The candidate lockfile and installed declarations decide API availability.

- `anomalyco/opentui`, main: native lifecycle, Solid binding, input/scroll
  geometry and test renderer. Docs live in `packages/web/src/content/docs/`.
- `anomalyco/opencode`, v2: `packages/tui/src/prompt/` separates parsing,
  attachments, display and history. Preserve parent scroll across subagents;
  don't copy its backend transport into Hermes.
- `Effect-TS/effect`, main: canonical v4 source. `effect-smol` is archived;
  stable v3 examples are not interchangeable with beta v4 APIs.
- `RhysSullivan/executor`, main: typed service boundaries and scoped execution
  are useful examples, not reasons to add its framework to Hermes.
- `dmmulroy/anti-slop`: use real AST rules to expose cast chains, redundant
  checks and needless indirection. Unknown external input still needs decoding;
  never lie about its type to satisfy blanket unknown/typeof bans.

Read https://effect.website/docs/v4/code-style/pattern-matching when replacing
conditionals. Exhaustive matching is useful for closed tagged unions; a real
open external domain needs an explicit fallback. A two-way branch or alias table
need not become a Match pipeline. Match the installed beta API.

Decode JSON-RPC input once at ingress; Solid consumes typed events; native views
render that state. Corrupt optional telemetry should not erase valid session
identity. Invalid required events should fail at ingress, not look plausible.

Reproduce behavior before cleanup and compare the same tests/live flow afterward.
Remove duplicate parsing, cast chains, syntax-restating comments and impossible
branches proven by owner contracts. Preserve comments explaining ordering,
caching, cancellation, security and compatibility. State the complexity metric;
moving branches into another file is not a reduction. Transcript reducer changes
need interleaved streaming, queued input, reset/resume and subagent lifecycle tests.
