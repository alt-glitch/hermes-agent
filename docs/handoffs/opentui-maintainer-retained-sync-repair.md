# Retained PR95 sync repair deployment handoff

This change is an offline control-plane prerequisite. It does not deploy the
maintainer, queue work, mutate PR95, advance `sid/opentui`, or authorize
publication. The coordinator must review the committed binary diff and retained
test logs, then wait until the implementation parent has exited before changing
runtime assets.

The only granted source is terminal run `20260909T125428Z-216c997c`:

- captured base `e55bce4630c73218d91a2f874f38946ac23844d9`;
- captured upstream `9e6c4100cbf5222fb473ecc2b51fd17874f6ee75`;
- scheduled merge `40e6b5d58be0cc8c028b70a318f02936d6bd3ac7`;
- PR95 source `a4ba79d9f3bca7ed4a3823393507d7ed15d99de5`;
- retained local repair `b14ab20f16b9d224e99f6bb00adc2a356e10bda0`.

The manifest, run context, failed outcome and PR receipt hashes are pinned in
`ops/opentui-fork-maintainer/scripts/retained_sync.py` and repeated in the
maintainer README request packet. Any mismatch is a stop condition, not a reason
to edit historical evidence or substitute another run.

## Coordinator sequence

1. Confirm the offline parent and every prior maintainer owner are stopped, the
   cron remains paused, and no deployment journal needs recovery.
2. Review the exact implementation commit and its retained logs. Deploy the
   versioned runtime transactionally through `configure.py`; the deployed asset
   set must include `retained_sync.py` and the updated policy prompt. Do not copy
   individual files by hand.
3. Verify deployed hashes/readback while the cron is still paused. A deployment
   receipt is not publication evidence.
4. Submit the exact evidence-pinned repair request from the maintainer README.
   Do this only after deployment, under the coordinator's existing request
   authority.
5. In the next fresh wrapper-owned run, verify PR95 still targets
   `sid/opentui`, its same-repository branch is still at `a4ba79d9`, and the
   target is still `e55bce4`. Verify `b14ab20f` is a first-parent-linear
   descendant of `a4ba79d9`; incorporate the reviewed validator commit as a
   further linear repair rather than rebuilding the upstream merge.
6. Publish only through the existing `gate-and-ship` caller with PR95's exact
   current head as `--expected-pr-head`. All candidate gates, independent
   review, media and current-head required CI must be fresh.

The ship lock and normal finalizer remain authoritative. A successful
finalization records upstream `9e6c4100` as the watermark and preserves the old
failed run outcome. If the target, source, PR, evidence, provenance or topology
has moved, stop and reconcile; do not create a replacement PR, force-push, reset
the terminal owner, or treat issue prose as provenance.
