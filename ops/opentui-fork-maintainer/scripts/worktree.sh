#!/usr/bin/env bash
# Throwaway worktree manager for the OpenTUI fork-maintainer cron.
#
# The maintainer agent NEVER works on the live `sid/opentui` branch (that branch
# IS glitch's running install). It does all merge/port/gate work in a detached
# worktree created off the current branch tip, and only fast-forwards the live
# branch when the gate is green.
#
# Usage:
#   worktree.sh create            -> creates ~/projects/opentui-fork-maintainer/worktrees/sync-<UTCdate>
#                                    off sid/opentui (detached), prints the path on the last line.
#   worktree.sh remove [path]     -> removes the named worktree (or the most recent sync-* if omitted).
#   worktree.sh list              -> lists fork worktrees.
#   worktree.sh gc                -> prunes sync-* worktrees older than 1 day (stale-run cleanup).
#
# All paths are absolute. Errors are fatal (set -euo pipefail).
set -euo pipefail

FORK="${OPENTUI_FORK:-/home/daimon/side-quests/hermes-agent}"
BRANCH="origin/sid/opentui"
WT_ROOT="$HOME/projects/opentui-fork-maintainer/worktrees"

mkdir -p "$WT_ROOT"

cmd="${1:-}"

case "$cmd" in
  create)
    stamp="$(date -u +%Y%m%d-%H%M%S)"
    dest="$WT_ROOT/sync-$stamp"
    if [ -e "$dest" ]; then
      echo "worktree already exists: $dest" >&2
      exit 1
    fi
    # Detached worktree off the fetched remote tip.  The local daily-driver ref
    # and checkout are never touched by the maintainer.
    git -C "$FORK" worktree add --detach "$dest" "$BRANCH" >&2
    # Print the path as the LAST line so callers can `tail -1` it cleanly.
    echo "$dest"
    ;;

  remove)
    target="${2:-}"
    if [ -z "$target" ]; then
      # Most recent sync-* worktree.
      target="$(ls -1dt "$WT_ROOT"/sync-* 2>/dev/null | head -1 || true)"
    fi
    if [ -z "$target" ] || [ ! -d "$target" ]; then
      echo "no worktree to remove (target='$target')" >&2
      exit 0
    fi
    git -C "$FORK" worktree remove --force "$target" >&2
    echo "removed $target"
    ;;

  list)
    git -C "$FORK" worktree list
    ;;

  gc)
    # Prune sync-* worktrees older than 24h, then prune git's stale metadata.
    find "$WT_ROOT" -maxdepth 1 -name 'sync-*' -type d -mtime +0 -print 2>/dev/null | while read -r old; do
      echo "gc: removing stale worktree $old" >&2
      git -C "$FORK" worktree remove --force "$old" 2>/dev/null || rm -rf "$old"
    done
    git -C "$FORK" worktree prune >&2
    echo "gc done"
    ;;

  *)
    echo "usage: worktree.sh {create|remove [path]|list|gc}" >&2
    exit 2
    ;;
esac
