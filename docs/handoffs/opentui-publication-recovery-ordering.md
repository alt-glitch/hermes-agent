# OpenTUI retained-publication recovery ordering

This recovery changes the maintainer control plane, but PR90's retained proof is
bound to fork base `6ddcdf00bd5984dc864f10edf8ea61dd48289aa9` and candidate
`5025fb124daec4a1006a3a700258fa521c7b75a0`. Advancing `sid/opentui` first would
make its guarded base compare-and-swap impossible. The old review also cannot
cover this recovery code or any candidate rebuilt above a newer base.

The coordinator-controlled sequence is therefore:

1. Pause the maintainer job and reach quiescence. Independently review and
   verify this control-plane source, then deploy it through the existing
   pause/journal/verify transaction **without changing `sid/opentui`**.
2. Under one authorized owner, resume PR90 at its original base and candidate.
   Refresh current review surfaces and dispositions. Reuse only the retained
   independent review and termctrl/video artifacts whose hashes still match;
   rerun its three changed local logs into a fresh evidence attempt. Require
   current-head CI, issue authorization, target CAS, and finalization.
3. Only after PR90 is finalized may the coordinator advance the fork with this
   recovery change. Rebase or reconstruct this feature candidate on that new
   fork tip and perform fresh candidate-bound review, local gates, current-head
   CI, and guarded publication. PR90's review is not evidence for that source.

If the coordinator cannot deploy reviewed control-plane source without moving
the fork branch, the current runtime cannot safely recover PR90. That is a
ship-order blocker; do not relax ancestry, rewrite PR90, or fabricate a passing
artifact to bypass it.
