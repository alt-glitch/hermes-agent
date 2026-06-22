# Handoff — Porting deferred upstream Gateway/Ink-TUI features into the OpenTUI fork (Part B)

> **Companion to:** the PR #8 defer-batch sync (`sync/defer-20260619-153127`, head `46139f051`
> as refreshed). This doc is the implementation backlog for the **gateway + Ink-TUI feature
> surface** that must be adapted into the `ui-opentui/` (Solid) engine before `sid/opentui` can
> advance to the full upstream batch.
>
> **Author:** Hermes Agent (for glitch / alt-glitch) · **Date:** 2026-06-22

---

## 0. READ THESE SKILLS FIRST (mandatory, in this order)

This work is governed by three skills. Load them before writing or verifying ANY code here:

1. **`opentui`** — the API doc-mirror. Especially these references:
   - `references/hermes-overlay-port.md` — porting a NET-NEW Ink overlay into the Solid engine
     (the `$EDITOR`/`/prompt` and any modal work). Covers the `KeymapProvider`-or-it-silently-
     shows-nothing trap, init-only `<input value>`, the seven-file port map.
   - `references/hermes-gateway-event-pipeline.md` — wiring a new `tui_gateway` event or a new
     `session.info` field through the Effect-Schema decode boundary → Solid store reducer →
     render. Needed for anything that adds a wire event/field.
   - `references/react-vs-solid-reactivity.md` — Ink/React → Solid translation table. The Ink
     source for every feature here is React; you are translating to Solid signals/stores.
   - `references/hermes-tool-renderer-registry.md`, `references/effect-at-boundary-solid.md` —
     background for the engine's architecture.
2. **`opentui-app-engineering`** — the engineering layer: headless verification with
   `captureCharFrame` (mind the effect-tick), the API gotchas (`attributes` is a numeric bitmask,
   nested rich text = flat spans, `<input onSubmit>` cast-as-never), the **port strategy
   (rewrite the view, reuse the `.ts` logic)**, and the **subagent rule** (any subagent writing
   view/renderable code MUST get the `skills` toolset and be told to `skill_view` opentui first).
3. **`tmux-pane-screenshot`** — the live-TTY render-verification ladder. After headless
   `captureCharFrame`, drive the real `hermes --tui` through tmux, screenshot with
   `tshot.sh <session:window.pane>`, and `vision_analyze` the PNG. Gotchas: slash autocomplete
   eats the first Enter (send Enter twice), give the TUI ~18-20s boot, never hard-code `:0.0`.

**Verification ladder for EVERY feature here (non-negotiable, from the skills):**
`captureFrame headless test → npm run check (type-check + vitest) → live tmux + tshot.sh
screenshot → vision_analyze the PNG → subagent re-verify`. glitch explicitly asks for the
subagent re-verify step.

---

## 1. Runtime facts for the fork (do NOT trust generic Bun advice blindly)

The `opentui-app-engineering` skill describes a **bare-Bun** runtime. **The Hermes OpenTUI fork
does NOT run bare Bun** — it bundles via esbuild and runs on **Node 26.3 with `--experimental-ffi`**.
Reconcile as follows:

| Concern | The fork's reality |
|---|---|
| Runtime | Node **26.3** (`~/.local/share/fnm/node-versions/v26.3.0/installation/bin`), `--experimental-ffi --no-warnings` |
| Build | `node scripts/build.mjs` (esbuild bundle → `dist/main.js`). There IS a build step (contrast bare-Bun "no build step"). |
| Engine deps | `@opentui/core` / `@opentui/solid` / `@opentui/keymap` **0.4.1**, `solid-js` 1.9.12, `effect` 4.0.0-beta.78 |
| Gate | `cd ui-opentui && unset NODE_ENV && npm run check && node scripts/build.mjs` — **always `unset NODE_ENV`** or npm install skips devDeps and the build silently breaks. A fresh worktree has NO `node_modules` → `npm install` first (a TS2688 "Cannot find type definition file for 'node'" is the missing-deps tell, not a real error). |
| Headless test | `createTestRenderer` + `captureCharFrame` — the Solid binding (`@opentui/solid`), with the effect-tick `setTimeout(150)` dance from the skill. |

So when the skill says "run under `bun`", for THIS repo read it as "run under the Node-26.3 +
`--experimental-ffi` toolchain via the build script." The API gotchas (attributes bitmask, flat
spans, onSubmit cast) all still apply — they're `@opentui/core`-level, runtime-independent.

---

## 2. The fork engine's file map (verified, with the seams you'll touch)

```
ui-opentui/src/
├── entry/main.tsx          # boots the app; wires SlashContext openers (e.g. an /prompt opener)
├── logic/                  # plain-Solid logic layer (REUSE/extend, don't rewrite)
│   ├── slash.ts            # ★ the slash router. CLIENT map @795, SlashContext iface @53,
│   │                       #   CLIENT_HELP_LINES @254, dispatchSlash @895, handleDispatchResult @861
│   ├── store.ts            # the Solid store reducer (applyNow switch, infoPatchFrom)
│   ├── history.ts          # /history rendering (timestamps go here)
│   ├── theme.ts / termChrome.ts / notify.ts / ...
├── view/                   # Solid view layer (rewrite natively against OpenTUI primitives)
│   ├── App.tsx             # outer <Switch> for full-screen overlays (a <Match> per overlay)
│   ├── composer.tsx        # the input composer (Ctrl+G editor open lives near here)
│   ├── reasoningPart.tsx   # thinking render — the /reasoning full|clamp expand target
│   ├── sessionInfo.tsx / statusBar.tsx / transcript.tsx / messageLine.tsx
│   └── overlays/           # agentsDashboard, billing, picker, pager, sessionPicker, ...
├── boundary/               # Effect boundary (Schema decode, transport, renderer lifecycle)
│   ├── schema/GatewayEvent.ts   # add a Schema.Struct AND register in toTaggedUnion (both!)
│   ├── schema/SessionInfo.ts    # new session.info field via opt(...)
│   └── gateway/ ...
└── test/                   # vitest (captureFrame render tests live here)
```

**Server side (shared by BOTH engines — already merged on `46139f051`):**
- `tui_gateway/server.py`:
  - `_mirror_slash_side_effects(sid, session, command)` @**10243** — runs a slash command in the
    `_SlashWorker` subprocess then mirrors the side-effect into the live agent. Already contains
    the merged `/compress` summary (@10312 `summarize_manual_compression`) and the dead
    `reload-mcp` branch (@10358, see §4).
  - `reasoning_full` toggle @**8399-8430** (maps `/reasoning full` → thinking expanded).
  - `refresh_agent_mcp_tools` wired @**3802** (per-turn prologue) and @**8970** (reload path) —
    the upstream MCP late-binding fix.
  - `_emit_session_info_for_session` @2837 / `_emit_title_refresh` @5231 (the `/title` conflict
    we resolved during the refresh — see PR #8 body).

---

## 3. THE BACKLOG — 12 commits, classified by real port difficulty

**Key insight that changes everything:** OpenTUI's `dispatchSlash` (`logic/slash.ts:895`) **already
falls through to `slash.exec`** for any command not in the `CLIENT` map, and **already displays the
returned `output` + `warning`** via `present()`. It ALSO already has the `command.dispatch`
fallback with `handleDispatchResult` (@861). So a chunk of these are server-side-done and either
"verify-only" or "display-polish", NOT full ports. Verify each against a live run before assuming
work is needed.

### Tier 0 — Verify-only (server-side fix flows through OpenTUI for free)

| Commit | Feature | Why likely free | What to verify |
|---|---|---|---|
| `169952563` | route pending-input (`/goal`,`/retry`,`/queue`,`/q`,`/steer`,`/plan`,`/undo`) via `command.dispatch` | Server `slash.exec` now routes these internally; OpenTUI's `dispatchSlash` already has the `command.dispatch` fallback (`handleDispatchResult` @861) | Type `/goal X` in a live OpenTUI session → it must NOT surface "empty command" and must apply. Check `handleDispatchResult`'s `prefill` case (@884) for `/undo`. |
| `c7e8854cb` | persist session on force-quit / signal shutdown | The fix is in `tui_gateway/server.py` `_finalize_session()` + `entry.py` `_log_signal` — **shared by both engines** | Confirm OpenTUI's quit/signal path goes through the same `_finalize_session`. Force-quit mid-turn (double Ctrl-C) and confirm messages persisted to state.db. **Ties to §5 session finalization.** |

### Tier 1 — Display/catalog polish (logic flows through `slash.exec`; needs help-catalog + display semantics)

| Commit | Feature | Server status | OpenTUI work |
|---|---|---|---|
| `d0de4601d` | `/compress` before/after summary | DONE server-side (`_mirror_slash_side_effects` @10312 returns the summary text) | Verify the returned summary actually renders (it should via `present()`). If `/compress` is in the CLIENT map as `compactCmd`, check `compactCmd` (@589) returns/echoes the server summary instead of swallowing it. **`/compact` and `/compress` may differ — reconcile.** |
| `5ff11a689` | `/timestamps [on\|off\|status]` (alias `/ts`) + `[HH:MM]` in `/history` | Toggle persists `display.timestamps`; uses the sanctioned non-wire `timestamp` key (stripped before API by `4467c22c8`) | (a) Register `/timestamps`+`/ts` in completion catalog/help. (b) Render `[HH:MM]` on message labels (`messageLine.tsx`) + in `/history` (`logic/history.ts`) for turns carrying a stored unix ts; NEVER fabricate one for live unsaved turns. Mind cache/alternation: the `timestamp` key must stay non-wire. |

### Tier 2 — Real client ports (need `$EDITOR` / expand-state / submit wiring)

| Commit | Feature | Ink source | OpenTUI work |
|---|---|---|---|
| `9e96e7099` | `/prompt` (alias `/compose`) — compose next prompt in `$EDITOR` | `ui-tui/src/app/slash/commands/core.ts` wires `openEditor` into the slash handler; `useMainApp.ts` exposes it | OpenTUI **already has an editor-open via Ctrl+G** (find `openEditor`/editor logic near `composer.tsx`). Add a `CLIENT['prompt']`/`CLIENT['compose']` handler that calls the existing editor opener, seeding inline `arg` text. Follow `hermes-overlay-port.md` if it needs a SlashContext opener wired in `entry/main.tsx`. |
| `74f0dd62e` | Ctrl+G **submits** the edited draft on save (was: just load it back) | Ink's `openEditor` submits on clean exit | Find OpenTUI's Ctrl+G handler; on clean editor exit, **submit** the buffer (`ctx.submit(...)`) through the same idle/queue/slash branches the Enter handler uses; drop an empty save. |
| `95d53c3bc` | `/reasoning full\|clamp` — show complete thinking | Server maps `full → thinking expanded` (@8399-8430); Ink maps to `sections.thinking=expanded` raw/uncapped | OpenTUI renders thinking in `reasoningPart.tsx`. The text path flows through `slash.exec`, BUT "full" is a **render-state change** (expand the thinking section uncapped), not just a message. Wire `/reasoning full|clamp` to toggle the OpenTUI thinking-section expand state + honor persisted `display.reasoning_full` at boot. Add to help/catalog. |

### Tier 3 — Mode-guards & input-engine specifics

| Commit | Feature | OpenTUI work |
|---|---|---|
| `a7983d5ad` | hide sidecar sessions from history | Server marks the real `source` on the row but its deny-list is `frozenset({"tool"})` only (`server.py:4596` + `:4825`) — it does NOT deny `sidecar`. OpenTUI's `sessionPicker.ts` `INTERACTIVE_SOURCES=['cli','tui','acp']` excludes sidecar, but the "All" tab omits the `sources` param so sidecar rows DO show. **Fix (recommend server-side, fixes both surfaces): add `"sidecar"` to the deny `frozenset` at both lines.** Alternative: client-side deny in `sessionPicker.ts`. Mirrors Ink's `ChatSidebar` filter. |
| `a7b4fbcbc` | guard `/update` against hosted dashboard mode | Ink refuses `/update` under `DASHBOARD_TUI_MODE` (PTY death bricks the embedded tab). **Relevant — the dashboard embeds the TUI.** Add the same guard to OpenTUI's `/update` handler (does OpenTUI even have `/update`? If not, ensure it can't reach the `dieWithCode(42)` path under hosted mode). |
| `857d0244a` | handle dispatch payloads from slash exec | Ink reworks `createSlashHandler.ts` payload handling. Compare to OpenTUI's `handleDispatchResult` (@861) — it already handles `exec/plugin/alias/skill/send/prefill`. Verify no payload shape is dropped; add any missing case. |
| `ab8f06381` + `e52fffb60` | disable fast-echo bypass inside tmux / tmux-flavored TERM (cursor drift) | Ink-specific `textInput.tsx` fix. **OpenTUI has its OWN input component** — check whether it has a fast-echo bypass that drifts under tmux/SSH-from-tmux; if so, port the TERM-detection guard. If OpenTUI has no fast-echo bypass, this is N/A (document that). |

---

## 4. MCP changes — DEEP COMPARE + REVIEW (glitch: "any and all MCP changes should land")

The batch's MCP work is the **upstream fix for the exact `/reload-mcp` no-op bug documented in
the `opentui-fork-ops` skill** (`references/mcp-tools-missing-and-reload-noop.md`). Compare
carefully:

**What upstream added (already merged on `46139f051`):**
- `refresh_agent_mcp_tools(agent, ...)` in `tools/mcp_tool.py` — rebuilds **BOTH** `agent.tools`
  AND `agent.valid_tool_names`, published together. Wired into:
  - the **per-turn prologue** `build_turn_context` (`agent/turn_context.py`) — `371348387`,
    cache-safe (only extends a fresh request prefix at a turn boundary, never mutates an in-flight
    cached prefix). Called in `tui_gateway/server.py` @3802.
  - the reload path @8970.
- `has_registered_mcp_tools()` cheap guard so no-MCP sessions skip the rebuild.
- Adversarial-review rounds 1-3 (`b6e2a54a9`, `88d523220`, `f3e967aae`): cache parity, gates,
  stale-publish race, generation-capture adjacency.

**The fork's still-broken bit:**
- `_mirror_slash_side_effects` @10358 has `elif name == "reload-mcp" and agent and
  hasattr(agent, "reload_mcp_tools"): agent.reload_mcp_tools()` — **`reload_mcp_tools` is STILL
  undefined anywhere** (verified: `grep -rn 'def reload_mcp_tools'` returns empty). So `/reload-mcp`
  remains a NO-OP on OpenTUI (the status bar flips to `mcp: 1` but the live agent's tool list never
  refreshes → "Tool 'mcp_granola_...' does not exist").

**The decision / work for the porter:**
- **Good news:** with `refresh_agent_mcp_tools` now auto-firing in the per-turn prologue, late MCP
  tools become callable on the user's NEXT turn **automatically** — `/reload-mcp` is largely
  unnecessary. This likely **closes the documented OpenTUI MCP bug** without engine changes. VERIFY
  this end-to-end: start a session with a slow MCP server, type before it connects, confirm the
  tool is callable on the next turn with NO manual reload.
- **Still fix the dead branch** (cleanliness + the explicit-reload affordance): point the
  `reload-mcp` branch at the real rebuild. Cleanest: have it call `refresh_agent_mcp_tools(agent)`
  (which exists and does the right both-lists rebuild) instead of the non-existent
  `agent.reload_mcp_tools()`. Factor into a shared helper so the per-turn path and the manual path
  can't drift. Mirror Ink's dedicated `reload.mcp` RPC if you want full parity (Ink's
  `ui-tui/src/app/slash/commands/ops.ts` calls `.rpc('reload.mcp', params)` →
  `server.py @method("reload.mcp")` which rebuilds both lists).
- **Cache-safety review:** any reload that runs MID-conversation must only extend a fresh request
  prefix at a turn boundary (like the prologue path), NEVER mutate the cached prefix of an in-flight
  turn. This is "prompt caching is sacred" — the load-bearing fork constraint. Confirm the manual
  reload respects it.

Full prior diagnosis: `opentui-fork-ops` skill →
`references/mcp-tools-missing-and-reload-noop.md`.

---

## 5. In-place compaction & session finalization — ADAPT to the session-id model (glitch: important)

These are **core changes with gateway/TUI ripples** — exactly the cross-cutting case glitch flagged
("if a core change changes gateway/Ink behaviour, catch it and implement in OpenTUI").

### 5a. In-place compaction (`47fadc24d` + `466345699` + `1fbf48d4a`) — IMPLEMENT on the session-id model

- **What it is:** `compression.in_place` flag (default **False**). When True, compaction rewrites
  the transcript + rebuilds the system prompt but **keeps the SAME `session_id`** — no
  `end_session`, no child row, no title renumber, no contextvar/logging re-sync. Soft-archives the
  pre-compaction turns (`messages.active=0`, the `/undo` mechanic) so they're recoverable +
  FTS-searchable; the live load filters `active=1`. This is upstream's fix for the TUI sid-desync
  bug cluster (incl. `#36777`).
- **Why the fork cares:** the OpenTUI engine tracks `session_id` for the window-title chrome
  (`boundary/schema/SessionInfo.ts`), the session picker, and resume. The rotation path (flag off)
  changes the sid mid-conversation — which is what desyncs the OpenTUI sidebar/title. In-place
  compaction keeps one durable id, which is the model the OpenTUI engine WANTS.
- **Work:**
  1. Confirm `compression.in_place` defaults False (verified on the merge) so taking the batch is a
     no-op for the running fork.
  2. Decide (with glitch) whether to **default it ON for the OpenTUI engine** — it fixes the
     fork's own sid-desync pain. If so, set it via the OpenTUI launcher/config path, not globally.
  3. Verify the OpenTUI store/sidebar/title behave correctly when a compaction fires WITHOUT a sid
     change (the happy path) — the rotation handling in `logic/store.ts` (`parent_session_id`
     child re-propagation) should be a no-op when the id is stable. Render-verify the sidebar +
     window title survive an in-place compaction.
  4. Confirm session_search still finds soft-archived turns (the durability contract).

### 5b. Session finalization (`b17180d95` + `9e4fe32d3`) — IMPLEMENT carefully

- **What it is:** finalization funnels through `AIAgent.close()` (single terminal path), so finished
  agents stop leaving `ended_at IS NULL` rows. `end_session()` is first-reason-wins; `/resume`
  calls `reopen_session()` so resumability survives. The background-review fork opts out
  (`_end_session_on_close=False`) so it doesn't end the live parent mid-conversation.
- **Why the fork cares:** the `tui_gateway` **owns** SQLite sessions per its `_session_db` /
  `_ensure_session_db_row` path. `c7e8854cb` (Tier 0) already changed `_finalize_session()` to
  flush + fire `on_session_end` — that interacts with this.
- **Work:**
  1. Audit the fork's `tui_gateway/server.py` session lifecycle (`_finalize_session`,
     `_end_session_on_close`, `_session_db`, the `_finalized` flag at `_find_live_session_by_key`)
     against the merged finalization-on-close behavior. Confirm no double-finalize and no premature
     finalize of a live OpenTUI session.
  2. Confirm OpenTUI resume (`logic/resume.ts`) still works after finalize-on-close (relies on
     `reopen_session()`).
  3. Render-verify: open an OpenTUI session, run a turn, quit cleanly AND force-quit; confirm the
     row is finalized once, messages persisted, and a subsequent `/resume` reopens it.

---

## 6. Suggested execution order

1. **Tier 0 verify-only** (`169952563`, `c7e8854cb`) — cheapest; likely removes 2 from the list.
2. **MCP §4** — verify the auto-refresh closes the documented bug; fix the dead `reload-mcp` branch.
3. **Tier 1** (`/compress` display, `/timestamps`) — small display/catalog work.
4. **Tier 2** (`/prompt`, Ctrl+G-submit, `/reasoning full`) — real client ports, one at a time
   with the full render-verify ladder.
5. **Tier 3** (sidecar filter, `/update` guard, dispatch payloads, fast-echo-tmux) — guards +
   input-engine specifics.
6. **§5 in-place compaction + session finalization** — the careful cross-cutting core ripples;
   do last, with the most thorough render + resume + search verification.
7. Then `sid/opentui` can advance to the full batch (glitch runs the public push/merge).

## 7. Gate / verify commands (copy-paste)

```bash
# Build env (every shell)
export PATH="$HOME/.local/share/fnm/node-versions/v26.3.0/installation/bin:$PATH"; unset NODE_ENV

# Engine gate
cd ui-opentui && ([ -d node_modules ] || npm install) && npm run check && node scripts/build.mjs

# Headless render test (Solid + captureCharFrame) — see opentui-app-engineering skill for the
# effect-tick setTimeout(150) dance; put the verifier in src/ and run from there.

# Live tmux render-verify (see tmux-pane-screenshot skill)
tmux new-session -d -s otui -x 120 -y 34
tmux send-keys -t otui "cd <gateway-or-cli-clone> && hermes --tui" Enter
sleep 20 && ~/.claude/skills/tmux-pane-screenshot/scripts/tshot.sh otui:0.0 /tmp/otui.png 2
# then: vision_analyze /tmp/otui.png ; remember slash autocomplete eats the FIRST Enter (send twice)

# Python gate (the upstream clone's .venv has pytest + full optional deps)
source ~/github/hermes-agent/.venv/bin/activate; export TZ=UTC LANG=C.UTF-8 PYTHONHASHSEED=0
python -m pytest tests/test_tui_gateway_server.py -o 'addopts=' -q -p no:cacheprovider
```

## 8. Invariants to never violate (from `opentui-fork-ops` + AGENTS.md)

- **Prompt caching is sacred** — no mid-conversation cache-prefix mutation, no toolset swap
  mid-turn, no system-prompt rebuild mid-conversation (only compression may alter context). Every
  MCP/compaction change here must respect this.
- **Strict message-role alternation** — never two same-role messages in a row; never a synthetic
  user message mid-loop. The `timestamp` key (`/timestamps`) must stay non-wire (stripped before
  the API call).
- **Never advance `sid/opentui` to a non-green tree.** All work in a throwaway worktree; the live
  branch moves only on a green gate. When unsure, defer.
- **Never restart glitch's gateway from inside an agent session** (self-kill) — hand off the
  `systemctl --user restart hermes-gateway-daimon.service` step.
- **Public/destructive git is glitch's** — stage local, hand off push/merge.

---

## 9. HOW TO WORK THESE TASKS — the proven method (from the Part A session, 2026-06-22)

This is the workflow that produced the Part A code change cleanly. Mirror it for Part B. It
combines four skills: `subagent-driven-development` (the controller/implementer loop),
`adversarial-review-loop` (Claude Code per-task review + `/simplify`), `hermes-agent-dev` (codebase
conventions), and the three OpenTUI skills in §0 (for any `ui-opentui/` work).

### 9.1 The shape of the work (read this first — it changes how you scope)

Part B tasks fall into THREE buckets, and **most are NOT green-field code**. Before writing
anything, classify each task — this is the single biggest time-saver:

- **Verify-only** — the server-side fix already flows through; you just confirm behavior. (Part A
  example: the sidecar "fix" turned out to be a non-bug — see 9.6.)
- **Display/catalog polish** — logic already flows through `slash.exec` → `present()`; you wire the
  command into the completion catalog and confirm the output renders.
- **Real client port** — genuine new Solid view/logic in `ui-opentui/` (`/prompt`, `/reasoning
  full`, Ctrl+G-submit). These are the only ones that need the full implementer + render-ladder loop.

A task you assumed was a port is often verify-only once you read the real code. **Do the recon
before you dispatch an implementer.**

### 9.2 Controller-driven loop (you are the controller; subagents are leaves)

The pattern, per task:

1. **SPIKE first (controller does this directly, read-only).** Before any code, run a focused
   recon to (a) confirm the bug/feature premise against the real tree, (b) find the exact insertion
   point(s) with `file:line`, and (c) decide verify-only vs port. Use `execute_code` to batch
   several `terminal`/`grep`/`sed` reads in ONE call — this session closed all four Part A spikes
   (MCP, sidecar, fast-echo, finalization) in ~4 batched calls. Pin every claim to a line number.
   **Verify the premise BEFORE writing code** (AGENTS.md rule). Two of four Part A "tasks"
   evaporated at the spike stage (sidecar non-bug; finalization composes correctly) — that's the
   spike doing its job.
2. **Dispatch ONE implementer subagent** for the actual code task (never parallel implementers —
   they conflict). Give it the FULL task text inline (don't make it read the plan), the spike's
   `file:line` findings as `context`, scoped toolsets, and tell it to load the relevant skill.
3. **Verify the self-report yourself.** Re-read the actual edit (`sed`/`read_file`), re-run the
   tests from the controller — do NOT trust the subagent's pasted "all green." Confirm `git status`
   shows only the intended file (no lockfile/pycache churn).
4. **Adversarial review with Claude Code** (per-task, not per-phase). See 9.4.
5. **Fix → re-review** until the round's findings degrade to nits. Then `/simplify` (9.5).
6. Mark the todo done, move to the next task.

### 9.3 Subagent dispatch recipe (what actually worked)

For a hermes-agent **Python/gateway** code task (e.g. the MCP fix), the `delegate_task` call that
worked:
- **`toolsets: ["file", "search", "terminal", "skills"]`** — `skills` so it can load
  `hermes-agent-dev`; `terminal` to run tests.
- **`context`** must contain: the worktree path + "cd there first", "load `hermes-agent-dev`
  skill", "git blame the lines before editing", the **no-`.venv` fact** ("use
  `~/github/hermes-agent/.venv/bin/python -m pytest <file> -o 'addopts=' -q -p no:cacheprovider`,
  NOT scripts/run_tests.sh"), "edit with the `patch` tool", file sizes ("server.py is ~11.6k lines,
  read only the regions you need"), the cache-safety constraint, and **"Respond in English"** +
  **"DO NOT git commit or git add"**.
- **`goal`** = the full self-contained task: the bug, the exact fix with the canonical pattern to
  mirror (with `file:line`), numbered REQUIREMENTS, and a VERIFY block (AST parse + grep proof +
  the exact pytest command + expected baseline counts). Tell it to report DONE / DONE_WITH_CONCERNS
  / BLOCKED and to document any judgment call in a code comment + its report.
- For a `ui-opentui/` **Solid/view** task, ALSO include the OpenTUI skills in the context and tell
  it to `skill_view(name="opentui", ...)` + `skill_view(name="opentui-app-engineering")` BEFORE
  writing (the `attributes`-bitmask bug is what guessing-without-docs produces).
- **Fix loop:** when review finds an issue, dispatch a FRESH subagent with the precise finding (tell
  it "you are FIXING an in-progress uncommitted edit, not starting fresh; read the current file
  state first"). Don't fix manually (context pollution) unless it's a one-line nit.

### 9.4 Adversarial review with Claude Code (the per-task gate)

- Small diff (< ~5k lines) → **pipe context+diff via stdin**: `cat /tmp/ctx.md | claude -p
  --dangerously-skip-permissions --max-turns 12 '<focused prompt>' 2>/dev/null > /tmp/review.md`.
- **ALWAYS tell it: "Do NOT spawn sub-agents / do not use the Task tool (it deadlocks headless)."**
  This is the #1 way a headless `claude -p` review hangs with zero output.
- Give it the diff + the reference code to verify against (`file:line` ranges), and ask for
  PROBLEM / EVIDENCE(file:line) / FIX, "blocking vs nit", and an explicit "No remaining issues
  found" when clean.
- **Round-over-round:** tell each round what the prior round fixed and to report only NEW issues.
  Convergence = findings degrade (round 1 real bug → round 2 subtle → round 3 nit/already-correct).
  Part A converged in 3 rounds: round 1 caught a **real blocking bug** (the fix omitted the
  load-bearing `shutdown_mcp_servers()` + `discover_mcp_tools()` calls — would've shipped another
  no-op), round 2 clean, final round "ready to commit."
- **Triage every finding against the real code before accepting** — but this session all findings
  verified true (the reviewer read the actual tree). Don't blindly obey a reviewer whose suggestion
  contradicts a green tested contract; document the divergence instead.

### 9.5 `/simplify` (run after review converges, on a fix/feature diff — NOT on a pure refactor)

- `/simplify` is interactive — run it in **tmux**, not `-p` (it's a slash command):
  `tmux new-session -d -s simplify ...; claude --dangerously-skip-permissions`, then
  `tmux send-keys` the `/simplify the uncommitted change in <file> (lines …); this is a bug-fix,
  NOT a refactor — only behavior-preserving simplifications, do NOT spawn sub-agents`.
- **Wait ~2 min** (it churns at high effort). Capture with `tmux capture-pane -p -S -150`.
- **DANGER:** after it answers, the prompt sits waiting — do NOT let a stray `commit this` (or any
  text in the captured pane) get an Enter. **`tmux kill-session` immediately** once you've read the
  output; then confirm `git log` shows NO new commit. (This session a `commit this` appeared in the
  pane; killing the session before any Enter prevented an unwanted commit.)
- Expect `/simplify` to mostly return "already minimal" on a tight fix. It correctly flags
  out-of-scope refactors (e.g. "extract a shared helper across both call sites") — **do NOT apply
  those** on a bug-fix; note them as follow-ups (over-reach is a real failure mode).

### 9.6 The premise-verification lesson (saved 3 dead-code commits in Part A)

Three of the four Part A scrutiny items were **non-bugs once verified against the tree** — and the
adversarial reviewer's own finding (B2 sidecar) was built on a wrong premise. Before "fixing"
anything in Part B, prove the premise:
- **Sidecar filter** — assumed sidecar sessions carry `source: "sidecar"`. They carry
  `source: "tool"` (web `ChatSidebar.tsx` passes `"tool"`), which is ALREADY deny-listed. No
  `"sidecar"` label exists anywhere → adding one is dead code. The OpenTUI "All" tab already hides
  them (server deny-list applies even when `sources` is omitted). NO CHANGE.
- **Session finalization** — `_finalize_session` (`tui_gateway/server.py:389`) is `_finalized`-
  guarded and ends the row; the core `b17180d95` `AIAgent.close()` also ends it, but `end_session`
  is **first-reason-wins** (run_agent.py:3257) → no double-finalize. `_teardown_session` finalizes
  THEN closes, so the TUI reason wins. NO CHANGE.
- **fast-echo-tmux** (`ab8f06381`) — OpenTUI's input has NO fast-echo bypass (`grep` empty) → the
  Ink fix is N/A; advancing cannot introduce cursor drift. NO CHANGE.
- **in-place compaction** — `compression.in_place` defaults False; the engine already decodes
  `session.info.compressions`. NO engine change to ADVANCE (default-ON is a separate decision).

The rule (AGENTS.md): if you can't point to the exact line where the bug manifests AND show your
fix changes that line's behavior, you haven't verified the premise. A confirmed reproduction on the
real tree beats a plausible-sounding rationale every time.

### 9.7 How the to-dos were structured (the controller's todo list)

Keep the controller `todo` list as the spine. The Part A structure that worked:
1. One **push/setup** item (push docs + branch).
2. One **SPIKE** item per scrutiny area (MCP, sidecar, fast-echo, finalization) — collapse to DONE
   with the one-line verdict (e.g. "fast-echo N/A — no bypass").
3. One **CODE** item per real code task, with a **paired REVIEW** item right after it
   (verify + Claude Code adversarial + `/simplify`). Don't batch reviews.
4. A **final gate** item (engine + python + integration review) and a **hand-off** item (commit
   local → glitch pushes/merges).
Mark spikes done with their verdict so a non-bug is visible as resolved, not silently dropped. Only
ONE item `in_progress` at a time.

### 9.8 Pre-existing flake to expect (not yours)

Running the whole `tests/tui_gateway/` dir in ONE pytest process surfaces a test-ordering failure
(`test_goal_command.py::test_goal_set_returns_send_with_notice`) that **passes in isolation** and
reproduces on the clean merged tree. It is upstream cross-file state pollution, not a regression —
the canonical `scripts/run_tests.sh` avoids it via per-file subprocess isolation (but that wrapper
needs a `.venv` the worktree lacks; the upstream-clone venv runs everything in one process). When
you see it, run the single test alone to confirm it's the flake, and/or stash your change and re-run
the batch on the clean tree.

### 9.9 Hand-off boundary

Stage all code as LOCAL commits on the throwaway/PR branch. The PUSH and the PR MERGE are glitch's
public steps (he was burned before — hand off, don't execute) UNLESS he explicitly says "push it"
this session. Never restart his gateway from inside a session (self-kill) — emit the
`systemctl --user restart hermes-gateway-daimon.service` command for him.
