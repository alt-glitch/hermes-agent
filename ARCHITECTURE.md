# Architecture

Hermes runs one Python agent core behind several user interfaces. This fork adds
a native OpenTUI interface and a guarded maintenance workflow; it does not add a
second agent core. This map describes the present boundaries, not a promise of
complete Ink parity. Read the nearest `AGENTS.md` for editing rules and search
the symbols below for implementation details.

## The system at a glance

```text
CLI / messaging gateway / cron ──────────────┐
                                           v
Terminal → OpenTUI or Ink → tui_gateway → AIAgent → provider adapters
                               ^           └────→ tools / plugins
                               │                    │
Desktop / dashboard ───────────┘             sessions / memory / skills
```

TypeScript owns presentation and local interaction. Python owns model calls,
tool execution, approvals, authoritative session history and persistence.
`tui_gateway` is shared by terminal, desktop and dashboard consumers; a backend
change is not inherently OpenTUI-only. The messaging `gateway/` and the TUI
`tui_gateway/` are different hosts, even when they use the same agent and profile.

## Where to change what

| Concern | Start here | Boundary |
| --- | --- | --- |
| Agent execution and context | `run_agent.py` (`AIAgent`), then its `agent/` collaborators | The facade composes extracted behavior; do not rebuild the former monolithic loop. |
| Provider and credential resolution | `hermes_cli/runtime_provider.py` (`resolve_runtime_provider`), `runtime_provider_custom.py`, `runtime_provider_backends.py`; provider adapters in `agent/` | Resolve provider, endpoint, credentials and wire protocol together. Model name alone is not a transport contract. |
| Tools and extension discovery | `tools/registry.py`, `model_tools.py`, `toolsets.py`, `plugins/` | Most capability belongs in existing tools, skills or plugins; every core tool adds recurring model context. |
| Durable conversations | `hermes_state.py` (`SessionDB`), `tui_gateway` session methods | Renderer state and acknowledgements are not a substitute for persisted history. |
| CLI/config/launch | `hermes_cli/main.py`, `main_tui_launch.py`, `opentui_runtime.py`, `commands.py` | Engine selection, interpreter selection, workspace cwd and profile selection are distinct decisions. |
| Messaging and scheduled execution | `gateway/`, `cron/` | Hosts own admission, delivery and scheduling; the agent owns the conversation. |
| UI protocol | `tui_gateway/server.py`, `methods_*.py`, `event_publisher.py`, `event_replay.py` | Server is a facade over topical methods. Preserve all protocol consumers. |
| OpenTUI | `ui-opentui/src/{entry,boundary,logic,view}` | Native Solid UI; not an Ink compatibility shim. |
| Other interfaces | `ui-tui/`, `apps/desktop/`, `apps/shared/`, `web/` | Ink is a separate supported renderer. Desktop has its own chat UI; the dashboard also supports the real TUI through its PTY bridge. |
| Fork maintenance | `ops/opentui-fork-maintainer/` | Versioned engineering policy and release controls, separate from user sessions and the daily-driver checkout. |

## Inside OpenTUI

`entry/main.tsx` is the composition root: it acquires the renderer, creates the
Solid session store, wires gateway events and renders `App`. Runtime layers are
provided there. Components do not construct their own Effect runtime.

`boundary/` owns external resources: gateway subprocess/transport, renderer
lifetime, clipboard, filesystem-facing operations, wire schemas and isolated
native compatibility workarounds. `GatewayService` exposes requests and decoded
events; `liveGatewayLayer` adapts `RawGatewayClient`. The wire event union is
decoded before reduction. Adding a Python event without adding its schema and
consumer can silently leave a working backend feature invisible.

`logic/` owns the Solid store, ordered message parts, interaction decisions and
feature controllers. `view/` renders this state using stock OpenTUI primitives.
Effects are used for resource and protocol boundaries, not as a competing
reactive state system inside every component. Local pure decisions remain plain
TypeScript; use exhaustive unions or table-driven mappings where they clarify
the actual cases, not as a mechanical style conversion.

Streaming text, reasoning and tools retain their order in `parts[]`. Events
that change turn/session ownership flush before later RPC continuations;
ordinary streaming deltas may be coalesced for paint. Queue admission, steer
acceptance, model consumption and durable storage are different states. An
ambiguous delivery is not permission to replay a user's prompt automatically.

Transcript windowing belongs to `logic/window.ts` and `view/transcript.tsx`.
Off-window rows relinquish expensive renderables while spacers preserve layout.
`correctionIsLegal` protects visible content from height-correction jumps.
Viewport paint culling alone does not release mounted resources. Persistent
chrome stays outside the transcript window; new session-owned state must reset
both on clear and on snapshot/resume replacement.

OpenTUI remains an unpatched package dependency. Necessary compatibility shims
live in `boundary/` with regression coverage and removal conditions in
`docs/opentui-upstream-alignment.md`. Runtime pins live in the package manifest
and lockfile: researching newer source does not upgrade the installed runtime.
The current engine requires Node's FFI launch path, not a guessed Bun command;
`ui-opentui/README.md` owns exact build and platform instructions.

## Cross-cutting invariants

- Keep the conversation's cached prompt prefix stable. Skills enter through the
  existing skill-loading path; do not rebuild system prompts or tool schemas on
  every event. Compression is an explicit context transition.
- Scope capability and credentials to the session/profile that owns them.
  Process environment is not proof that a desktop client is connected. Profiles
  are independent; intentional provisioning is not live inheritance.
- Keep behavioral configuration in `config.yaml`, secrets in protected credential
  storage. Never put keys or private session contents in release evidence.
- A successful build does not prove the intended installation is running. Record
  the source commit, renderer bundle, Python import root and profile for live
  verification. Working inside a project worktree does not establish any of them.
- Headless frames prove reducer/layout contracts, not every live repaint or
  native input behavior. Use a fresh real PTY for interaction changes, and an
  isolated `HERMES_HOME` for persistence/provider/process-boundary changes.

## How the fork is kept usable

The maintainer captures a fork base and upstream commit, works in an isolated
integration tree, and owns a bounded renewable run lease. `maintainer_runtime.py`
binds gates and their hashed evidence to the candidate and run. `gate-and-ship`
performs the controlled publication; a compare-and-swap refuses to overwrite a
fork branch that advanced elsewhere. Publishing and successful finalization are
separate phases recorded in a recoverable journal. A green worker summary or
cron exit alone is not proof that the fork was updated.

`configure.py` deploys policy and cron assets transactionally, pausing the job
while reconciling the deployment. Source policy belongs in the repository;
leases, logs, credentials and per-run evidence do not. Operational details and
current scheduling/model choices belong in the maintainer README and prompt,
not this architecture map. The proposed read-only run dashboard is described in
`docs/handoffs/opentui-maintainer-dashboard.md`; it is not part of this system yet.

## Verification and reference policy

For protocol changes, test the Python emitter, TypeScript decoder and reducer
relationship, then the real consumer. For rendering changes, run the package
check/build plus the relevant PTY interaction. For maintenance changes, exercise
the lease/publication/deployment failure paths as well as the successful path.
`ops/opentui-fork-maintainer/tests/`, `tests/tui_gateway/` and
`ui-opentui/src/test/` are the corresponding starting points. Performance claims
need matched before/after workloads; historical numbers in
`docs/opentui-memory-story.md` are not current release measurements.

This map follows [matklad's architecture-document guidance](https://matklad.github.io/2021/02/06/ARCHITECTURE.md.html):
stable boundaries and navigation rather than an exhaustive file catalog.
Reference-source review on 2026-09-05 used OpenTUI `7581976f4d2c`, OpenCode
`v2` `2960c61f9c5c`, Effect v4 `main` `f9235832c463`, and Executor
`38915a32cfa0`. Useful examples are OpenCode's `TuiLifecycle` context, OpenTUI's
Solid renderer adapter, Effect's `Match` implementation, and Executor's
schema-decoded worker IPC in `runtime-deno-subprocess`. These are research
references, not Hermes runtime dependencies or instructions to copy their
whole architectures. Recheck APIs against Hermes' actual locked versions.
