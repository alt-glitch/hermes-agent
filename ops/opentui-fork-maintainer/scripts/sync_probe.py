#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""OpenTUI fork-maintainer ingest probe.

Runs BEFORE the maintainer agent each cron tick. Fetches upstream + origin,
computes how far `sid/opentui` lags `upstream/main`, classifies each new
upstream commit by which surface it touches, and emits a JSON data file.

Commit subjects, authors, patch text, and file names are intentionally omitted.
They are repository-controlled prose and must never be interpolated into a cron
prompt. The maintainer can inspect a bounded diff by SHA after reading this
machine-generated classification.

Stdlib only — runs under `uv run` with no deps to resolve.

POLICY (2026-06-29, glitch): this is a TUI fork. The agent loop and prompt-cache
behavior are UPSTREAM's responsibility and are TRUSTED — agent-loop / cache /
role-alternation changes do NOT trigger a defer. The maintainer's ONLY job is
keeping the OpenTUI engine at feature parity with the Ink TUI + the gateway
contract it consumes. So the work signal is an unported TUI/gateway feature (`needs_port`),
not a cache surface touch.

Surface → engine-concern mapping (the inverted parity lens):
  - ui-tui/                          -> Ink TUI feature; may need PORT into ui-opentui/src/view/
  - tui_gateway/                     -> gateway RPC/contract the engine consumes via src/boundary/
  - agent/, run_agent.py,            -> agent-loop feature; TRUSTED (upstream-owned). Flows to BOTH
    agent/conversation_loop.py          engines via the gateway; no engine change and NO defer.
                                        (A contract change that the engine must mirror shows up as a
                                        tui_gateway/ touch, which is where it's flagged — not here.)
  - ui-opentui/                      -> the engine itself; upstream rarely touches it -> conflict risk.
  - everything else                  -> plain merge, no port.

Exit code is always 0 on a successful probe (even up_to_date); non-zero only
on a hard git failure so the cron wrapper can surface it.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

FORK = Path(os.environ.get("OPENTUI_FORK", "/home/daimon/side-quests/hermes-agent"))
BRANCH = "origin/sid/opentui"
UPSTREAM = "upstream/main"
STATE_DIR = Path(
    os.environ.get(
        "OPENTUI_MAINTAINER_STATE_DIR",
        Path(__file__).resolve().parent.parent / "state",
    )
)
LAST_SYNCED_FILE = STATE_DIR / "last_synced_upstream.sha"

# Files whose change in an upstream commit means the engine likely has to react.
# Keys are git path prefixes; values are the engine concern + whether it implies a port.
SURFACE_RULES: list[tuple[str, str, bool]] = [
    # prefix,                       surface label,          needs_port (default flag)
    ("ui-tui/", "ui-tui", True),  # Ink TUI feature -> candidate port into view/
    ("tui_gateway/", "tui_gateway", True),  # gateway contract the engine consumes
    (
        "ui-opentui/",
        "ui-opentui",
        False,
    ),  # the engine itself -> conflict risk, not a port
    # agent-loop is UPSTREAM-OWNED + TRUSTED: it gets a surface label for the digest,
    # but needs_port=False and it never feeds contract_review (see CONTRACT_REVIEW_HINTS).
    ("agent/conversation_loop.py", "agent-loop", False),
    ("agent/", "agent-loop", False),
    ("run_agent.py", "agent-loop", False),
]

# Substrings within a touched path that require explicit contract review.
# Gateway event/RPC schema changes are implementation work: they remain port
# candidates and receive a visible marker so the reducer/decoder is audited. Note these all live
# under tui_gateway/ or gateway/schema (the contract), NOT under agent/.
CONTRACT_REVIEW_HINTS = (
    "gateway/schema",
    "boundary/schema",
    "tui_gateway/protocol",
    "tui_gateway/events",
)


def run(args: list[str], check: bool = True) -> str:
    """Run a git command in the fork, return stdout stripped."""
    res = subprocess.run(
        args,
        cwd=str(FORK),
        capture_output=True,
        text=True,
        timeout=180,
    )
    if check and res.returncode != 0:
        raise RuntimeError(
            f"command failed ({res.returncode}): {' '.join(args)}\n{res.stderr.strip()}"
        )
    return res.stdout.strip()


def classify_paths(paths: list[str]) -> tuple[str, bool]:
    """Return (surface_label, needs_port) for a commit's changed paths.

    Picks the highest-priority surface among all touched files. ui-tui /
    tui_gateway dominate (they imply mirroring work); agent-loop next; the
    rest fall through to 'other'. needs_port is True only when a portable
    TUI/gateway surface was touched. Contract surfaces remain port candidates.
    """
    contract_review = any(h in p for p in paths for h in CONTRACT_REVIEW_HINTS)
    matched: list[tuple[int, str, bool]] = []
    for p in paths:
        for prio, (prefix, label, port) in enumerate(SURFACE_RULES):
            if p.startswith(prefix):
                matched.append((prio, label, port))
                break
    if not matched:
        return ("other", False)
    # lowest prio index = highest priority rule
    matched.sort(key=lambda t: t[0])
    _, label, port = matched[0]
    if contract_review:
        # Engine-facing contract surface: mark the change for explicit contract review and porting.
        return (f"{label}!contract", True)
    return (label, port)


def summarize_paths(paths: list[str]) -> dict[str, object]:
    """Summarize repository-controlled paths without emitting their text."""
    categories: dict[str, int] = {}
    hashes: list[str] = []
    for path in sorted(set(path for path in paths if path.strip())):
        category, _ = classify_paths([path])
        categories[category] = categories.get(category, 0) + 1
        hashes.append(
            hashlib.sha256(path.encode("utf-8", "surrogateescape")).hexdigest()
        )
    return {"count": len(hashes), "categories": categories, "sha256": hashes}


def main() -> int:
    if not (FORK / ".git").exists():
        print(json.dumps({"status": "error", "error": f"not a git repo: {FORK}"}))
        return 1

    # 1. Fetch both remotes. Hard-fail if upstream is unreachable.
    try:
        run(["git", "fetch", "upstream", "--quiet"])
        run(["git", "fetch", "origin", "--quiet"])
    except RuntimeError as e:
        print(json.dumps({"status": "error", "error": f"fetch failed: {e}"}))
        return 1

    branch_sha = run(["git", "rev-parse", BRANCH])
    upstream_sha = run(["git", "rev-parse", UPSTREAM])

    # 2. Compute the gap (new upstream commits not yet on the branch).
    gap_out = run(["git", "rev-list", "--count", f"{BRANCH}..{UPSTREAM}"])
    gap = int(gap_out or "0")

    last_synced = (
        LAST_SYNCED_FILE.read_text().strip() if LAST_SYNCED_FILE.exists() else None
    )

    base = {
        "status": "up_to_date" if gap == 0 else "behind",
        "fork": str(FORK),
        "branch": BRANCH,
        "branch_sha": branch_sha,
        "upstream_sha": upstream_sha,
        "last_synced_upstream": last_synced,
        "gap": gap,
    }

    if gap == 0:
        print(json.dumps(base))
        return 0

    # 3. Classify each new upstream commit (oldest first = merge order).
    raw = run([
        "git",
        "log",
        "--reverse",
        "--no-merges",
        "--format=%H",
        f"{BRANCH}..{UPSTREAM}",
    ])
    commits = []
    surfaces_seen: dict[str, int] = {}
    needs_port_any = False
    contract_review_any = False
    for sha in raw.splitlines():
        sha = sha.strip()
        if not sha:
            continue
        # diff-tree is the canonical "files changed in this commit" command;
        # `git show --name-only` clashes with the `-s/--no-patch` we'd want to
        # suppress the diff body. -r recurses into subtrees; --no-commit-id
        # drops the leading SHA line so we get a clean path list.
        paths = run([
            "git",
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            sha,
        ]).splitlines()
        paths = [p for p in paths if p.strip()]
        surface, needs_port = classify_paths(paths)
        if "!contract" in surface:
            contract_review_any = True
        if needs_port:
            needs_port_any = True
        surfaces_seen[surface] = surfaces_seen.get(surface, 0) + 1
        commits.append({
            "sha": sha[:12],
            "surface": surface,
            "needs_port": needs_port,
            "n_files": len(paths),
        })

    # 4. Conflict-risk files: upstream commits that touched ui-opentui/ (the engine).
    #    Upstream "never" touches it, so any hit is a real conflict signal.
    engine_touch = run([
        "git",
        "log",
        "--format=",
        "--name-only",
        f"{BRANCH}..{UPSTREAM}",
        "--",
        "ui-opentui/",
    ])
    conflict_risk = summarize_paths(engine_touch.splitlines())

    # 5. Dry-run merge prediction (read-only — `git merge-tree` simulates the merge
    #    in memory, never touches the working tree or any ref, so it's safe in the
    #    probe). Surfaces conflicts BEFORE the agent spins a worktree, and classifies
    #    whether every conflicted file is a TEST file (path contains 'test' and ends
    #    .py/.test.ts/.test.tsx). Test-only conflicts are usually the additive
    #    keep-both shape the agent can auto-resolve; a non-test conflict requires deliberate
    #    semantic resolution. This is a HINT — the agent still does the real merge + diff3
    #    audit + gate before trusting it.
    conflict_files: list[str] = []
    likely_trivial_conflict = False
    merge_prediction = "clean"
    try:
        # Modern `git merge-tree --write-tree` exits non-zero on conflict and lists
        # conflicted paths under an "Conflicting files:" / info section. We parse the
        # name-status form for robustness across git versions.
        mt = subprocess.run(
            ["git", "merge-tree", "--write-tree", "--name-only", BRANCH, UPSTREAM],
            cwd=str(FORK),
            capture_output=True,
            text=True,
            timeout=180,
        )
        if mt.returncode == 0:
            merge_prediction = "clean"
        else:
            merge_prediction = "conflict"
            # `git merge-tree --write-tree` (git >=2.38) emits an informational
            # section: a leading tree oid, then "Auto-merging <path>" lines and
            # "CONFLICT (<type>): Merge conflict in <path>" lines (and other CONFLICT
            # variants: "CONFLICT (modify/delete): <path> ...", rename conflicts,
            # etc.). The ONLY lines that name a genuinely-conflicted file are the
            # "CONFLICT" ones — "Auto-merging" means it merged cleanly. Parse the
            # conflicted path out of each CONFLICT line.
            import re as _re

            for ln in (mt.stdout or "").splitlines():
                ln = ln.strip()
                if not ln.startswith("CONFLICT"):
                    continue
                # Common forms:
                #   CONFLICT (content): Merge conflict in <path>
                #   CONFLICT (modify/delete): <path> deleted in ... and modified in ...
                #   CONFLICT (rename/rename): ...
                m = _re.search(r"Merge conflict in (.+)$", ln)
                if m:
                    conflict_files.append(m.group(1).strip())
                    continue
                m = _re.search(r"CONFLICT \([^)]*\): ([^\s]+)", ln)
                if m:
                    conflict_files.append(m.group(1).strip())
            conflict_files = sorted(set(conflict_files))

            def _is_test_file(p: str) -> bool:
                return "test" in p.lower() and (
                    p.endswith(".py")
                    or p.endswith(".test.ts")
                    or p.endswith(".test.tsx")
                )

            likely_trivial_conflict = bool(conflict_files) and all(
                _is_test_file(p) for p in conflict_files
            )
    except Exception:
        # Prediction is best-effort; never fail the probe over it.
        merge_prediction = "unknown"

    base.update({
        "commits": commits,
        "surfaces": surfaces_seen,
        "needs_port_any": needs_port_any,
        "contract_review_any": contract_review_any,
        "conflict_risk": conflict_risk,
        # Dry-run merge hints (read-only prediction; agent still verifies live):
        "merge_prediction": merge_prediction,  # "clean" | "conflict" | "unknown"
        "predicted_conflicts": summarize_paths(conflict_files),
        "likely_trivial_conflict": likely_trivial_conflict,  # all conflicts are test files
        # The agent's first-glance recommendation; it still runs the gate to decide.
        "auto_merge_candidate": (not needs_port_any) and (conflict_risk["count"] == 0),
    })
    print(json.dumps(base))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # surface any unexpected failure as JSON for the agent
        print(json.dumps({"status": "error", "error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
