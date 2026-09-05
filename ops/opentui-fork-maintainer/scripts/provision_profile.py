#!/usr/bin/env python3
"""Provision the maintainer's isolated profile from explicitly selected assets.

Run with the managed Hermes Python and --apply after reviewing the printed plan.
Only OPENROUTER_API_KEY is copied from the credential source; no conversations,
personal memories, MCP connections, or other credentials are inherited.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

PROFILE = Path.home() / ".hermes/profiles/opentui-maintainer"
MODEL = "openai/gpt-6-astra"
SOURCE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SOURCE_ROOT.parents[1]


def _destination(path: Path) -> Path:
    root = Path(os.path.abspath(PROFILE))
    target = Path(os.path.abspath(path))
    if root.resolve() != root or target.resolve() != target or not target.is_relative_to(root):
        raise ValueError(f"Profile destination must be owned and contain no symlinks: {path}")
    return target


def _atomic_text(path: Path, text: str) -> None:
    path = _destination(path)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _validate_destinations(sources: dict[str, Path]) -> None:
    for name in ("config.yaml", ".env", "SOUL.md", "maintainer-environment.json",
                 "setup-backups", "skill-backups", "skills/maintenance"):
        _destination(PROFILE / name)
    for name in sources:
        _destination(PROFILE / "skills/maintenance" / name)


def skill_sources(dev_skill: Path) -> dict[str, Path]:
    agents = Path.home() / ".agents/skills"
    sources = {name: agents / name for name in (
        "terminal-control", "opentui", "opentui-tui-engineering",
        "effect-v4-production", "typescript-production-engineering", "before-and-after",
    )}
    sources["hermes-agent-dev"] = dev_skill
    for name in ("opentui-tui-engineering", "herdr-agent-testing"):
        sources[name] = SOURCE_ROOT / "skills" / name
    current_opentui = REPO_ROOT / ".repos/opentui/packages/web/src/content"
    if (current_opentui / "SKILL.md").is_file():
        sources["opentui"] = current_opentui
    return sources


def install_skills(sources: dict[str, Path], refresh: bool) -> None:
    _validate_destinations(sources)
    target_root = PROFILE / "skills/maintenance"
    target_root.mkdir(parents=True, exist_ok=True)
    selected = {name: source for name, source in sources.items()
                if refresh or not (target_root / name).exists()}
    with tempfile.TemporaryDirectory(prefix=".skill-staging-", dir=PROFILE) as staging:
        staged = Path(staging)
        for name, source in selected.items():
            shutil.copytree(source, staged / name)
        backup_root = None
        for name in selected:
            target = target_root / name
            previous = None
            if target.exists():
                if backup_root is None:
                    backups = PROFILE / "skill-backups"
                    backups.mkdir(exist_ok=True)
                    backup_root = Path(tempfile.mkdtemp(prefix="refresh-", dir=backups))
                previous = backup_root / name
                target.rename(previous)
            try:
                (staged / name).rename(target)
            except BaseException:
                if previous is not None:
                    previous.rename(target)
                raise


def install_soul(source: Path) -> None:
    target = _destination(PROFILE / "SOUL.md")
    _destination(PROFILE / "setup-backups")
    if target.is_file() and target.read_bytes() == source.read_bytes():
        return
    with tempfile.TemporaryDirectory(prefix=".soul-staging-", dir=PROFILE) as staging:
        staged = Path(staging) / "SOUL.md"
        shutil.copyfile(source, staged)
        os.chmod(staged, 0o600)
        if target.exists():
            backups = PROFILE / "setup-backups"
            backups.mkdir(exist_ok=True)
            backup = Path(tempfile.mkdtemp(prefix="soul-", dir=backups))
            shutil.copyfile(target, backup / "SOUL.md")
            os.chmod(backup / "SOUL.md", 0o600)
        staged.replace(target)


def provision(dev_skill: Path, credential_home: Path, apply: bool, refresh_skills: bool = False) -> dict:
    sources = skill_sources(dev_skill)
    missing = [str(path / "SKILL.md") for path in sources.values() if not (path / "SKILL.md").is_file()]
    soul = SOURCE_ROOT / "profile-SOUL.md"
    if not soul.is_file():
        missing.append(str(soul))
    if missing:
        raise ValueError("Missing skill sources: " + ", ".join(missing))
    plan = {
        "profile": str(PROFILE), "model": MODEL, "provider": "openrouter",
        "api_mode": "codex_responses", "compaction_tokens": 300_000,
        "credential_source": str(credential_home / ".env"),
        "credential_names": ["OPENROUTER_API_KEY"], "skills": list(sources),
        "applied": apply, "refresh_skills": refresh_skills,
    }
    if not apply:
        return plan

    _validate_destinations(sources)
    from dotenv import dotenv_values, set_key
    from ruamel.yaml import YAML
    from io import StringIO

    key = dotenv_values(credential_home / ".env").get("OPENROUTER_API_KEY")
    if not key:
        raise ValueError("Credential source has no OPENROUTER_API_KEY")
    if not (PROFILE / ".no-bundled-skills").exists():
        raise ValueError("Create opentui-maintainer with hermes profile create --no-skills --no-alias first")
    yaml = YAML()
    config_path = PROFILE / "config.yaml"
    config = yaml.load(config_path) if config_path.exists() else {}
    config = config or {}
    config["model"] = {"default": MODEL, "provider": "openrouter", "api_mode": "codex_responses"}
    config.setdefault("agent", {}).update({"reasoning_effort": "medium", "max_turns": 500})
    config.setdefault("compression", {}).update({"enabled": True, "threshold_tokens": 300_000})
    config["fallback_model"] = None
    config["mcp_servers"] = {}
    config.setdefault("terminal", {})["home_mode"] = "real"
    config.setdefault("display", {}).update({"tui_engine": "opentui", "tui_compact": True})
    config.setdefault("auxiliary", {})["compression"] = {"provider": "openrouter", "model": MODEL}
    config_text = StringIO()
    yaml.dump(config, config_text)
    _atomic_text(config_path, config_text.getvalue())
    secret_file = _destination(PROFILE / ".env")
    if not secret_file.exists():
        secret_file.touch(mode=0o600)
    os.chmod(secret_file, 0o600)
    set_key(str(secret_file), "OPENROUTER_API_KEY", key)
    install_skills(sources, refresh_skills)
    install_soul(soul)
    revisions = {}
    for name in ("opentui", "opencode", "effect", "executor", "anti-slop"):
        reference = REPO_ROOT / ".repos" / name
        if not reference.is_dir():
            continue
        sha = subprocess.run(["git", "-C", str(reference), "rev-parse", "HEAD"],
                             check=True, capture_output=True, text=True).stdout.strip()
        revisions[name] = {"path": str(reference), "sha": sha}
    manifest = {"sources": {name: str(path) for name, path in sources.items()},
                "references": revisions, "model": MODEL, "compaction_tokens": 300_000}
    _atomic_text(PROFILE / "maintainer-environment.json", json.dumps(manifest, indent=2) + "\n")
    return plan


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev-skill", type=Path, required=True)
    parser.add_argument("--credential-home", type=Path, default=Path.home() / ".hermes/profiles/demo")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--refresh-skills", action="store_true",
                        help="Back up and replace selected skills in the isolated profile only")
    args = parser.parse_args()
    print(json.dumps(provision(args.dev_skill, args.credential_home, args.apply, args.refresh_skills), indent=2))
