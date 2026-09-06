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
