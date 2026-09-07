# Issue closure API and verification boundary

`ops/opentui-fork-maintainer/scripts/issue_delivery.py` uses GitHub GraphQL
`closeIssue` with a per-invocation rationale marker, not an invented conditional
REST header. DeliveryIO supplies existing intake transport and validation; the
sibling owns receipt, closure and compensation behavior.

Live schema inspection on 2026-09-06 returned these fields:

- `CloseIssueInput`: `clientMutationId`, `issueId`, `stateReason`,
  `duplicateIssueId`, **`rationale`**, `isSuggestion`, `confidence`.
- `ClosedEvent`: `actor`, `closable`, `closer`, `createdAt`, `duplicateOf`, `id`,
  **`intent`**, `resourcePath`, `stateReason`, `url`.
- `IssueUpdateIntent`: `confidence`, `databaseId`, `intentId`, **`rationale`**.

Recheck against the live API, not an older remembered schema:

```sh
gh api graphql -f 'query=query { a:__type(name:"CloseIssueInput") { inputFields { name } } b:__type(name:"ClosedEvent") { fields { name } } c:__type(name:"IssueUpdateIntent") { fields { name } } }'
```

The parent executed that read-only command. Raw response is retained as
`closure-schema-parent.json` in run `20260906T170343Z-625065ff`; the worker's
independent schema probe is `closure-github-api-capabilities.json`. No issue
was closed/reopened by those probes. Existence of fields is not a claim that
the full external lifecycle has been live-verified; that remains a separate
post-terminal deployment proof.

The marker is acknowledged through the mutation's resulting ClosedEvent intent.
On changed authorization, compensation requires that our acknowledged close
remain the only new state transition. Ambiguous ownership or failed readback is
a durable failure, not authorization to overwrite a later human transition.
GitHub exposes no issue-state CAS input; this is explicit compensation, not an
atomic cross-request transaction.

## Recover an already-published close with a missing/rejected acknowledgement

Issue `closedAt` and ClosedEvent `createdAt` are separate clocks. PR83's retained
readbacks show a one-second difference. Match GraphQL `id` to REST `node_id`,
actor and intent instead; do not use a timestamp tolerance. The timestamp of
the **same event** must still agree across APIs.
The retained PR83 REST timeline (`issue-finalization-timeline.json` in run
`20260907T121736Z-f2fdbb17`) does carry `intent.rationale` on closed event
`30700641517`, node `CE_lADOSAPgas8AAAABP5qcW88AAAAHJeac7Q`, binding receipt
`5572669366`. This is observed REST evidence, not an assumption from the
GraphQL schema; the correlation checks remain required.

After coordinator review, quiescence and provisioning, use the existing
finalizer for the original journal/manifest/evidence/worktree. `finalize-success`
requires a live lease, and `reconcile-run --allow-expired` requires an expired
lease. Neither can recover PR83's legacy **absent lease**. For that exact state,
the coordinator supplies the original retained token (without printing it) and
uses the explicit missing-lease mode of the same reconciler:

```sh
/usr/bin/env PATH="/usr/bin:/bin:$PATH" uv run --no-project \
  --python /home/daimon/.hermes/hermes-agent/venv/bin/python python \
  /home/daimon/projects/opentui-fork-maintainer/scripts/maintainer_runtime.py \
  reconcile-run --state /home/daimon/projects/opentui-fork-maintainer/state \
  --evidence /home/daimon/projects/opentui-fork-maintainer/state/runs/20260907T121736Z-f2fdbb17 \
  --token "$ORIGINAL_RUN_TOKEN" --allow-missing-lease
```

The retained token is checked against the immutable manifest digest; it does
not recreate a lease. The CLI holds `maintainer.lock` and `run.lease.lock` through
remote readback and finalization, refusing any existing lease, including an
expired or different owner. It requires the matching intact published journal
and manifest, durable failed/finalization outcome with `published=true` and
`needs_finalization=true`, exact issue claim, and remote candidate ancestry.
It cannot run gates, publish, post a receipt, close or reopen an issue. Missing
sticky close evidence fails closed instead of falling back to ordinary delivery.

Keep the existing queue paused until this exact run is finalized: recovery
requires `last-run.json` to still hash-bind this run's outcome. A later run's
outcome replaces that pointer and makes recovery fail closed; releasing that
later owner's lease does not restore the older binding. There is no automatic
pointer rollback. Use canonical absolute state/evidence paths, not symlink
aliases. Do not use a new preflight claim as recovery or manually clear intake
state. Successful recovery preserves the original failed outcome byte-for-byte in
`run-outcome.failed.json` before recording terminal success. Repeating the same
command verifies durable completion without a new lease; an interrupted final
outcome write can also be retried. Lease release now refuses unfinished
publication for that same run even when a failed outcome exists. A failed
unrelated owner may release its own lease without touching the foreign journal.
Missing or changed manifest, outcome, claim or receipt evidence requires
coordinator resolution, not bypass.
This narrow mode also refuses legacy runs whose issue delivery already succeeded
without a `recovered_close` record before cleanup crashed. Such runs need a
separately reviewed coordinator path, not fabricated sticky failure evidence.

The delivery owner now resolves `closure_compensation_unresolved` only when
two complete read-only observations prove the issue remains CLOSED/COMPLETED,
its revision and approval remain valid, and its latest state transition has
the trusted issue/revision/candidate/receipt-bound close intent. It independently
reads that exact GraphQL ClosedEvent (including its Issue identity) and the
exact trusted receipt with the full revision, candidate and PR URL. There is no
synthetic mutation ACK and no remote mutation during recovery. Success retains
the prior failure reason and event/receipt identities as `recovered_close`;
repeated delivery recovery verifies that same evidence again.
An old authorization's failed/recovered close does not poison ordinary delivery
of a newly approved revision or approval event. New work must independently pass
normal authorization and receipt checks; recovery-only never adopts that old
record, and same-authorization candidate/PR/failure mismatches still fail closed.

During recovery, missing, delayed, contradictory or changed evidence leaves the durable record
untouched. A later human reopen/close (even by the repository owner), changed
authorization, or ambiguous duplicate close intent requires coordinator review;
this narrow recovery does not compensate or adopt it. Read failures are
retryable only by re-running the same finalization after evidence is available.
No finite read sequence is an issue-state CAS; this path avoids that mutation
race entirely by never writing GitHub. Finalization/claim consumption and queue
resumption remain separate from accepted source publication and deployment.
