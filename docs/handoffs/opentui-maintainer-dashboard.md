# Handoff: read-only OpenTUI maintainer run dashboard

Status: proposal for a separate implementation session. No dashboard, HTTP
service or new telemetry collector is implemented by this handoff.

## Outcome

Let the owner answer: Is the maintainer running? What changed? Was it tested?
What was published? What failed? Which skills, tools and scripts actually
contributed? Show before/after media alongside the exact candidate that it
verifies. Do not build another agent chat surface or another scheduler.

Start with a local, read-only view of existing artifacts. Keep hosting, remote
access and any retry/cancel/approve controls out of the first milestone.

## Existing sources, not a new event model

Versioned producer code is in `ops/opentui-fork-maintainer/scripts/`.
`maintainer_runtime.py` defines the gate validator and finalization semantics;
`opentui_fork_sync.py` owns run capture/lease handling. Runtime evidence is under
the deployed maintainer's `state/runs/<run-id>/`. Resolve the configured state
root rather than baking one developer's home directory into the frontend.

| Artifact | What it establishes | How to present it |
| --- | --- | --- |
| `run-context.json` | Captured base/upstream and run binding | Immutable run identity and source range. |
| `gate.json` | Candidate-bound checks, fixed argv, exit/status and hashed output paths; review and terminal evidence | Per-gate result with bounded, redacted output. A missing check is unknown/not run, never passed. |
| `gate-logs/` and referenced terminal evidence | Actual command/reviewer results and captured interaction | Explicitly opened details and media, not a default transcript dump. |
| `run-outcome.json` | Durable outcome with schema version/time; success or failure, publication/finalization fields | Main result, preserving `published` separately from `status`. |
| `state/last-run.json` | Latest terminal summary plus evidence path/hash | Fast landing-page seed; not the complete run index. |
| `success-finalization.json` | Finalization evidence | Separate published/finalized indicators. |
| `state/publish-journal.json` | Current publication recovery phase | Operational detail bound to its matching run, not applied to every historical run. |
| `state/run.lease.json` | Current lease and deadlines | Activity/expiry evidence only; never expose the lease token. |
| `state/last_synced_upstream.sha` | Recorded completed upstream watermark | Sync watermark, not proof of current remote HEAD or installed code. |
| Hermes cron execution records | Scheduler start/end/result and agent session linkage | Correlate explicitly; cron completion and publication are distinct. |

Field names and validation must follow the producer at the implementation
commit. Do not freeze this table into a duplicate hard-coded schema. Existing
records may predate the current schema or lack media. Surface that uncertainty.

The current evidence does **not** guarantee a complete inventory of every skill
read or tool invoked. A configured skill list proves availability, not usage.
If opt-in access to an isolated maintainer session can establish tool/skill
usage, derive a bounded summary with source references; otherwise show
"not recorded". Any richer run manifest is a proposed producer change requiring
tests, not a claim about historical artifacts.

## First useful screen

Use a run list with start time, captured commits, outcome, publication state and
evidence health. Open a run into: concise change summary/PR link; gate timeline;
before/after; environment/provenance; failures and recovery. Keep raw output
collapsed. Show stale data and last-observed time while refreshing, rather than
blanking the page. Avoid a graph whose bars only repeat total elapsed time.

Before/after media must name baseline and candidate SHAs, viewport, scenario and
capture time. A lone after recording is a preview, not a comparison. Preserve
the upload references produced by the `before-and-after` skill when attaching
approved media to PR descriptions; do not upload historical private recordings
merely to fill missing cards. Media may be unavailable or intentionally private.

## Trust boundary

The reader cannot execute artifact `argv`, run scripts, renew leases, modify
cron or call `gate-and-ship`. File paths must stay inside an allowlisted evidence
root after symlink resolution. Bound file sizes and log tails, handle partially
written/missing JSON, and verify recorded hashes before claiming intact
evidence. Do not invoke mutating reconciliation to render a page.

Never serve `.env`, auth stores, lease tokens or whole user-session databases.
Render logs as text, strip terminal control sequences, and apply a restrictive
media/content policy. Treat titles, commands, model output and PR descriptions
as untrusted content. Any future remote deployment needs explicit authentication,
access policy and retention decisions before exposure.

## Verification loop and acceptance

1. Inspect producer schemas and representative sanitized fixtures before choosing
   UI structure. Write a read-only normalizer with typed unknown/invalid states.
2. Cover: finalized success; failure before publish; published but needing
   finalization; active and expired lease; moved remote; missing/corrupt evidence;
   hash mismatch; older schema; no media; unrecorded skill usage. Do not collapse
   these into one green/red flag.
3. Prove path traversal, symlink escape, oversized output and hostile markup do
   not leak files, execute commands or break the view. Prove all user actions in
   this milestone are read-only.
4. Open a real sanitized run archive, compare the view against its artifacts,
   and capture a before/after or preview with the existing media workflow.
5. Verify refresh preserves visible data, slow/missing reads stay understandable,
   and a process restart does not invent a successful result.

Deliver the read-only viewer, fixture-based contract tests, a live validation
record and an operations note. Defer write controls, historical transcript
indexing and public hosting. The dashboard explains the maintainer; it must not
become the component that makes the maintainer reliable.
