---
name: opentui-tui-engineering
description: Modify and verify Hermes ui-opentui using native Solid rendering, typed Effect boundaries, ordered transcript state, and the shared Python gateway.
---

# Hermes native TUI engineering

Read the candidate's `ARCHITECTURE.md` and scoped `AGENTS.md`. This profile-local
edition replaces accumulated historical instructions; old examples are reference
material, not current contracts. Inspect the installed versions in
`ui-opentui/package-lock.json`; the September 2026 baseline uses Node 26.3,
OpenTUI 0.4.1, Solid 1.9.12 and Effect 4 beta78. Do not assume newer research
checkouts match those APIs.

## Find the owner

- Launch/build/source selection: `hermes_cli/main_tui_launch.py` and siblings.
- Native bootstrap: `ui-opentui/src/entry/`; Effect resources/transport:
  `src/boundary/`; JSON-RPC decoding: `src/boundary/schema/`.
- Ordered messages, identity, queues and derived data: `src/logic/`.
- Solid/native rendering and input: `src/view/`. Consult `opentui` skill docs for
  native components, layout, keymap and test-renderer APIs.
- Shared backend: `tui_gateway/methods_*.py`, callback/event publisher/replay
  modules. Ink and Desktop also consume this boundary; test their contracts.

## Preserve these behaviors

Do not concatenate assistant text across user/steer/tool boundaries. Ordered
parts are the transcript truth. Queue acknowledgement is not consumption; keep
the visible marker until the actual consumption event, in its correct position.
Reset/resume clears session-owned derived state and guards late old-session
events. Keep transcript windowing; avoid remounting the whole transcript on each
delta or updating immutable historical rows for a spinner tick.

Decode external input once. Invalid optional metrics can be omitted individually;
required identity/events must not silently become defaults. Solid owns reactive
view state; Effect owns scoped asynchronous resources and typed I/O failures.
Do not introduce a second transport, renderer, transcript model or keymap system.

Terminal rows are geometry, not browser CSS. Give scrollable content a bounded
viewport, prevent shrink/overlap, and test wheel as well as keyboard scrolling.
Measure native renderable height rather than assuming text is one row. Handle
resize and narrow terminals. A loading shell must not pretend session hydration
is complete. Preserve composer input and focus across async results.

## Verification loop

Load `terminal-control` for actual screen assertions. Run the candidate explicitly
in an owned session/profile. Reproduce the old state, patch the owning boundary,
run focused contracts and drive the same real interaction. Include cancellation,
resize or interleaving when that is the change's risk; do not invent a giant
mandatory matrix for every edit. `npm run check` and `npm run build` remain the
full native gates. Require actual test execution; keep host concurrency low.

Use `before-and-after` for visible PR evidence with termctrl captures. A live
image proves appearance at one point; event/state tests prove ordering and reset
invariants. Keep both when the bug needs both. Report unsupported or untested
paths explicitly. For current reference research and cleanup decisions load
`opentui-maintainer`'s engineering reference rather than duplicating it here.
