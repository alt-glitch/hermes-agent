# Plan — Part A: Advance `sid/opentui` to the full upstream batch

> **Scope:** Take the refreshed 463-commit defer batch (PR #8, head `46139f051`) onto the live
> `sid/opentui` branch, per glitch's decision model. This plan covers the CORE + GATEWAY +
> MCP + COMPACTION + FINALIZATION surface (the "merge it" side). The Ink-TUI **feature ports**
> are Part B (`docs/handoffs/opentui-part-b-gateway-tui-feature-ports.md`) and GATE this plan's
> final step.
>
> **Decision model (glitch, 2026-06-22):**
> - **Core agent loop = hardened.** Running on upstream `main` ⇒ safe to merge. Take as-is.
> - **Gateway + Ink TUI = scrutinize, adapt, port.** Catch any behavior change and mirror it
>   into the OpenTUI fork.
> - **Cross-cutting:** a CORE change that alters gateway/Ink behavior downstream must be caught
>   and implemented in OpenTUI too.
> - **Specifically adapt+implement:** in-place compaction (on the session-id model), session
>   finalization (carefully), and ALL MCP changes (deep compare + review).
>
> **Skills governing this plan:** `opentui`, `opentui-app-engineering`, `tmux-pane-screenshot`
> (same three as Part B — load before any engine work), plus `opentui-fork-ops` (the merge/gate/
> ship plumbing) and `adversarial-review-loop` (for the review gate).

---

## 0. The structural reality (why this is a sequencing problem, not a cherry-pick)

The batch is **one merge commit** (`46139f051`) carrying 463 upstream commits. Subset-advance is
*mechanically possible* (staged sub-range merges, `git revert -m` of unwanted subtrees, advancing
to intermediate tags) — but we **CHOOSE** to advance the whole merge because: (a) it is a verified
**strict fast-forward** over live `sid/opentui` (`git merge-base --is-ancestor c31219a72 46139f051`
→ exit 0; live is 0 commits ahead), (b) the core is upstream-hardened per glitch, and (c) the 463
commits are deeply interdependent, so subset-reverts would be high-risk surgery for low value. This
is a deliberate choice, NOT a claim that incremental advance is impossible.

So Part A is NOT "merge a subset"; it is:

1. **Accept** the core surface as hardened (no per-commit review — glitch's call).
2. **Scrutinize** the gateway + tui_gateway + MCP + compaction + finalization surface for behavior
   changes the OpenTUI engine must adapt to.
3. **Port / verify** the gating Ink-TUI surface (Part B) so advancing doesn't ship a regressed TUI.
4. **Advance** live only when the **regression surface** is green (see §8 — split gate).

The merge + conflict resolution + gate is ALREADY DONE and green on `46139f051`
(857 engine tests, build OK, 310 tui_gateway py tests). **But this green is the BASELINE merge
gate** — every Part B adaptation re-opens it; the advance bar is green on the **final adapted tree**
(§8), not on the un-adapted merge.

---

## 1. Surface inventory (verified counts on the batch)

| Surface | Commits | Treatment | Where |
|---|---|---|---|
| Core agent loop (`run_agent.py`, `agent/`, `model_tools.py`) | ~51 | **ACCEPT (hardened)** | §2 |
| `gateway/` (messaging gateway) | 81 | **SCRUTINIZE** (mostly backend; not OpenTUI-facing) | §3 |
| `tui_gateway/` (shared TUI backend — DIRECTLY affects OpenTUI) | 14 | **DEEP SCRUTINIZE** | §4 |
| MCP (`tools/mcp_tool.py`, `agent/turn_context.py`, tui_gateway MCP) | ~6 | **DEEP COMPARE + REVIEW** | §5 |
| In-place compaction (`agent/conversation_compression.py`, `hermes_state.py`) | 2 | **ADAPT to session-id model** | §6 |
| Session finalization (`run_agent.py`, `agent/agent_init.py`, `agent/background_review.py`, `gateway/run.py`) | 3 | **IMPLEMENT carefully** | §6 |
| Ink-TUI features (`ui-tui/`, CLI commands) | 12 | **PORT (Part B — GATES the advance)** | Part B doc |

---

## 2. CORE — accept as hardened (no per-commit gate)

Per glitch: on upstream `main` ⇒ safe. The ~51 core commits (failover identity, strict-provider
message hygiene, token-calibration reset, tool-output budget scaling, error-path summarization)
are taken as-is. **The only core obligation in this plan is the cross-cutting ripple check (§2a)** —
because some core changes alter gateway/TUI behavior.

### 2a. Core→gateway/TUI ripples to CATCH (the cross-cutting rule)

A core change is NOT "just core" if it changes a downstream contract the OpenTUI engine observes.
The ripples identified in the batch:

| Core/shared commit | Downstream ripple → OpenTUI obligation |
|---|---|
| `c884ff64e` failover identity sync | Rewrites cached system-prompt model identity on failover. OpenTUI's `session.info` carries `model` (status bar / window title). **Verify** the OpenTUI status bar shows the FALLBACK model after a failover, not the stale primary. |
| `371348387` MCP per-turn tool refresh | Late MCP tools become callable next turn. OpenTUI's tool catalog / `/reload-mcp` affordance is affected → §5. |
| `b17180d95` finalize-on-close | `AIAgent.close()` now finalizes the session row. OpenTUI's `tui_gateway` owns sessions → §6b. |
| `1965d5621` / `1e0b3a2bc` budget+calibration on model switch | Combined with `fad4b40d9` (persist /model) + `99f3072aa` (failed swap = no-op) + `04730f32e` (preflight-compress warning), the OpenTUI model picker must surface the warning and handle a no-op swap → §4. |

These ripples are tracked in §4-§6; none require touching the core itself.

### 2b. Other cache/alternation-adjacent core commits — scanned, confirmed safe (informed acceptance)

So the "accept wholesale" decision is INFORMED, not blind, these batch commits that touch the
cached prompt / message alternation / toolset were scanned and confirmed cache/alternation-safe
(adversarial review, 2026-06-22, file:line-verified against the merged tree):
- `c884ff64e` failover identity — byte-identical restore on `restore_primary_runtime`, never
  persisted; **all 9 failover sites** (incl. the later `f22dd8a75` auth-failover) sync the in-flight
  system message. Genuinely cache-safe.
- `5ff11a689` `/timestamps` + `4467c22c8` strip-timestamp — `timestamp` is a sanctioned non-wire
  key, added only to the current-turn tail (not the prefix) and stripped before the wire on the
  pass-through transport; block-building transports (anthropic/bedrock/codex) never leak it.
- `14ef6312b` decay `protect_first_n` — compression path only (AGENTS.md's explicit cache exemption).
- `b892ee2bc` summarize non-retryable errors — error-result content only; no synthetic mid-loop
  user message, no system-prompt change. Alternation-safe.
- `ca92e9a36` (gateway max_iterations refresh), `5bf23ff25` (banner advertising) — int/cosmetic
  only; neither touches prompt/messages/tools.

---

## 3. GATEWAY (`gateway/`, 81 commits) — scrutinize, but mostly NOT OpenTUI-facing

The gateway runs the messaging platforms (Telegram/Discord/etc.) and the background-process
watcher. The OpenTUI CLI/TUI does NOT route through `gateway/run.py` (it routes through
`tui_gateway/`). Adversarial review confirmed the TUI-facing gateway commits are ALL already
captured in §4/§5/§6; the remaining ~70 are genuinely non-TUI-facing backend hardening (V-009 path
traversal, MCP-persistence surface, media-size caps, delivery/platform fixes, credential isolation,
delegation fan-out) that **lands for free** with no OpenTUI adaptation.

**Plan action:** No OpenTUI adaptation for `gateway/`. **One regression check:** glitch runs the
daimon + xenia gateway profiles from this engine — after advancing, confirm the gateway still boots
clean (`systemctl --user status` + a smoke message). Eyeball the two most likely to surface a
behavior delta on his running profiles: the session-hygiene limit raise (`03563daba` 400→5000) and
the in-flight-transcript-persist on restart (`d19aabbf2`).

---

## 4. `tui_gateway/` (14 commits) — DEEP SCRUTINIZE (shared OpenTUI backend)

This is the highest-leverage bucket: every commit here changes OpenTUI behavior because the engine
talks to this backend. Map each to its OpenTUI obligation (most are also Part B items):

| Commit | What changed in tui_gateway | OpenTUI obligation |
|---|---|---|
| `b9b4756ab` | dashboard chat session titles (the `/title` conflict we resolved) | Already resolved in the refresh (unified on `_emit_session_info_for_session`). Verify window-title chrome still updates. |
| `95d53c3bc` | `/reasoning full` server mapping | Part B Tier 2 — wire expand state. |
| `99f3072aa` | failed in-place model swap = no-op (not dead session) | **Verify** OpenTUI model picker handles a failed swap gracefully (no dead session). |
| `d0de4601d` | `/compress` before/after summary | Part B Tier 1 — verify display. |
| `c7e8854cb` | persist on force-quit/signal | Part B Tier 0 + §6b — verify shared path. |
| `1ca29723f` | consistent TUI `warning` field on preflight | OpenTUI already reads `warning` in `dispatchSlash` — verify it surfaces. |
| `04730f32e` | preflight-compress warning on model switch | §2a ripple — verify OpenTUI picker shows it. |
| `a7983d5ad` | hide sidecar sessions from history | Part B Tier 3 — session-picker filter. |
| `b6e2a54a9`, `93d6e7302`, `98ecd0bee` | MCP late-connect exposure + cache-parity | §5. |
| `b0e47a98f` | honor managed scope in standalone config loaders | **Verify** OpenTUI's config reads (skin, display prefs) honor managed scope; no OpenTUI-specific loader bypasses it. |
| `fad4b40d9` | persist `/model` switch by default across sessions | **Verify** OpenTUI's `/model` (modelCmd @520 in slash.ts) persists; if it has its own switch path, confirm it writes the persisted key. |
| `169952563` | pending-input via command.dispatch | Part B Tier 0 — verify. |

**Plan action:** §4 is the spine of Part B's verify-only + display tiers. Work it as part of Part B;
nothing here can advance live until its OpenTUI side is verified.

---

## 5. MCP — deep compare + review (glitch: all MCP changes must land)

(Full detail in the Part B handoff §4.) Summary for Part A:
- **Accept** the core MCP fixes (`371348387` per-turn refresh, `93d6e7302` late-connect exposure,
  adversarial rounds `b6e2a54a9`/`88d523220`/`f3e967aae`).
- **Cache-safety — precise invariant (adversarial review correction):** `refresh_agent_mcp_tools`
  (`tools/mcp_tool.py:4480`) is cache-safe against **in-flight turn corruption** (it only rebuilds
  at a turn boundary, before that turn's `tools=` prefix is assembled). It is NOT "cache-safe by
  construction" in the stronger sense: a tool-membership delta (add OR remove) re-derives the whole
  **name-sorted** `tools=` block, which costs a prompt-cache reset for the rest of the conversation.
  This is ACCEPTED because (i) additions are the intended late-connect fix (a one-time cold cache
  when a genuinely new tool appears) and (ii) removals must not strand a dead tool the model will
  call. Tool removal is reachable (`mcp_tool.py:1599` list-changed, `:2408` disconnect/timeout).
- **Verify** the per-turn auto-refresh CLOSES the fork's documented `/reload-mcp` no-op bug
  end-to-end (slow MCP server, type before connect, callable next turn, no manual reload). **AND**
  verify the SHRINK path: kill a connected MCP server mid-session, take a turn — no crash, dead tool
  gone, no stale-tool call (this path is currently untested).
- **Fix** the still-dead `reload-mcp` branch in `_mirror_slash_side_effects` @10358 (point it at
  the real `refresh_agent_mcp_tools(agent)` rebuild — note it re-injects post-build tool families
  via `_reinject_post_build_tools`, so a naive rebuild would strip mem0/honcho/lcm_* tools; factor
  a shared helper; mirror Ink's `reload.mcp` RPC @8915 for parity).

This is a hard gate on the advance (glitch's explicit ask).

---

## 6. Compaction + finalization — adapt (glitch: important)

### 6a. In-place compaction (`47fadc24d`, `466345699`, `1fbf48d4a`) — IMPLEMENT on the session-id model
- **Three** commits, not two (adversarial review caught the missing one): `47fadc24d` adds the
  flag, `466345699` makes it soft-archive (non-destructive), **`1fbf48d4a` makes it durable +
  rotation-independent end-to-end** — it durably replaces the transcript via
  `replace_messages(session_id, compressed)` (`agent/conversation_compression.py:548`), sets
  `agent._last_compaction_in_place` + `in_place=True` on the internal `session:compress` event, and
  makes manual `/compress` actually rewrite in in-place mode. `1fbf48d4a` is what makes resume +
  search load-bearing (not cosmetic).
- Defaults `compression.in_place: False` (verified) → no-op for the running fork when advanced.
- **Decide with glitch** whether to default it ON for the OpenTUI engine (it fixes the fork's own
  sid-desync). If yes, set via the OpenTUI launcher/config path, not globally.
- `in_place` is a **Python event-bus** signal (context-engine), NOT a tui_gateway wire field — the
  engine learns of compaction via `session.info.compressions` (`logic/store.ts:413`), which it
  already decodes. **No new schema field required.**
- Render-verify (now load-bearing because of `1fbf48d4a`): a compaction with a STABLE sid keeps the
  OpenTUI sidebar + window title correct (rotation re-propagation in `store.ts` is a no-op when the
  id doesn't change); **resume after in-place compaction reloads the durable compacted transcript**;
  **`session_search` still finds the soft-archived (`active=0`) turns**.

### 6b. Session finalization (`b17180d95`, `9e4fe32d3`, + `c7e8854cb`) — IMPLEMENT carefully
- Audit `tui_gateway/server.py` lifecycle (`_finalize_session`, `_end_session_on_close`,
  `_session_db`, `_finalized`) against finalize-on-close. No double-finalize; no premature finalize
  of a live OpenTUI session; `/resume` still reopens via `reopen_session()`.
- Render-verify: clean quit AND force-quit both finalize once + persist messages; `/resume` reopens.

### 6c. Sidecar filter (`a7983d5ad`) — real client work, NOT free (adversarial review correction)
- The server deny-list is `frozenset({"tool"})` at `server.py:4596` AND `:4825` — it does **NOT**
  include `"sidecar"`. The server only RECORDS the real `source` on the row; "hide from history"
  lives client-side (Ink: `web/src/components/ChatSidebar.tsx`). OpenTUI's `sessionPicker.ts`
  `INTERACTIVE_SOURCES=['cli','tui','acp']` excludes sidecar, BUT its "All" tab omits the `sources`
  param, so the server returns sidecar rows → **a sidecar session WILL show in the OpenTUI All tab.**
- **Fix (recommend server-side, fixes both surfaces uniformly):** add `"sidecar"` to the deny
  `frozenset` at `server.py:4596` + `:4825`. Alternative: client-side deny in `sessionPicker.ts`.

---

## 7. Execution sequence (RISK-FIRST — the two real unknowns before the cheap polish)

Sequenced so the work most likely to invalidate the plan (lifecycle + MCP) is resolved FIRST,
not last. The display/feature polish is low-information (it almost certainly works) — doing it
first tells us nothing about whether the plan holds.

```
[DONE]  S0. Merge batch + resolve conflicts + baseline gate green (46139f051).
[DONE]  S1. Refresh PR #8 in place (handed off the public push).
        --- RISK-FIRST SPIKES (resolve the unknowns that can force engine rework) ---
        S2. §6b finalization + §6a in-place-compaction SPIKE: audit lifecycle, render+resume+
            search verify. The only data-loss / session-corruption blast radius — fail fast here.
        S3. MCP §5: verify auto-refresh closes the /reload-mcp bug + the SHRINK path; fix dead branch.
        S4. R-FASTECHO (§9): determine whether OpenTUI's input shares the fast-echo bug (`ab8f06381`)
            — the one item that can make a currently-fine TUI WORSE. Resolve early.
        --- THEN the regression-surface verifies + the cheap polish ---
        S5. Tier-0 verify (§4): pending-input dispatch (`169952563`), force-quit persist (`c7e8854cb`).
        S6. Tier-1 display (§4): /compress display intact, /timestamps.
        S7. Tier-2 client ports: /prompt, Ctrl+G-submit, /reasoning full (each w/ render ladder).
        S8. Tier-3 guards: sidecar filter (§6c), /update guard, dispatch payloads.
        --- GATE + ADVANCE ---
        S9.  Full engine gate (npm run check + build) + Python gate green on the FINAL adapted tree.
        S10. ADVERSARIAL REVIEW of the whole adapted tree (per-task, not batched).
        S11. glitch advances sid/opentui (public ff/merge) → task B of opentui-fork-ops to ship.
```

S2-S8 are Part B work driven by the Part B handoff; this plan's Part-A-specific value is the
risk-first ordering + the split gate (§8) + the ripple inventory (§2a/§2b).

**Note on the gate split:** S2-S6 (the REGRESSION surface) are the HARD gate. S7-S8 (net-new
features that don't exist on live today and therefore can't *regress* anything) are a SOFT
follow-on — see §8.

## 8. Definition of done — SPLIT GATE (regression-hard vs feature-soft)

The plan's bar for "advance live" is **no regression of existing behavior**, NOT "feature-complete."
A net-new upstream feature that doesn't exist on the live fork cannot regress by advancing — at
worst it's absent, exactly as today. So:

### HARD GATE (must ALL be green to advance — these are existing behaviors that could regress)
- Engine gate green (`npm run check` + `node scripts/build.mjs`) on the FINAL adapted tree.
- Python gate green (`tui_gateway` + touched modules) via the upstream-clone `.venv` pytest.
- **MCP not-worse:** documented `/reload-mcp` bug verified closed (or no-op); dead branch fixed;
  the membership-shrink/disconnect path verified (no crash, no stale-tool call).
- **Compaction:** in-place verified on the sid model (sidebar/title intact, resume reloads the
  durable compacted transcript, `session_search` finds soft-archived turns); default decision made.
- **Finalization:** clean quit + force-quit both finalize-once + persist; `/resume` reopens.
- **`/compress` display** not swallowed (existing command — output must still render).
- **Fast-echo:** confirmed NOT newly-broken under tmux on OpenTUI (no cursor drift introduced).
- **Gateway smoke:** daimon + xenia profiles boot clean after advance.
- All review findings of severity ≥ minor are fixed OR explicitly accepted-with-rationale by glitch
  (accept list in the PR body). *(Not "converged to NITs" — that's unfalsifiable.)*
- **Rollback ref recorded:** the pre-advance `sid/opentui` SHA is captured and a one-command revert
  path is documented in the handoff (this is glitch's DAILY DRIVER — the safety net is mandatory).

### SOFT FOLLOW-ON (land incrementally AFTER advancing — net-new features, can't regress)
- `/prompt`, `/timestamps`, `/reasoning full`, Ctrl+G-submit, `/update` hosted-guard. Each ported
  on its own schedule with the full render ladder (captureFrame → tmux + tshot → vision_analyze →
  subagent re-verify).

**If glitch prefers ONE atomic advance** (less public-git churn, one review, one gateway restart),
keep the maximal gate and land all features first — but that's a *preference*, not a correctness
requirement. Default recommendation: advance on the HARD gate, port features after.

## 9. Open items — DECISIONS vs VERIFIES vs REAL RISKS

### Decisions glitch must make
- **D1 (was R3):** In-place compaction default — ON for the OpenTUI engine or leave OFF? (It fixes
  the fork's own sid-desync; recommend ON via the OpenTUI launcher/config path.)
- **D2:** Atomic advance (all features first) vs split gate (advance on regression-green, port
  features after)? (§8 — recommend split.)

### Verify-steps (5-minute yes/no checks, not standing risks)
- **V1 (was R1):** OpenTUI's `/model` (`modelCmd`/`switchModel` in `slash.ts`) honors
  `fad4b40d9` persist-by-default (writes the persisted key, no bypass path).
- **V2 (was R2):** No OpenTUI config-loader bypasses `b0e47a98f` managed-scope (grep the engine's
  config reads).

### Real risks (genuine technical unknowns with regression teeth)
- **R0 — ripple completeness (the load-bearing one):** the §2a ripple table is ASSUMED exhaustive,
  and the whole "accept core as hardened, no per-commit review" gamble rests on it. "Accept core" is
  fine for *core* behavior but NOT automatically fine for *downstream contracts* the OpenTUI engine
  observes. Mitigation: a targeted diff scan of the ~51 core commits for any touch to a
  `session.info` field / `tui_gateway` RPC / gateway event the engine reads — not a trust-the-table
  pass. (Adversarial review confirmed §2a + the tui_gateway-14 list are complete *as found*; R0 is
  the residual "did we enumerate everything" risk.)
- **R1 — fast-echo (promoted from R4):** if OpenTUI's input has a fast-echo bypass, advancing could
  INTRODUCE cursor drift under tmux/SSH-from-tmux (`ab8f06381`). The one item that can make a
  currently-fine TUI worse. Resolve in S4, early.
- **R2 (was R5):** gateway in-flight-transcript-persist (`d19aabbf2`) + session-hygiene raise
  (`03563daba` 400→5000) — any behavior delta glitch's running daimon/xenia profiles would notice?

---

## 10. Adversarial review record (2026-06-22, 3 parallel orthogonal-lens reviewers)

Three `delegate_task` subagents reviewed v1 of this plan against the real merged tree
(`46139f051`): (1) merge-strategy + cache-safety, (2) cross-cutting ripple completeness, (3)
simplicity/YAGNI/sequencing. All findings verified against source before applying (zero false
positives — reviewers read the actual tree with file:line/git evidence).

### Valid findings — addressed in this revision
| # | Finding | Where fixed |
|---|---|---|
| B1 | Missing 3rd in-place-compaction commit `1fbf48d4a` (durable + rotation-independent; makes resume/search load-bearing) | §6a + Part B §5a |
| B2 | Sidecar deny-list is `frozenset({"tool"})` only (`server.py:4596`/`:4825`) — OpenTUI sidecar filter is real client work, not free | §6c + Part B Tier 3 |
| Strat-F2 | `371348387` "cache-safe by construction" overstated — membership delta (esp. removal) re-derives the name-sorted `tools=` block → cross-turn cache reset | §5 (precise invariant + shrink-path verify) |
| Simp-F1 | All-12-features gate conflates "not broken" with "feature-complete"; net-new features can't regress | §8 split gate (hard regression vs soft follow-on) |
| Simp-F2 | Riskiest work (compaction/finalization) sequenced LAST — should be risk-first | §7 reordered (S2-S4 spikes first) |
| Simp-F3 | DoD "converged to NITs" unfalsifiable; no rollback criterion for the daily driver | §8 (concrete accept-list + mandatory rollback ref) |
| Simp-F4 | Risk list mixed decisions/verifies/risks; missing R0 ripple-completeness; fast-echo under-ranked | §9 restructured (D1-D2 / V1-V2 / R0-R2) |
| Simp-F5/F6 | §3 hash-catalog over-spec; "green" framing undersold the re-opened gate | §3 compressed; §0 baseline-vs-final note |
| Strat-F1 | §0 "can't cherry-pick" false dichotomy (conclusion right, reasoning wrong) | §0 reworded (deliberate choice, not impossibility) |

### Confirmations (the plan's load-bearing claims, verified correct)
- Advance is a **strict fast-forward** (`c31219a72` is the merge-base of `46139f051`; live 0 ahead).
- The **tui_gateway-14 commit list is exact**; MCP diagnosis verified to the line (`reload_mcp_tools`
  still undefined; `refresh_agent_mcp_tools` @4369 rebuilds both `tools` + `valid_tool_names`).
- `c884ff64e` genuinely cache-safe (byte-identical restore); all **9** failover sites synced.
- **No NEW wire event / `session.info` field** is introduced by the batch (the engine's
  GatewayEvent/SessionInfo schemas need no new variant for this advance).
- "81 gateway commits mostly not OpenTUI-facing" is justified — all TUI-facing ones are in §4/§5/§6.

### Pre-existing (NOT batch ripples) — backlog, out of scope for this advance
- The engine drops several pre-existing `session.info` fields it never decodes (`service_tier`,
  `yolo`, `credential_warning`, `system_prompt`, …) and the `preview.restart.*` events — all
  pre-date the batch; ticket separately only if a future status-bar feature wants them.
