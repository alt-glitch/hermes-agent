# Plan — OpenTUI composer/UX batch (10 features)

> **STATUS: SHIPPED (2026-06-13).** All 10 features implemented, gate green
> (ui-opentui 714 tests + 316 gateway + 25 cost tests), F5/F6 verified live via
> tmux screenshot. Commits: `f4dacc68e` (F1/F2/F7/F8/F8b/F9/F10), `20d516ae9`
> (F4/F5/F6), `9aa5e54be` (F3). Decisions taken: **D1 = cursor-aware onType**
> (threaded `ta.cursorOffset`); **D2 = chrome cost is Nous-header-only via a new
> `nous_header_cost_usd`, `/usage` page kept full via `real_session_cost_usd`**.
> F10 (right-pinned cwd) was added mid-session by the user.

**Branch:** `feat/opentui-native-engine` · **Engine:** `ui-opentui/` (Node 26)
**Gate:** `cd ui-opentui && PATH="$HOME/.local/share/fnm/node-versions/v26.3.0/installation/bin:$PATH" npm run check` → exit 0.

## TL;DR

Nine UX fixes for the native composer + clarify prompt. **8 of 9 are front-end-only**
in `ui-opentui/`; only F3 (cost) touches the Python gateway. Every backend the new
behaviour needs (`shell.exec`, `complete.path` with `@file:`/`@folder:`/fuzzy) **already
exists** — most of this is client wiring, not new RPC surface. No new core tools, no new
`HERMES_*` env vars, no prompt-cache impact (composer/prompt are client-render only).

| # | Symptom | Fix site | Backend |
|---|---|---|---|
| F1 | bare `/` opens the modal | `logic/slash.ts:115` `planCompletion` | none |
| F2 | `/abs/path` text triggers slash | `logic/slash.ts:115` + `logic/skillMatch.ts` | none |
| F3 | cost wrong / shows for non-Nous | `tui_gateway/server.py` + `agent/usage_pricing.py` | gateway |
| F4 | can't paste until composer focused | `view/composer.tsx` onPaste/focus | none |
| F5 | clarify ugly (no wrap, weak diff, "Other" is a row) | `view/prompts/clarifyPrompt.tsx` rewrite | none |
| F6 | clarify arrows scroll the transcript | same rewrite (preventDefault) | none |
| F7 | slash highlight/menu dies after line 1 | `logic/slash.ts:114` | none |
| F8 | file mention dies after line 1 | `logic/slash.ts:114` | none |
| F8b | `@` should be the ONLY file-mention trigger | `logic/slash.ts:93` `isPathLike` | none |
| F9 | `!cmd` → run bash, show result | `entry/main.tsx` submit + new system render | uses existing `shell.exec` |

---

## F1 + F2 + F7 + F8 + F8b — the completion trigger (`logic/slash.ts`)

All five live in one ~10-line function, `planCompletion` (slash.ts:113-121). Current:

```ts
export function planCompletion(text: string): CompletionPlan | null {
  if (text.includes('\n')) return null                                   // ← F7/F8 die here
  if (text.startsWith('/')) return { from: 0, method: 'complete.slash', params: { text } } // ← F1/F2
  const word = /(\S+)$/.exec(text)?.[1]
  if (word && isPathLike(word)) { ... complete.path ... }                // ← F8b: too many triggers
  return null
}
```

### F1/F2 — slash only for a real command token
- A bare `/` (no char yet) must **not** query. Require `/` + at least one name char.
- A `/abs/path` (slash followed by a path with more `/`) is **not** a command — it's
  text. The slash menu should only fire when the FIRST token matches the command
  grammar (`/[A-Za-z0-9][\w.-]*` — the `NAME_RE` already in skillMatch.ts:51, which
  excludes `/`). `/usr/bin` fails NAME_RE → no slash menu.
- Concretely: replace `text.startsWith('/')` with: the text starts with `/`, and the
  first whitespace-delimited token after the `/` is non-empty AND matches `NAME_RE`
  (i.e. `/m`, `/model foo` → yes; `/`, `/usr/bin`, `/./x` → no). Reuse `slashTokens`
  /`NAME_RE` from skillMatch.ts so the trigger and the highlighter share one grammar.

### F7/F8 — completion must survive newlines (shift+enter)
- `if (text.includes('\n')) return null` is the bug. It was a blunt guard so a multi-line
  paste wouldn't spam path-completion. The right rule operates on the **current line /
  current token at the cursor**, not the whole buffer.
- The composer passes the full `plainText` to `onType`. We don't currently pass the
  cursor offset. **Decision D1 (below):** either (a) thread the cursor offset into
  `onType` and complete the token under the cursor, or (b) cheap interim — slice to the
  **last line** (`text.slice(text.lastIndexOf('\n')+1)`) and run the existing logic on
  that. (a) is correct (mid-buffer edits), (b) is 1 line and covers the reported case
  (typing at the end on line N). Recommend (a) for correctness; it also future-proofs
  @-mention mid-line.
- Slash *highlighting* (skillMatch.ts `slashTokens`) **already scans multi-line text
  correctly** (it iterates the whole string, newline-aware via `nativeCharOffset`). So
  F7's "highlighting stopped" is really the same `planCompletion` newline bail starving
  the menu; the highlight token itself still styles. Verify in the live smoke.

### F8b — `@` is the only mention trigger
- `isPathLike` (slash.ts:93) currently returns true for `@`, `~`, `./`, `../`, `/`, or
  any word containing `/`. The user wants **`@`-only** (drop `~`/`./`/bare paths as
  mention triggers). Narrow it to `word.startsWith('@')`.
- The gateway `complete.path` (server.py:8543) already special-cases `@` richly
  (`@file:`, `@folder:`, `@diff`, `@staged`, `@url:`, `@git:`, fuzzy basename search).
  Its `~`/`./` branches become dead trigger paths from this TUI — leave the gateway code
  (Ink still uses the path forms; it's shared) but stop emitting those queries from
  ui-opentui. **No gateway change.**
- Net: typing `@` (even bare) opens the mention menu via the `@`-bare branch at
  server.py:8555. Picking splices `@file:rel/path` etc. (existing accept path,
  `completionFrom` honoured).

**Tests:** extend `test/slash.test.ts` — `planCompletion('/')` → null; `planCompletion('/usr/bin')`
→ null; `planCompletion('/model')` → complete.slash; multi-line `"a\n/mod"` → complete.slash
on the trailing token; `"~/foo"` / `"./x"` → null (no longer path-like); `"@foo"` → complete.path.
Keep them as behaviour assertions, not snapshots.

---

## F3 — cost: Nous-portal headers only (`tui_gateway` + `agent/usage_pricing.py`)

**Current:** `_get_usage` (server.py:2157-2167) sets `cost_usd` from
`real_session_cost_usd(agent)` (usage_pricing.py:887), which sums **two** provider-reported
sources:
1. `agent.session_actual_cost_usd` — OpenRouter `usage.cost` accumulator.
2. `agent.get_credits_spent_micros()` — Nous `x-nous-credits-*` header delta.

The TUI already **hides** the cost segment when `cost_usd` is absent (statusBar.tsx:241-243,
`costText` returns '' when `costUsd === undefined`) — so this is purely "which sources count."

**User's intent (F3):** cost should come **only from the Nous portal headers**; suppress it
for every other route (cache-token pricing is unreliable across the model long tail).

**Change:** make the OpenRouter accumulator source conditional on the route being Nous, OR
drop source #1 entirely so only the header delta (source #2) feeds `cost_usd`. Source #2 is
intrinsically Nous-only (the header only exists on Nous-portal responses), so dropping #1
achieves "Nous-header-only" with one edit.

> **DECISION D2 (needs glitch's confirm):** Drop OpenRouter's `session_actual_cost_usd`
> source from `real_session_cost_usd`? Trade-off: OpenRouter's `usage.cost` is itself
> *provider-reported* (the real charged number, not a Hermes estimate), so OR users lose an
> accurate readout. But it removes the cache-token guesswork the user is worried about and
> matches "only via the headers when using nous portal" literally.
> **Recommended default (implementing unless told otherwise):** gate source #1 so it only
> contributes when the active route is the Nous portal (base_url == nous inference api),
> else it's dropped. This keeps the segment Nous-only AND avoids touching shared OR/CLI
> behaviour for the `/usage` page. If even Nous-route OR-accumulator is unwanted, collapse
> to header-only.

**Scope guard:** `real_session_cost_usd` is also consumed by `/usage` page rendering
(server.py:2237) and DB usage totals. Prefer a NEW, status-bar-specific helper
(e.g. `nous_header_cost_usd(agent)`) wired only into `_get_usage`'s `cost_usd`, leaving the
`/usage` accounting page untouched — so we don't regress the full cost report. Confirm with
the gate + a gateway unit test (`tui_gateway` tests) that a non-Nous session yields no
`cost_usd`.

---

## F4 — paste while composer unfocused (`view/composer.tsx`)

**Current:** the global keyboard handler reclaims focus on a *printable keystroke*
(`isPrintableKey`, composer.tsx:415-417). A **bracketed-paste event is not a keystroke** —
it arrives at `onPaste` only if the textarea is focused, so an unfocused composer drops it;
the user has to click/type first.

**Fix:** the renderer delivers paste through the focused renderable. Two options:
- (a) Keep focus on the composer more aggressively (opencode keeps the prompt focused via a
  reactive effect). Risky — fights transcript scroll focus.
- (b) **Recommended:** handle paste at the renderer/global level. Check whether OpenTUI
  exposes a global paste hook (`renderer.on('paste')` or a keyboard event with
  `key.name === 'paste'` / a paste event type). If a global paste signal exists, on paste:
  `ta.focus()` then route the bytes into the existing `onPaste` logic (image / placeholder /
  insert). **Must verify the API in the `opentui` skill before coding** (skill_view
  references/docs). If only the focused-renderable paste exists, fall back to (a) scoped:
  refocus the composer whenever no overlay/prompt is open and focus drifted (a
  `createEffect` watching focus + `store.state.prompt`/overlay state).

**Verify in live smoke** (tmux + tmux-pane-screenshot): scroll the transcript to drop focus,
then paste — text must land without a prior click.

---

## F5 + F6 — clarify prompt rewrite (`view/prompts/clarifyPrompt.tsx`)

<!-- no-tmp: ok — records the historical screenshot path from the design review, not a command to run -->
Screenshot `/tmp/screenshots/SCR-20260613-iznq.png` confirms: long options run off the right
edge (no wrap), options differ only by `▶`/`—` glyphs (no numbers, weak), and "✎ Other…" is
a `<select>` row that *switches* to an input on Enter rather than being an inline input.

**Current:** one native `<select>` over `[...choices, {Other}]` (clarifyPrompt.tsx:61-75).
Native `<select>` doesn't wrap long rows and (F6) doesn't `preventDefault` arrows, so they
leak to the transcript scrollbox.

**Rewrite plan (verify renderable API in `opentui` skill first):**
- Replace native `<select>` with a **custom keyboard-driven list** (a `For` over options +
  a `selected` signal + `useKeyboard` with `key.preventDefault()` on up/down/enter — same
  pattern the composer's `routeMenuKey` uses; F6 fixed by preventDefault so arrows never
  reach the scrollbox).
- **Wrapping (F5):** render each option as a `<text>` that wraps to the box width (no fixed
  single-line). Indent continuation lines under the option label. Confirm `<text>` soft-wrap
  behaviour in the opentui skill (it wraps by default within a flex box of bounded width).
- **Differentiation (F5):** number every option `1.` `2.` … (digit hotkeys optional, nice-to-
  have), and give the selected row the themed `selectionBg` + accent fg (the composer's
  `completionCurrentBg` model), not just a glyph. Number + background + accent = three signals.
- **Inline custom answer (F5):** render the `<input>` **inside the same screen, always
  present** as the last "row" (an `Other:` labeled input), instead of an item that toggles.
  Selecting/focusing it lets the user type; Enter in it submits the free text. Keep the
  existing `clarify.respond {answer}` wiring. Arrow-down past the last choice lands on the
  input; arrow-up from the input returns to the list (focus handoff like the composer↔tray).
- Keep Esc/Ctrl+C → cancel (clarifyPrompt.tsx:31-33).

**Reference:** opencode's selection/list components in `~/github/opencode/packages/tui` for
the wrap + highlight + hotkey idiom; the composer dropdown (composer.tsx:441-458) for the
in-repo highlight/selectable pattern.

**Tests:** `test/render.test.tsx`-style headless frame — long option wraps (frame contains the
tail of a long choice on a 2nd line), selected row shows numbered + highlighted, custom input
present in the same frame, arrow keys don't change scrollTop (assert transcript scroll
unchanged), Enter on a choice → onAnswer(choice), Enter in input → onAnswer(typed).

---

## F9 — `!cmd` runs bash (`entry/main.tsx` + a system render)

**Backend exists:** `shell.exec` (server.py:10301) runs the command (30s timeout, dangerous/
hardline-command guards, returns `{stdout, stderr, code}`).
**Ink parity reference:** `ui-tui/src/app/useSubmission.ts:291` — `full.startsWith('!')` →
`shellExec(full.slice(1).trim())` → appends a user line `!cmd` + a system line with output;
the prompt glyph flips while the buffer starts with `!` (appLayout.tsx:178).

**Plan (ui-opentui):**
- In the entry `submit` (main.tsx:517-520), add a branch BEFORE the slash check:
  `if (text.startsWith('!')) { runShell(text.slice(1).trim()); return }`.
- `runShell(cmd)`: `store.pushUser('!' + cmd)` (echo the invocation in the transcript), then
  `gateway.request('shell.exec', { command: cmd })`; on resolve, `store.pushSystem` the
  combined `stdout`/`stderr` (or the error message / non-zero `code`); on reject,
  pushSystem the error. Detached `runFork` like `submitPrompt`. No session turn, no model call.
- Empty `!` (just the bang) → no-op (or a hint), matching Ink.
- **Optional polish (parity, not required):** flip the composer prompt glyph (or tint) while
  the buffer starts with `!`, like Ink's appLayout. Low-risk; do only if cheap.

**Tests:** entry-level/logic test that a `!`-prefixed submit routes to `shell.exec` (not
`prompt.submit`), and the system line renders stdout. Mirror the slashMenu.test harness
(fake gateway capturing the method).

---

## Sequencing & fences (subagent-driven; disjoint files)

Parallel-safe groups (disjoint file fences):
1. **slash trigger** — `logic/slash.ts` (+ `logic/skillMatch.ts` reuse) + `test/slash.test.ts`. (F1/F2/F7/F8/F8b)
2. **clarify** — `view/prompts/clarifyPrompt.tsx` + a clarify test. (F5/F6)
3. **shell-exec** — `entry/main.tsx` (edit DIRECTLY — load-bearing) + system render + test. (F9)
4. **paste focus** — `view/composer.tsx` (edit directly; verify opentui paste API first). (F4)
5. **cost** — `tui_gateway/server.py` + `agent/usage_pricing.py` + gateway test. (F3) — Python, isolated.

`entry/main.tsx` and `store.ts` are edited directly, never via subagent (handoff rule).
Each renderable change: `skill_view(opentui, references/docs/...)` FIRST. Verify every
subagent self-report (re-run `npm run check` exit code, read the diff).

## Open decisions (need glitch)
- **D1 (F7/F8):** thread cursor offset into `onType` (correct) vs. last-line slice (cheap)?
  Recommend cursor offset.
- **D2 (F3):** drop OpenRouter cost source entirely, or gate it to the Nous route? Recommend
  Nous-route gate via a status-bar-only helper, leaving `/usage` accounting intact.

## Invariants to preserve
- Per-conversation prompt caching untouched (all client-render or post-hoc gateway usage).
- No new `HERMES_*` env var (these are behaviour, not secrets).
- Strict no change-detector tests — assert behaviour/invariants.
- Don't regress the `/usage` accounting page when narrowing the chrome cost source.
