# Native OpenTUI development checks

Reviewed 2026-09-06 against OpenTUI docs/source `7581976f4d2c917fd5ae5266c8bc61f0e44fc933`.
Hermes pins core/solid/keymap 0.4.1; check the lock and installed declarations
before adopting a newer recipe. Reference checkouts are not runtime upgrades.

| Surface | Read | Hermes practice / verification boundary |
| --- | --- | --- |
| Testing | [Testing](https://opentui.com/docs/core-concepts/testing/) | Pure reducer tests first; native frames for layout/input. `renderOnce` forces paint; mounted `waitForFrame` observes scheduled work. Tests own renderer cleanup even when initial settling rejects. A seeded frame is not a streaming test. |
| Rendering diagnostics | [Rendering diagnostics](https://opentui.com/docs/test-and-debug/rendering-diagnostics/), [troubleshooting](https://opentui.com/docs/test-and-debug/troubleshooting/), [native crashes](https://opentui.com/docs/test-and-debug/native-crashes/), [console](https://opentui.com/docs/core-concepts/console/) | Record candidate/runtime identity and the failing frame. Separate frame scheduling, native cell changes, layout, RSS and transport symptoms. Existing file/ring logging intentionally avoids opening an allocating console during failure. No permanent diagnostic frame loop. |
| Messages and tables | [Markdown](https://opentui.com/docs/components/markdown/), [table implementation](https://opentui.com/scrollback/fixing-markdown-tables/), [TextTable](https://opentui.com/docs/components/text-table/) | Reuse `view/markdown.tsx`: native incremental Markdown, finalization and table layout. Preserve block identity during append. Do not turn Markdown into plain text to satisfy an under-initialized test. Direct TextTable JSX is not registered by installed Solid. |
| Source and patches | [Code](https://opentui.com/docs/components/code/), [Diff](https://opentui.com/docs/components/diff/), [line numbers](https://opentui.com/docs/components/line-number/) | Reuse native file-tool components, one diff per file. A gutter is source navigation, not a prose requirement. Verify multiple files and grammar-unavailable fallback. |
| Input and activity | [Keymap addons](https://opentui.com/docs/keymap/addons/), [animation](https://opentui.com/docs/application-apis/animation/), [notifications](https://opentui.com/docs/core-concepts/notifications/) | The default keymap factory already installs its addons; bindings have scoped cleanup. An agent execution timeline is data, not an animation Timeline. Keep busy timers scoped and replay time frozen. Native notification attempts do not prove OS delivery. |
| Clipboard | [Clipboard](https://opentui.com/docs/core-concepts/clipboard/) | Client terminal and process-host clipboard are different destinations. Reads need byte/deadline bounds; remote host writes need explicit policy. Audit found these gaps plus Screen/tmux framing and overconfident copy feedback in the existing clipboard boundary; they are not repaired by the agents-view change. The newer unified clipboard service is absent from 0.4.1. |
| Distribution | [Packages](https://opentui.com/scrollback/packages/), [deploy](https://opentui.com/docs/ship/deploy/), [standalone executables](https://opentui.com/docs/reference/standalone-executables/) | Hermes ships a Node ESM bundle with core/native assets external. Verify actual FFI startup, platform/libc artifacts and failed-refresh rollback. New SEA asset exports and the newer documented Node floor are not drop-in requirements for this pin. |

## `/agents` acceptance loop

Trace actual child callback → parent/child gateway events → decoded store →
mounted native view → immutable replay. Display switches for ordinary tool
progress must not suppress primary agent lifecycle/messages. Spinner/activity
previews are not the same channel as actual supplied model reasoning.

Exercise two staggered siblings and a nested child, reply/reasoning/tool
interleaving, a failure, final completion, and old replay records. Assert stable
agent/message IDs, truthful timing, retained-text bounds and explicit loss
disclosure. No invented completion percentages or inferred missing reasoning.

Drive wide and narrow layouts, height resize, wheel/keyboard/scrollbar input,
selection during updates, reader scroll-up versus bottom-follow, and replay
control locks. Native Markdown finalizes on terminal transitions. A missing
end time must not turn a finished agent into an endlessly growing bar.

Use a fresh termctrl PTY with sanitized fixture data for matched before/after
frames, plus a separate isolated real-Hermes callback run. Label those proofs
separately: a synthetic renderer fixture does not prove model/provider delivery;
a successful backend run does not prove the view painted. Retain exact commands,
exit codes, source SHA and recordings, then run check/build and independent review.
