# Publication continuation and interrupted finalization

Read this complete reference for a claimed `mode: resume`, an
unchanged-candidate continuation, or interrupted publication/finalization.
It is incorporated by the versioned maintainer policy. The exact owner,
request, candidate and hash-bound evidence determine what may be reused;
this reference grants no new implementation or publication path.

## Claimed resume request

A claimed `mode: resume` request is an explicit publication continuation
of a retained scheduled sync. Before any implementation, new worktree, worker
or gate, read its exact source_run, manifest_sha256, packet_sha256, pr,
base_sha and candidate_sha. Invoke the deployed `resume-publication` command
with this fresh wrapper token, `--source-manifest <state>/runs/<source_run>/gate.json`,
`--source-sha256 <manifest_sha256> --packet-sha256 <packet_sha256> --adopt-pr <pr>`,
`--manifest <fresh-evidence>/gate.json --repo <fork> --state <state> --token <token>`.
Background and observe the bounded process exactly as for gate-and-ship.
The runtime validates retained evidence and current authorization/CI without
creating another PR. Intact candidate-bound checks are reused. If a completed
local install, focused-test, check, or build log is missing or changed, pass
its explicitly hashed original packet with `--source-packet`; the runtime
reruns only those local commands into a fresh attempt location. It never
reruns independent review, native capture, or video analysis for a metadata
refresh: any uncertainty in those artifacts or in the reviewed source refuses
continuation. The same command also supports the still-live owner; it archives
an in-place source manifest before recording the fresh attempt. It performs
normal journaled publication/finalization on success. Never reset the old
lease or rewrite its outcome. On an observation interruption, retry the exact
command under the same live owner. A fresh wrapper owner continuing a terminal
prior owner likewise reuses its authenticated recovery attempt; only a
missing or changed eligible local check creates another immutable attempt,
copying its intact original or rerunning its exact packet command when the
original is unusable. Changed review, visual, source, packet, request,
worktree, or owner evidence refuses reuse. After owner termination, use the
existing request recovery and a fresh wrapper run. A prior-owner continuation
carries the authenticated source evidence directory and exact worktree into
its recovery manifest and publication journal; finalization validates cleanup
against that original owner, never the fresh run root. Sibling paths,
symlinks, dirty worktrees and branch-attached worktrees remain refusals.
When the publisher stopped after the exact task draft and local gates but
before writing `pr-evidence.json`, the continuation may bind the task-owned
`pr-draft.json` only if PR evidence is genuinely absent. The existing publisher
must re-prove the live draft's request/base/head/marker, republish the Preview
from its hash-bound retained source, then observe dispositions and current-head
CI normally. Missing draft, source artifact, disposition, or CI is never
approval; a present invalid PR evidence file is not eligible for this fallback.
Changed evidence/source/base is a refusal, not permission to silently rebuild.
For future fix commits on a task-owned PR, use full gate-and-ship with
`--expected-pr-head <verified-previous-head>`; changed source requires new review.

## Interrupted gate-and-ship or finalization

Before the guarded push, the runtime persists a candidate-bound publication journal and shortens only this run's lease to a fixed 15-minute post-publish recovery deadline. On success this same trusted CLI invocation consumes a claimed request when present, records the already-proven upstream SHA without another network fetch, removes only the clean detached maintainer worktree proven by the passing manifest, finalizes the journal, records the terminal outcome last, and releases the lease before returning zero. Do not spend another model iteration repeating those steps after a zero exit. A failed, forged, stale, dirty, or incomplete gate cannot advance the remote, and the local daily-driver ref, index, and worktree remain untouched. If the command fails after the remote accepted the push, the journal remains truthfully `prepared`, `published`, or `finalizing`: `finalize-success` verifies the remote candidate before advancing even a `prepared` journal. While the same token is live retry that command and then `release-lease --state <state> --evidence <run-evidence> --token <run_token>`; after a process crash, the watchdog or next scheduled tick reconciles the expired structured run before any replacement lease may be claimed. Otherwise retain the isolated branch/worktree and produce a
precise handoff with failing command, log path, owner, and next action.

The retained terminal/process handle and final output own command completion.
A timeout or null observed exit code never authorizes a duplicate operation.
The main policy's mandatory `finalize-failure` and exact lease-release
procedure still applies; published-but-unfinalized work must instead complete
`finalize-success`, not recover its request or rebuild the candidate.
