# Retained-run audit

2026-09-05 snapshot: 79 retained terminal outcomes, 34 successes and 45 failures.
This is not every scheduled tick: retention and up-to-date/no-agent runs change
the denominator.

- 23 consecutive retained reports (Aug 20 through Aug 31 AM) contained HTTP 401
  `User not found`. Gateway liveness is not authentication. Verify resolved route
  and a bounded real tool call before assigning hours of work. Confirmed 401s
  require credential repair, not identical retries; never print the credential.
- Other reports contained 429 and connectivity failures. Classify these separately
  from auth and test failures; retain bounded retry evidence without switching
  to an unapproved provider.
- A foreground worker hit the 18,000-second inactivity limit. Background long
  packet/gate calls and observe completion. The eleven-hour absolute lease still
  fences runaway execution; healthy progress isn't killed at 600 seconds.
- A run exhausted iterations before observing its gate. Final prose cannot
  finalize an unobserved process. Require the actual result and runtime outcome.
- Publication recovery and old-checkout video issues preceded later successful
  repairs. Inspect the journal first: remote push can succeed while finalization
  fails. Reconcile exact candidate/token, don't rebuild and push twice.
- Six auto-injected skills reached roughly 255 KB and mixed stale CLI/model
  instructions with current policy. Load focused guidance on demand; installed
  help and actual capability probes override old examples.

Latest proven success at this snapshot: run `20260905T033038Z-aa1e0298`, execution
`6e91ae83d27642a3bd5dc3e617edd48b`, fork `224fa621` -> `07d5e99`, upstream
`79445a496c86a19332ad786494b8384d2167e2d0`. All seven gates and publication outcome
were retained. These are historical facts, not current health: read
`state/last-run.json`, its run directory and the actual remote before reporting.

Save evidence first, generalize only after verifying cause and repair. Don't
accumulate universal prohibitions or entire transcripts in skills.

## Review timing correction (2026-09-05)

PR #39 advanced the fork after local gates passed, but Greptile finished nine
minutes later with 3/5. Its upstream-imported media symlink race reproduced on
both leaf and parent-directory swaps; passing focused tests had not covered that
window. The publisher now observes a current-head 5/5 and completed green remote
checks before target CAS. A pending review is not approval, and the bot's green
check conclusion alone does not mean its confidence score is 5/5. Keep PR findings
separate from maintainer health: the cron stayed paused while these were repaired.

The attribution workflow also compared every PR against `main`, even when targeting
`sid/opentui`; this falsely charged earlier fork history to the new PR. Compare
against the actual PR base before changing contributor records.

PR #40's first review found the next missing case: GitHub's status rollup lists
reported checks, not the base branch's requirements. An absent required check must
remain pending even when every reported item is green. Read protection and ruleset
policy, then also require GitHub's clean merge decision; don't weaken checks to
raise the review score.

The full session-store tests caught a merge omission that the focused gates missed:
model rankings had retained picker activations but lost their API-call updates.
Restore the pre-merge delta accounting in the extracted usage module, preserving
absolute counters and provider-fallback attribution. Include these tests when
rebasing session-store changes. Also run the compatibility-pointer checker, not
only the Windows scanner: both execute in the same remote CI job.

## Environment campaign corrections

- A nonzero herdr prompt wait did not mean rejection: the real agent completed
  afterward. Preserve stderr, then inspect the owned agent before resubmitting.
- Synthetic recordings inherited startup query/image inputs. The capture now
  constructs an allowlisted environment and refuses candidate dotenv inputs;
  old recordings without that provenance are not upload-eligible.
- A migrated entrypoint formerly looked in the default profile's execution DB.
  Bind profile, job ID and runtime manifest together and smoke-test identity
  under conflicting ambient variables before scheduling.
- Pause and drain the old job before replacing shared runtime assets. Do not
  nest cross-profile cron transactions: the lock-depth bookkeeping is not
  profile-keyed. Keep the old owner paused throughout cutover.
- Reference refresh must protect ignored files and symlink ancestors too.
  Read-only Git inspection uses `--no-optional-locks` to avoid index writes.
- Provisioning must reject destination aliases before opening config/secrets;
  use private random staging files. Test outside sentinels remain untouched.
- The approved Gemini route was tested with a new sanitized recording and
  returned `VERDICT: PASS` through OpenRouter. It does not authorize sending
  user conversations, old recordings or default-profile credentials.

## Extraction-preservation audit (2026-09-05)

The first broad fork audit found five missing RPC registrations and 147 failing
tests after upstream's module extraction, despite narrower green gates. Inventory
actual client calls and backend registrations, then map old behavior to its new
owner. Module counts and successful Git ancestry do not establish parity.

- Real ownership fences require realistic registered sessions and temporary
  leases in tests. Update stale fixtures without bypassing the fence or dropping
  assertions. Run unrelated Python files in separate processes to avoid leaked
  import mocks; inspect actual executed counts and parser errors, not only the
  runner's estimated total or exit status.
- A dispatcher returning normally can still refuse a turn. Propagate its
  explicit result before acknowledging notifications, consuming loop claims,
  or discarding queued user correlations. Test refusal and retry, not only the
  successful path. A rejected original RPC and a concurrently accepted queued
  prompt have different acknowledgment obligations.
- Shutdown cannot infer "never started" from a missing fire-owner record:
  external handoff has such a window. Track the existing scheduler's gated
  dispatch explicitly and serialize cancellation with worker entry. Release only
  captured claim identities; never refresh a job and adopt another run's token.
- Review diffs must include changed facade signatures and unchanged contract
  context. Refute missing-context findings with source, not assertion changes.
  Targeted title events also avoid racing a full stale session-state snapshot.

## Review evidence fidelity (2026-09-06)

- A manual static Claude review without the formal tool-free prompt returned
  XML-shaped pretend tool calls, despite a successful process exit. The actual
  runtime chunk prompt passed its smoke test unchanged; real read-only source
  tools also worked. Preserve malformed output as a failed attempt, verify the
  actual runner, and never count process success as a review verdict.
- The video judge reported duplicate help rows that did not exist in any
  recorded output state. Require timestamp/region evidence, distinguish a row
  persisting across frames from duplicates in one frame, and verify claims by
  replaying the recording. Preserve rejected results and the reason for any
  rerun. Even a passing judge can misread labels; source and native frames own
  exact text, and a startup/help clip proves only that interaction.

## Preservation corrections (2026-09-06)

- Taking the registry lock before a turn's mutation lock can freeze unrelated
  sessions on disconnect. Recheck identity and transport after acquiring mutation,
  including orphan reapers and supersession, not only explicit session close.
- An accepted submission needs a terminal event even when its client sends no
  correlation ID. Test both client shapes. A synchronous rejected RPC remains a
  separate contract and must not invent a started turn.
- Clear a previous turn's Stop flag when claiming new work, under the existing
  history lock. Preserve a Stop arriving after that claim. On refused synthetic
  dispatch, release the delivery receipt and return the event to its queue.
- Reserve finite recurring attempts durably before execution and settle by exact
  execution/owner identity. A crash may spend an attempt without a result; retain
  the exhausted record and explain it instead of replaying it. Proven cancellation
  before entry spends none. Failed external handoffs retain their existing attempt
  accounting, even when a previous execution has an unsettled reservation.
- Shutdown's first outcome write can fail. Retry only execution-deduplicated
  settlement in the interrupted tail; repeating legacy counter updates is unsafe.
- A fresh-process sweep exposed a hosted-room timing failure that passed alone.
  Preserve both logs; a rerun is not evidence that the first run was green or
  definitive proof of a pre-existing cause. Avoid broadening a reviewed correction
  based only on timing speculation.
