"""Publish synthetic acceptance evidence; never merge or update the target ref."""

from __future__ import annotations

import hashlib
import json
import os
import re
import struct
import subprocess
import tempfile
from pathlib import Path
from typing import Any

GH = Path("/home/daimon/.local/bin/gh")
FORMATTER = Path("/home/daimon/.agents/skills/before-and-after/scripts/format.mjs")
FORMATTER_SHA256 = "573f4c0e66e4d7010fdcd928dcca10915460a17e4df489d443be0812477dba59"
PROFILE = "/home/daimon/.hermes/profiles/opentui-maintainer"
REPOSITORY = "alt-glitch/hermes-agent"
BASE = "sid/opentui"
START = "<!-- before-and-after:start -->"
END = "<!-- before-and-after:end -->"
ATTACHMENT = re.compile(r"https://github\.com/user-attachments/assets/[a-zA-Z0-9-]+")
FIELDS = "number,url,body,headRefName,headRefOid,baseRefName,state"


class PublicationError(RuntimeError):
    pass


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _run(argv: list[str], cwd: Path) -> str:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=180)
    if result.returncode:
        # gh diagnostics can include submitted bodies; do not echo them into logs.
        raise PublicationError(
            f"publication command failed: {Path(argv[0]).name} {argv[1]}"
        )
    return result.stdout


def _write(path: Path, value: str) -> None:
    if path.is_symlink():
        raise PublicationError("publication state must not be a symlink")
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".pr-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _file(root: Path, value: str, digest: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.is_symlink() or path.resolve() != path:
        raise PublicationError("preview evidence path is not canonical")
    if not path.is_relative_to(root) or not path.is_file() or _hash(path) != digest:
        raise PublicationError("preview evidence escaped or changed")
    return path


def preview(root: Path, manifest: dict[str, Any]) -> tuple[Path, str, tuple[int, int]]:
    checks = [c for c in manifest["checks"] if c["id"] == "termctrl-smoke"]
    if len(checks) != 1 or checks[0]["status"] != "passed":
        raise PublicationError("preview requires a passed runtime capture")
    check = checks[0]
    log = _file(root, check["output_path"], check["output_sha256"])
    proof = json.loads(log.read_text(encoding="utf-8"))
    if proof.get("publication_scope") != {
        "profile": PROFILE,
        "flow": "synthetic-startup-help",
        "personal_history": False,
        "environment": "allowlist-v1",
    }:
        raise PublicationError(
            "refusing upload: capture is not the isolated synthetic help flow"
        )
    path = _file(root, proof["png_path"], proof["png_sha256"])
    if path != root / "termctrl-verified/accepted.png":
        raise PublicationError("preview must be the runtime accepted frame")
    text = _file(root, proof["text_path"], proof["text_sha256"]).read_text(
        encoding="utf-8"
    )
    if "Available Commands" not in text or re.search(
        r"(?i)(sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._-]{12,}|api[_ -]?key\s*[=:])", text
    ):
        raise PublicationError("accepted frame failed the synthetic text safety check")
    data = path.read_bytes()
    if (
        len(data) < 24
        or len(data) > 10_000_000
        or data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    ):
        raise PublicationError("accepted frame is not a bounded PNG")
    dimensions = struct.unpack(">II", data[16:24])
    if not all(0 < n <= 8192 for n in dimensions):
        raise PublicationError("accepted frame dimensions are invalid")
    return path, proof["png_sha256"], dimensions


def _block(body: str) -> str | None:
    if START not in body and END not in body:
        return None
    if (
        body.count(START) != 1
        or body.count(END) != 1
        or body.index(END) < body.index(START)
    ):
        raise PublicationError("PR contains ambiguous evidence markers")
    return body[body.index(START) : body.index(END) + len(END)]


def _replace(body: str, block: str) -> str:
    old = _block(body)
    if old is not None:
        return body.replace(old, block, 1)
    return body + ("\n\n" if body else "") + block


def _validate_pr(pr: dict[str, Any], head: str, candidate: str) -> None:
    if (
        pr.get("headRefName") != head
        or pr.get("headRefOid") != candidate
        or pr.get("baseRefName") != BASE
        or pr.get("state") != "OPEN"
        or not isinstance(pr.get("number"), int)
        or pr.get("url") != f"https://github.com/{REPOSITORY}/pull/{pr.get('number')}"
    ):
        raise PublicationError("PR does not bind the open expected base/head candidate")


def _published_block(body: str, identity: str) -> tuple[str, str] | None:
    block = _block(body)
    if block is None or identity not in block:
        return None
    urls = ATTACHMENT.findall(block)
    if len(urls) != 1 or "![Preview](" + urls[0] + ")" not in block:
        return None
    if "./" in block or "file:" in block or "/home/" in block:
        raise PublicationError("published evidence still contains a local reference")
    return block, urls[0]


def publish_preview(
    repo: Path,
    root: Path,
    manifest: dict[str, Any],
    *,
    node: Path,
    remote: str = "origin",
) -> dict[str, Any]:
    """Idempotently create the candidate PR and attach one proven synthetic PNG.

    The create-only head branch is separate from sid/opentui. The caller alone
    owns the target-ref CAS, after this function returns verified evidence.
    """
    root = root.resolve()
    png, digest, dimensions = preview(root, manifest)
    if manifest.get("branch") != BASE:
        raise PublicationError("PR publication only supports the OpenTUI fork branch")
    version = _run([str(GH), "--version"], root)
    if not version.startswith("gh version 2.100.0 "):
        raise PublicationError(
            "publication requires the verified gh 2.100.0 attachment CLI"
        )
    if not FORMATTER.is_file() or _hash(FORMATTER) != FORMATTER_SHA256:
        raise PublicationError(
            "installed before-and-after formatter changed; revalidate it"
        )
    destination = _run(
        ["git", "remote", "get-url", "--push", "--all", remote], repo
    ).strip()
    if destination not in {
        f"https://github.com/{REPOSITORY}.git",
        f"git@github.com:{REPOSITORY}.git",
        f"https://github.com/{REPOSITORY}",
    }:
        raise PublicationError("refusing candidate push to an untrusted remote")
    candidate, base = manifest["candidate_sha"], manifest["base_sha"]
    if not all(re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (candidate, base)):
        raise PublicationError("invalid candidate/base identity")
    run_id = hashlib.sha256(
        (manifest["lease_token_sha256"] + base + candidate).encode()
    ).hexdigest()[:24]
    head = f"codex/opentui-maint-{run_id}"
    ref = f"refs/heads/{head}"
    existing = _run(["git", "ls-remote", destination, ref], repo).strip()
    if existing and existing.split() != [candidate, ref]:
        raise PublicationError("run branch already points at a different candidate")
    if not existing:
        _run(
            [
                "git",
                "push",
                "--porcelain",
                f"--force-with-lease={ref}:",
                destination,
                f"{candidate}:{ref}",
            ],
            repo,
        )
    gh = [str(GH), "pr"]
    options = ["--repo", REPOSITORY]
    prs = json.loads(
        _run(
            gh
            + [
                "list",
                *options,
                "--state",
                "all",
                "--head",
                head,
                "--base",
                BASE,
                "--json",
                FIELDS,
            ],
            root,
        )
    )
    if not prs:
        body = (
            f"Automated OpenTUI maintenance candidate `{candidate}` from `{base}`.\n\n"
            "Preview is startup/help regression proof from the isolated synthetic profile, "
            "not a before/after claim about changed UI behavior.\n\n"
            "All required code, independent review, terminal, and video gates passed. "
            "The maintainer publishes only through its guarded target-branch CAS.\n"
        )
        _write(root / "pr-body.md", body)
        _run(
            gh
            + [
                "create",
                *options,
                "--base",
                BASE,
                "--head",
                head,
                "--title",
                f"chore(opentui): maintainer candidate {candidate[:12]}",
                "--body-file",
                str(root / "pr-body.md"),
            ],
            root,
        )
        prs = json.loads(
            _run(
                gh
                + [
                    "list",
                    *options,
                    "--state",
                    "all",
                    "--head",
                    head,
                    "--base",
                    BASE,
                    "--json",
                    FIELDS,
                ],
                root,
            )
        )
    if len(prs) != 1:
        raise PublicationError("expected exactly one run-scoped PR")
    pr = prs[0]
    _validate_pr(pr, head, candidate)
    identity = f"<!-- maintainer-preview:{candidate}:{digest} -->"
    published = _published_block(pr["body"], identity)
    if published is None:
        formatter = [
            str(node),
            str(FORMATTER),
            "--after",
            str(png),
            "--label",
            "Synthetic startup/help regression proof",
        ]
        attachments = _run([*formatter, "--attach-list"], root).splitlines()
        if attachments != ["./termctrl-verified/accepted.png"]:
            raise PublicationError(
                "formatter attachment list does not match proven media"
            )
        block = _run(formatter, root).strip()
        if (
            _block(block) != block
            or "![Preview](./termctrl-verified/accepted.png)" not in block
        ):
            raise PublicationError("formatter violated the verified Preview contract")
        block = block.replace(START, START + "\n" + identity, 1)
        _write(root / "pr-body.md", _replace(pr["body"], block))
        # Revalidate bytes immediately before the upload boundary.
        preview(root, manifest)
        _run(
            gh
            + [
                "edit",
                str(pr["number"]),
                *options,
                "--body-file",
                str(root / "pr-body.md"),
                "--attach",
                attachments[0],
            ],
            root,
        )
    pr = json.loads(
        _run(gh + ["view", str(pr["number"]), *options, "--json", FIELDS], root)
    )
    _validate_pr(pr, head, candidate)
    published = _published_block(pr["body"], identity)
    if published is None:
        raise PublicationError(
            "PR attachment was not acknowledged; refusing target publication"
        )
    block, url = published
    proof = {
        "schema_version": 1,
        "repository": REPOSITORY,
        "base_branch": BASE,
        "base_sha": base,
        "candidate_sha": candidate,
        "head_branch": head,
        "number": pr["number"],
        "url": pr["url"],
        "preview_sha256": digest,
        "preview_dimensions": list(dimensions),
        "attachment_url": url,
        "block_sha256": hashlib.sha256(block.encode()).hexdigest(),
        "formatter_sha256": FORMATTER_SHA256,
        "gh_version": "2.100.0",
        "scope": "synthetic-startup-help",
    }
    _write(root / "pr-evidence.json", json.dumps(proof, indent=2) + "\n")
    return proof
