# Approved issue ownership: quiescent deployment handoff

This bootstrap delivers versioned code through the existing explicit PR repair
path. It must not replace its own live gate/runtime or change the scheduler while
it runs. Passing tests and publication are not deployment or live issue proof.

## Coordinator transaction (only after bootstrap terminal finalization)

1. Read deployed `state/job-identity.json`, exact bootstrap terminal outcome,
   publish journal and remote `sid/opentui`. Reconcile a published-but-unfinalized
   journal before starting anything else. Keep base/candidate/PR identities in
   the deployment receipt; do not infer success from a cron exit.
2. Pause the **existing** profile-scoped job using the supported cron command.
   Verify it is paused and all owning executions/leases and restart-safe workers
   are quiescent. Do not create another job, restart an active parent, overwrite
   another profile, or deploy over an unobserved gate.
3. Select the published candidate's `ops/opentui-fork-maintainer` assets. Inspect
   `provision_profile.py`'s plan, then reprovision only the isolated maintainer
   while paused. Require assets that pin main/compaction to Codex subscription
   (`openai-codex` / `gpt-6-astra`) with medium reasoning,
   300000-token compression trigger, 600-second model stale allowance and
   maintainer-only off-mode approvals. Use Hermes' supported Codex credential
   resolver and login/import flow. Only the separately authorized Gemini/OpenRouter
   key is copied by the provisioner. Do not copy personal MCPs or conversations,
   manually copy OAuth refresh tokens, or rewrite the user's Codex configuration.
4. Run the candidate's `configure.py --apply` through
   `uv run --no-project --python <managed-python>` with the current identity's
   `--hermes-home`, `--job-id` and `--runtime-home`. Do not use `--create-paused`
   for an existing installation. The deployment owner pauses, checks quiescence,
   journals, copies assets (including README and issue_intake.py), verifies exact
   persisted job settings and restores prior pause state transactionally.
   Inspect/reconcile a deployment journal rather than manually replacing files.
5. Verify the installed profile and actual job resolver both select provider
   `openai-codex`, model `gpt-6-astra`, medium reasoning and resolver-selected
   `codex_responses` (not the Codex app-server loop). Verify compaction separately, video still
   `openrouter/google/gemini-3.5-flash`, and timezone Asia/Kolkata. The existing
   job must have `0 3,9,15,21 * * *`, 18000-second inactivity allowance and no
   fallback route. Retain a real bounded tool-call receipt, not just YAML.
6. Restore the existing enabled six-hour job and verify real routing and overlap
   evidence. Waiting for a natural scheduled success is not a deployment gate.
   If a natural tick is observed, retain its actual source/time/execution/lease;
   do not label direct dispatch as scheduled. A live overlapping owner must
   produce a durable skip, not duplicate implementation or a successful cycle.
   Later-agent skill adoption is a separate proof: a fresh authorized owner must
   read and apply the relevant guidance, not merely appear in a schedule listing.
7. For real issue lifecycle proof, use an owner-approved bounded real task in
   this fork: final title/body, `opentui`, then trusted `maintainer:ready` event.
   Follow approved revision → claim → implementation → all seven candidate gates
   (including independent review) → current-head required CI → candidate PR →
   target CAS → durable finalization/issue receipt. Greptile is disabled; do not
   request paid review or require its score. Preserve unrelated existing PRs. No disposable
   issue or simulated API response should be presented as real delivery.

## Current proof boundaries

Repository tests exercise trusted/untrusted approval, API pagination/failure,
revision edits, existing PR conflicts, feature-only wake, claim/lease fences,
publication recovery, profile setup and real child-process overlap using
isolated state. They do not prove the deployed schedule or external issue
lifecycle. Native startup/help captures are **Preview smoke evidence** only.

The coordinator should append actual deployment/tick/issue receipt paths to its
own durable run evidence and report these stages separately. Keep this document
procedural: do not paste credentials, personal sessions or transient log dumps.
