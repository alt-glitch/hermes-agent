#!/usr/bin/env python3
"""Refresh owned, shallow reference checkouts without changing runtime dependencies."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess

REFERENCES = {
    "opentui": ("https://github.com/anomalyco/opentui.git", "main"),
    "opencode": ("https://github.com/anomalyco/opencode.git", "v2"),
    "effect": ("https://github.com/Effect-TS/effect.git", "main"),
    "executor": ("https://github.com/RhysSullivan/executor.git", "main"),
    "anti-slop": ("https://github.com/dmmulroy/anti-slop.git", "main"),
}


def git(*args: str) -> str:
    return subprocess.run(["git", "--no-optional-locks", *args], check=True, capture_output=True,
                          text=True, timeout=180).stdout.strip()


def prepare(root: Path, names: list[str], refresh: bool) -> dict:
    root = Path(os.path.abspath(root))
    if root.resolve() != root:
        raise ValueError("Reference root must not contain a symlink")
    results = {}
    for name in names:
        remote, branch = REFERENCES[name]
        path = root / name
        if path.is_symlink():
            raise ValueError(f"Reference checkout must not be a symlink: {path}")
        if path.exists():
            if git("-C", str(path), "rev-parse", "--show-toplevel") != str(path.resolve()):
                raise ValueError(f"Not an independent reference checkout: {path}")
            if git("-C", str(path), "remote", "get-url", "origin") != remote:
                raise ValueError(f"Reference origin does not match the allowlist: {name}")
            if git("-C", str(path), "status", "--porcelain", "--untracked-files=all", "--ignored"):
                raise ValueError(f"Reference checkout has local work: {name}")
        elif refresh:
            root.mkdir(parents=True, exist_ok=True)
            git("clone", "--depth", "1", "--branch", branch, remote, str(path))
        else:
            results[name] = {"remote": remote, "branch": branch, "available": False}
            continue
        if refresh:
            git("-C", str(path), "fetch", "--depth", "1", "origin", branch)
            git("-C", str(path), "checkout", "--detach", "FETCH_HEAD")
        results[name] = {"remote": remote, "branch": branch,
                         "path": str(path.resolve()), "sha": git("-C", str(path), "rev-parse", "HEAD")}
    return {"checked_at": datetime.now(timezone.utc).isoformat(),
            "refreshed": refresh, "references": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd() / ".repos")
    parser.add_argument("--only", choices=REFERENCES, nargs="+")
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    print(json.dumps(prepare(args.root, args.only or list(REFERENCES), args.refresh), indent=2))
