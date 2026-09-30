# Self-deploying an ops change

The maintainer governs its own control plane. When a run finds a bug in
`ops/opentui-fork-maintainer` and fixes it, shipping the fix does not need a
human: the same run that reviewed and published it may adopt it into the live
runtime home with `configure.py --self-deploy`.

## When

Use it only at the **end** of a run, after the ops change is published:

- it was merged or published through the normal gated PR flow, or
- it was reviewed and committed to the fork branch by this same run.

Never mid-run: the running process keeps executing the old module until the tick
ends. Never edit files under `RUNTIME_HOME` by hand, and never deploy an
uncommitted edit.

## How

```bash
uv run --no-project --python /home/daimon/side-quests/hermes-agent/.venv/bin/python \
  /home/daimon/side-quests/hermes-agent/ops/opentui-fork-maintainer/scripts/configure.py \
  --self-deploy <40-char sha> \
  --published-ref <branch this run published> \
  --repo <checkout> --state <state> --token <run_token>
```

- `--self-deploy` takes the **full 40-character** commit SHA, never a short form
  or a branch name. `--published-ref` is a branch name on `origin` (for example
  `sid/opentui`); its tip is read from the remote with `ls-remote`, so a local
  tracking ref cannot authorize a deploy. Repeat it per branch the commit must be
  an ancestor of. `--gated-candidate <sha>` narrows the anchor to one candidate;
  it is accepted only when that candidate is itself an ancestor of a published ref.
- The command requires a **live run lease** owned by `--token`, and refuses while
  any other run lease is live. It reads asset content straight from the pinned
  commit's blobs, so a dirty worktree can never ship; it also refuses outright
  when the ops subtree has uncommitted edits.

## What it guarantees

- It copies exactly `RUNTIME_ASSETS` plus the versioned maintainer skill, reusing
  the operator path (`deploy_assets`, `install_maintainer_skills`) and preserving
  the profile-owned `references/profile-learning.md`.
- Every target is snapshotted first and restored if anything fails.
- It verifies the deployed `maintainer_runtime.py --help` exits 0 and that each
  installed file's blob hash equals the pinned commit's blob. Any mismatch rolls
  the whole deploy back.
- It writes a receipt under `<state>/self-deploy.<utc>-<sha12>.json` recording the
  SHA, run id, the published anchors, and each file's sha256 before/after plus the
  verified blob hashes.

## Report

Always name the receipt path in the run report. The receipt's `effective:
"next-tick"` is literal: the run that deploys is never the run that executes the
new code. Read the receipt after a failure — `status: "rolled-back"` includes the
error and leaves the previous runtime in place.
