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

After coordinator review, quiescence and provisioning, use the existing
`maintainer_runtime.py finalize-success` (or its existing reconciler) for the
original journal/manifest/evidence/worktree. Keep the original publication
binding; do not create a claim, republish, rerun gates, or clear intake state.
Inspect the current CLI help for its required arguments and let the existing
owner supply the retained token without printing it.

The delivery owner now resolves `closure_compensation_unresolved` only when
two complete read-only observations prove the issue remains CLOSED/COMPLETED,
its revision and approval remain valid, and its latest state transition has
the trusted issue/revision/candidate/receipt-bound close intent. It independently
reads that exact GraphQL ClosedEvent (including its Issue identity) and the
exact trusted receipt with the full revision, candidate and PR URL. There is no
synthetic mutation ACK and no remote mutation during recovery. Success retains
the prior failure reason and event/receipt identities as `recovered_close`;
repeated delivery recovery verifies that same evidence again.

Missing, delayed, contradictory or changed evidence leaves the durable record
untouched. A later human reopen/close (even by the repository owner), changed
authorization, or ambiguous duplicate close intent requires coordinator review;
this narrow recovery does not compensate or adopt it. Read failures are
retryable only by re-running the same finalization after evidence is available.
No finite read sequence is an issue-state CAS; this path avoids that mutation
race entirely by never writing GitHub. Finalization/claim consumption and queue
resumption remain separate from accepted source publication and deployment.
