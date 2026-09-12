# Retrospective and self-repair

This reference owns the mandatory end-of-run phase. Run it on every wake with a
claimed runnable owner, success or failure, after the terminal outcome is
written and before releasing the lease. It is incorporated by the versioned
maintainer policy; the policy delegates the procedure, the classification table
and the `retrospective.json` schema to this file.

Invariant: every failed command in a run either becomes a committed fix, a
reference lesson with evidence, or an explicit external classification. Silent
repetition is a defect: the transient that broke a command is not the defect,
running the identical command again with no recorded change is.

Bounds: 30 minutes wall clock and two findings per run. Stop at the bound,
record the remaining findings as `skipped` with a reason, and leave the run's
normal evidence in place. The phase must never weaken a gate or test, and must
never edit the live runtime home directly; only a gated PR makes a fix permanent.

## Procedure

1. Collect evidence read-only: every command in this run that failed, was
   retried, or needed a workaround, with its exact command, exit code and log
   path under the run evidence directory. A clean run still does this pass; zero
   findings is a valid, recorded result.
2. Classify each finding with the table below. A finding has one class, not a
   guess hierarchy.
3. Read the previous run's `retrospective.json` and `handoff.md` first. If the
   request or the failure signature is unchanged, act on the recorded owner and
   next action instead of re-deriving the diagnosis. A deferred claim means the
   runtime has not changed since the last refusal; do not re-diagnose it.
4. For a fixable `tool` or `prompt` defect inside `ops/opentui-fork-maintainer/`,
   create a fresh worktree branched from the fork branch, implement the fix with
   an invariant test, run the ops tests, and commit to `maintainer/ops-<run-id>`
   (the run id from the claimed run). Open or refresh a PR against `sid/opentui`,
   or append the commit to the run's own PR when one exists, so the fix rides the
   normal gated review.
5. For a `reference` gap, update the smallest owning reference in that same
   branch: `failure-learning.md` for an incident lesson and its exact evidence
   path, `profile-learning.md` for a lesson not yet proven against current source.
6. Write `retrospective.json` in the run directory with the schema below, then
   release the lease.

## retrospective.json schema

```json
{
  "run_id": "<claimed run id>",
  "outcome": "success|failure",
  "started_at": "<ISO-8601>",
  "finished_at": "<ISO-8601>",
  "findings": [
    {
      "id": "F1",
      "signature": "<stable key reused across runs, e.g. ls-remote-exit-128>",
      "class": "tool|reference|prompt|external",
      "summary": "<one line: command, symptom>",
      "evidence": ["<run-dir-relative log path>", "<reproducing command>"],
      "fix": {
        "status": "committed|appended|skipped|external",
        "branch": "maintainer/ops-<run-id>",
        "commit": "<sha or null>",
        "pr": "<number or null>",
        "reason": "<why it was not fixed when status is skipped or external>"
      }
    }
  ]
}
```

`signature` is what the next run matches against; keep it stable across
occurrences so an unchanged failure is recognized instead of re-diagnosed.
`evidence` paths are relative to the run evidence directory, never absolute
transcripts. Do not copy credentials, private conversations or whole logs here.

## Classification table

| Class | What it means | Route |
| --- | --- | --- |
| `tool` | Control-plane script or ops test defect: wrong path, weak parser, missing guard, non-hermetic test | Commit the fix plus an invariant test to `maintainer/ops-<run-id>`; PR against `sid/opentui` or append to the run's PR |
| `reference` | Skill reference missing, stale or wrong about a proven boundary | Update the smallest owning reference in the same branch |
| `prompt` | This governing prompt is wrong, ambiguous or duplicated | Commit the prompt fix in the same branch; same gated review |
| `external` | Network, provider, upstream, GitHub, host or a human decision; not fixable inside the ops tree | Record only, with the exact failing command and the fallback actually used |

A finding that is `external` still records why no local fallback remained.
A finding classified `tool` but left uncommitted is not fixed; say so.

## Worked examples

### 1. Transient `git ls-remote` failure wedged a publication

A transient `git ls-remote` returned nonzero once and the publisher stopped
before the guarded push. The run diagnosed it correctly, wrote and tested a
control-plane fix in a worktree, but never committed it or opened a PR. The next
four ticks each re-derived the same diagnosis from scratch, repeated the
identical doomed attempt, and wrote a long handoff, until a human deployed the
fix.

Correct route: class `tool`; commit the fix with an invariant test to
`maintainer/ops-<run-id>`; open the PR (or append to the run's own PR); record
the finding, signature and commit in `retrospective.json`. The next run reads
`signature` and acts on the recorded owner instead of re-diagnosing. A repeated
identical failed command with an unchanged signature is the defect.

### 2. Reconciler misclassification

The post-agent reconciler closed a resumed run as `external`/`external-blocker`
although the aborted journal was still bound to that run's evidence, manifest,
candidate and base. The next run re-diagnosed the same binding check because the
previous handoff described the symptom but not the class or owner.

Correct route: class `tool`; evidence is the journal plus the reconciler log
path; commit a test asserting the binding check; record the exact resumable
condition so the next run applies the recorded classification.

### 3. Repeated doomed claims

The same request and refusal re-executed on consecutive ticks because the
runtime had not changed. Each tick spent its budget rebuilding the same
diagnosis.

Correct route: when the previous `retrospective.json` and `handoff.md` carry the
same request or failure signature, read them first. A deferred claim means the
runtime has not changed since the last refusal; do not re-diagnose it, act on the
recorded handoff. If the deferral itself is wrong, that is a `tool` finding with
the claim-request evidence attached.
