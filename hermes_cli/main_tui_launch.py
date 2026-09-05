"""TUI (ui-tui) launcher: node/npm bootstrap, workspace/rebuild checks, argv/env assembly.

Split out of ``hermes_cli/main.py``. Names that still live in main (``PROJECT_ROOT``, ...)
are imported lazily inside the functions that use them (avoids an import cycle).
"""

import logging
import contextlib
import json
import os
import shutil
import subprocess
import sys

from hermes_cli import opentui_runtime as _opentui_runtime
from hermes_cli.config import get_hermes_home

from pathlib import Path
from typing import Optional

# Log-record parity with the origin module.
logger = logging.getLogger("hermes_cli.main")


def _read_tui_active_session_file(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return str(data.get("session_id") or "").strip() or None
    except Exception:
        return None


def _tui_active_session_file_is_detached(path: Optional[str]) -> bool:
    """Whether the TUI explicitly closed its session without a replacement."""
    if not path:
        return False
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data.get("detached") is True
    except Exception:
        return False


def _print_tui_exit_summary(session_id: Optional[str], active_session_file: Optional[str] = None) -> None:
    """Print a shell-visible epilogue after TUI exits."""
    if _tui_active_session_file_is_detached(active_session_file):
        return
    from hermes_cli.main import _resolve_last_session
    target = (
        _read_tui_active_session_file(active_session_file) or session_id or _resolve_last_session(source="tui")
    )
    if not target:
        return

    db = None
    try:
        from hermes_state import SessionDB
        db = SessionDB()
        session = db.get_session(target)
        if not session:
            return

        title = db.get_session_title(target)
        message_count = int(session.get("message_count") or 0)
        if message_count == 0:
            return  # No real conversation — don't show resume info
        tokens = {
            k: int(session.get(f"{k}_tokens") or 0)
            for k in ("input", "output", "cache_read", "cache_write", "reasoning")}
    except Exception:
        return
    finally:
        if db is not None:
            db.close()

    print(f"\nResume this session with:\n  hermes --tui --resume {target}")
    if title:
        print(f'  hermes --tui -c "{title}"')
    print(f"\nSession:        {target}")
    if title:
        print(f"Title:          {title}")
    print(f"Messages:       {message_count}")
    print(
        "Tokens:         "
        f"{sum(tokens.values())} (in {tokens['input']}, out {tokens['output']}, "
        f"cache {tokens['cache_read'] + tokens['cache_write']}, reasoning {tokens['reasoning']})"
    )


_NPM_LOCK_RUNTIME_KEYS = frozenset({"ideallyInert", "peer", "dev", "extraneous", "hasInstallScript", "optional"})
"""Lockfile fields npm writes non-deterministically at install time.

``ideallyInert`` marks packages npm skipped (per-platform opt-outs); ``peer`` is
dropped from the hidden ``.package-lock.json`` on dev-deps that are also peers.
``dev`` / ``optional`` / ``extraneous`` / ``hasInstallScript`` are boolean
annotations npm populates differently in the hidden lock (npm >= 10/11), and
may differ even when present in both. None indicate a real declared-vs-installed
skew — the authoritative check is the ``resolved``/``integrity`` pair, which the
intersection comparison in :func:`_tui_need_npm_install` always catches.
"""


def _workspace_root(dir: Path) -> Path:
    """The npm workspace root for *dir*: its parent when *dir* has ``package.json`` but the
    lockfile lives one level up (hoisted node_modules), else *dir* (standalone / prebuilt).
    Shared by the install check, TUI launcher and web build so their cwd can't diverge."""
    if (
        (dir / "package.json").is_file()
        and not (dir / "package-lock.json").is_file()
        and (dir.parent / "package-lock.json").is_file()):
        return dir.parent
    return dir


def _child_workspace_dirs(dir: Path):
    """Sorted ``dir/packages/*`` subdirs that carry a ``package.json``."""
    packages_dir = dir / "packages"
    if not packages_dir.is_dir():
        return
    for child in sorted(packages_dir.iterdir()):
        if child.is_dir() and (child / "package.json").is_file():
            yield child


def _termux_workspace_install_context(
    dir: Path, *, include_child_workspaces: bool = False) -> tuple[Path, tuple[str, ...]]:
    """Return Termux-only ``(cwd, npm_args)`` for installing deps for *dir* only."""
    ws_root = _workspace_root(dir)
    if ws_root == dir:
        return dir, ()

    try:
        workspace = dir.relative_to(ws_root).as_posix()
    except ValueError:
        return ws_root, ()

    workspace_args: list[str] = ["--workspace", workspace]
    if include_child_workspaces:
        for child in _child_workspace_dirs(dir):
            workspace_args.extend(["--workspace", child.relative_to(ws_root).as_posix()])
    workspace_args.append("--include-workspace-root=false")
    return ws_root, tuple(workspace_args)


def _npm_lock_workspace_closure(packages: dict, starts) -> Optional[set]:
    """Package-map keys reachable from the selected workspaces (*starts*: set or str) via npm resolution.

    ``devDependencies`` are followed for each start (npm installs every selected
    workspace's dev toolchain) but not for transitive deps. None when no start is
    in *packages* so callers fall back to the full comparison — which would report
    every OTHER workspace's deps (``apps/desktop``, ``web``) as missing and
    reinstall on every launch. Names resolve by walking up ``node_modules``
    ancestors; ``link: true`` entries are followed to their real package.

    The launch install is scoped with ``npm install --workspace ui-tui`` (see ``_make_tui_argv``), so only
    the ui-tui workspace's dependency closure is written to the hidden ``.package-lock.json``. On Termux it
    additionally selects ui-tui's child ``packages/*`` workspaces, so their devDependencies join the closure
    too. See #66978.
    """
    start_set = {starts} if isinstance(starts, str) else {s for s in starts if s}
    present = [s for s in start_set if s in packages]
    if not present:
        return None

    def resolve(from_key: str, dep: str) -> Optional[str]:
        base = from_key
        while True:
            candidate = f"{base}/node_modules/{dep}" if base else f"node_modules/{dep}"
            if candidate in packages:
                return candidate
            if not base:
                return None
            base = base.rsplit("/", 1)[0] if "/" in base else ""

    seen: set = set()
    stack = list(present)
    while stack:
        key = stack.pop()
        if key in seen:
            continue
        seen.add(key)
        entry = packages.get(key)
        if not isinstance(entry, dict):
            continue
        resolved = entry.get("resolved")
        if entry.get("link") and isinstance(resolved, str) and resolved in packages:
            stack.append(resolved)
        fields = ["dependencies", "optionalDependencies", "peerDependencies"]
        if key in start_set:
            fields.append("devDependencies")
        for field in fields:
            deps = entry.get(field)
            if not isinstance(deps, dict):
                continue
            for dep in deps:
                target = resolve(key, dep)
                if target is not None:
                    stack.append(target)
    return seen


def _tui_selected_workspace_keys(tui_dir: Path, ws_root: Path) -> set:
    """Lock-map keys the launch install scopes to: ui-tui, plus its child ``packages/*`` on Termux
    (each a dev-included closure root). Empty when ui-tui isn't under *ws_root*."""
    from hermes_cli.main import _is_termux_startup_environment
    try:
        keys = {tui_dir.relative_to(ws_root).as_posix()}
    except ValueError:
        return set()
    if _is_termux_startup_environment():
        for child in _child_workspace_dirs(tui_dir):
            try:
                keys.add(child.relative_to(ws_root).as_posix())
            except ValueError:
                continue
    return keys


def _tui_need_npm_install(root: Path) -> bool:
    """True when @hermes/ink is missing or node_modules is behind package-lock.json.

    Prebuilt bundle (``dist/entry.js``, no lockfile): nothing to install. The root
    lock is compared to npm's hidden ``node_modules/.package-lock.json`` by CONTENT
    (git bumps mtimes without changing deps): missing from hidden → reinstall
    unless ``optional``/``peer``/``link`` or outside ``node_modules/``; present in
    both → compare the intersection of non-null fields minus
    ``_NPM_LOCK_RUNTIME_KEYS`` (``resolved``/``integrity`` are always in both).
    Hidden-only entries are ignored; unparseable lockfiles fall back to mtime.
    """
    entry = root / "dist" / "entry.js"
    ws_root = _workspace_root(root)
    lock = ws_root / "package-lock.json"
    if entry.is_file() and not lock.is_file():
        return False

    if not (ws_root / "node_modules" / "@hermes" / "ink" / "package.json").is_file():
        return True
    if not lock.is_file():
        return False
    marker = ws_root / "node_modules" / ".package-lock.json"
    if not marker.is_file():
        return True

    try:
        wanted = json.loads(lock.read_text(encoding="utf-8")).get("packages") or {}
        installed = json.loads(marker.read_text(encoding="utf-8")).get("packages") or {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return lock.stat().st_mtime > marker.stat().st_mtime

    def entries_differ(pkg: dict, installed_pkg: dict) -> bool:
        a = {k: v for k, v in pkg.items() if k not in _NPM_LOCK_RUNTIME_KEYS}
        b = {k: v for k, v in installed_pkg.items() if k not in _NPM_LOCK_RUNTIME_KEYS}
        return any(a[k] is not None and b[k] is not None and a[k] != b[k] for k in a.keys() & b.keys())

    # Shared workspace checkout: the launch install is scoped to ui-tui (+ child
    # packages on Termux), so limit the comparison to that closure. Standalone /
    # own-lockfile layouts do a full install and keep the full comparison.
    # Limit the comparison to the same selected-workspace closure so unrelated workspace deps (apps/desktop,
    # web, …) don't force a reinstall every launch (#66978).
    closure: Optional[set] = None
    if ws_root != root:
        selected = _tui_selected_workspace_keys(root, ws_root)
        if selected:
            closure = _npm_lock_workspace_closure(wanted, selected)

    for name, pkg in wanted.items():
        if not name or (closure is not None and name not in closure) or not isinstance(pkg, dict):
            continue
        if name not in installed:
            # Workspace link entries are never materialized by a partial
            # `npm install --workspace ui-tui`; don't force a reinstall for them.
            # Workspace link entries (`"link": true`, paths outside node_modules/ like `apps/desktop`,
            # `node_modules/web`) are never materialized by a partial `npm install --workspace ui-tui` —
            # they're deliberately skipped (see #38772) and would otherwise force a reinstall on every
            # launch.
            if pkg.get("optional") or pkg.get("peer") or pkg.get("link"):
                continue
            if not name.startswith("node_modules/"):
                continue
            return True
        if isinstance(installed[name], dict) and entries_differ(pkg, installed[name]):
            return True

    return False


_TUI_BUILD_INPUT_DIRS = ("src", "packages/hermes-ink/src")

_TUI_BUILD_INPUT_FILES = (
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "babel.compiler.config.cjs",
    "scripts/build.mjs",
    "packages/hermes-ink/package.json",
    "packages/hermes-ink/index.js",
    "packages/hermes-ink/text-input.js",
)

_TUI_BUILD_INPUT_SUFFIXES = frozenset({".cjs", ".js", ".jsx", ".json", ".mjs", ".ts", ".tsx"})


def _iter_tui_build_inputs(root: Path):
    """Yield source/config files that affect ``ui-tui/dist/entry.js``."""
    for rel in _TUI_BUILD_INPUT_FILES:
        path = root / rel
        if path.is_file():
            yield path

    for rel in _TUI_BUILD_INPUT_DIRS:
        base = root / rel
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if path.is_file() and path.suffix in _TUI_BUILD_INPUT_SUFFIXES:
                yield path


def _tui_need_rebuild(root: Path) -> bool:
    """True when ``dist/entry.js`` is missing or older than TUI inputs (Termux cold-start saver);
    ``HERMES_TUI_FORCE_BUILD=1`` forces a rebuild."""
    force = (os.environ.get("HERMES_TUI_FORCE_BUILD") or "").strip().lower()
    if force in {"1", "true", "yes", "on"}:
        return True

    try:
        output_mtime = (root / "dist" / "entry.js").stat().st_mtime
    except OSError:
        return True

    for path in _iter_tui_build_inputs(root):
        try:
            if path.stat().st_mtime > output_mtime:
                return True
        except OSError:
            return True
    return False


def _ensure_tui_node() -> None:
    """Ensure `node` + `npm` are on PATH: else run node-bootstrap.sh `ensure_node` and prepend
    the resolved node dir to PATH. ``HERMES_SKIP_NODE_BOOTSTRAP=1`` disables auto-install."""
    from hermes_cli.main import PROJECT_ROOT
    if shutil.which("node") and shutil.which("npm"):
        return
    if os.environ.get("HERMES_SKIP_NODE_BOOTSTRAP"):
        return

    helper = PROJECT_ROOT / "scripts" / "lib" / "node-bootstrap.sh"
    if not helper.is_file():
        return

    from hermes_constants import get_hermes_home
    hermes_home = str(get_hermes_home())
    try:
        # Helper logs to stderr; stdout carries `command -v node` — subshell PATH
        # edits don't leak back into Python, so the capture is the bridge.
        result = subprocess.run(
            ["bash", "-c", f'source "{helper}" >&2 && ensure_node >&2 && command -v node'],
            env={**os.environ, "HERMES_HOME": hermes_home},
            capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)
    except (OSError, subprocess.SubprocessError):
        return

    parts = os.environ.get("PATH", "").split(os.pathsep)
    resolved = (result.stdout or "").strip()
    extras = [Path(resolved).resolve().parent] if resolved else []
    extras += [Path(hermes_home) / "node" / "bin", Path.home() / ".local" / "bin"]
    for extra in extras:
        s = str(extra)
        if extra.is_dir() and s not in parts:
            parts.insert(0, s)
    os.environ["PATH"] = os.pathsep.join(parts)


def _find_bundled_tui(hermes_cli_dir: Path | None = None) -> Path | None:
    """Find a pre-built TUI entry.js bundled in the wheel."""
    if hermes_cli_dir is None:
        hermes_cli_dir = Path(__file__).parent
    bundled = hermes_cli_dir / "tui_dist" / "entry.js"
    return bundled if bundled.is_file() else None


def _project_root() -> Path:
    """Current checkout root, resolved lazily to avoid the main facade import cycle."""
    from hermes_cli.main import PROJECT_ROOT

    return PROJECT_ROOT


def _is_termux_startup_environment(env: dict[str, str] | None = None) -> bool:
    """Delegate to the import-safe startup probe owned by the main facade."""
    from hermes_cli.main import _is_termux_startup_environment as probe

    return probe(env)


def _run_opentui_build_command(*args, **kwargs):
    """Use the shared npm idle-timeout runner without coupling launcher import order."""
    from hermes_cli.main_web_build import _run_with_idle_timeout

    return _run_with_idle_timeout(*args, **kwargs)


def _update_opentui_package() -> bool:
    """Refresh the standalone OpenTUI package during ``hermes update``.

    Dependency-graph changes run npm ci + build in a sibling staging tree and
    promote node_modules + dist only after both succeed. Source/config-only
    changes use the cheaper transactional dist build. Either failure leaves the
    previously launchable runtime intact. This is deliberately best-effort so
    unsupported hosts keep Ink or their prior OpenTUI runtime.
    """
    if sys.platform.startswith("win") or _is_termux_startup_environment():
        return True

    seed_dir = _project_root() / "ui-opentui"
    if not (seed_dir / "package.json").is_file():
        return True
    location = _opentui_runtime_location(report_error=False)
    if location is None:
        print(
            "  ⚠ OpenTUI update skipped: the packaged runtime seed is incomplete; "
            "reinstall Hermes to restore its build inputs."
        )
        return False
    app_dir = location.runtime_dir

    node = _node26_bin_or_none()
    if node is None:
        print(
            "  ⚠ OpenTUI update skipped: Node.js >= 26.3.0 is unavailable; "
            "the previous bundle/Ink fallback is unchanged."
        )
        return False
    identity = _opentui_node_identity(node, report_error=False)
    if identity is None:
        print(
            "  ⚠ OpenTUI update skipped: the selected Node 26 runtime identity "
            "could not be queried; the previous runtime is unchanged."
        )
        return False

    packaged_current = _opentui_runtime.packaged_runtime_current(location)
    initial = _opentui_runtime.inspect_runtime(app_dir, identity)
    state_dir = _opentui_runtime_state_dir()
    if (
        packaged_current
        and not initial.refresh_required
        and not _opentui_runtime.promotion_debris_present(app_dir)
    ):
        _opentui_runtime.clear_refresh_failure(
            state_dir, _opentui_refresh_failure_key(location, identity)
        )
        return True

    try:
        with _opentui_runtime.refresh_lock(app_dir):
            locked_identity = _opentui_node_identity(node, report_error=False)
            if locked_identity is None:
                print(
                    "  ⚠ OpenTUI update skipped: the selected Node 26 runtime "
                    "identity changed or became unavailable."
                )
                return False
            identity = locked_identity
            _opentui_runtime.recover_interrupted_promotion(app_dir)
            _opentui_runtime.prune_abandoned_staging(app_dir)
            inspection = _opentui_runtime.inspect_runtime(app_dir, identity)
            packaged_current = _opentui_runtime.packaged_runtime_current(location)
            _prune_validated_opentui_backups(
                location,
                inspection,
                packaged_current=packaged_current,
            )
            failure_key = _opentui_refresh_failure_key(location, identity)
            if packaged_current and not inspection.refresh_required:
                _opentui_runtime.clear_refresh_failure(state_dir, failure_key)
                return True
            npm_command = _opentui_runtime.npm_command(node)
            if npm_command is None:
                if failure_key is not None:
                    _opentui_runtime.record_refresh_failure(state_dir, failure_key)
                print(
                    "  ⚠ OpenTUI update skipped: npm paired with the selected "
                    "Node 26 installation was not found; the previous runtime "
                    "is unchanged."
                )
                return False

            print("→ Updating the OpenTUI engine transactionally…")
            env = _opentui_runtime.build_environment(node)
            if location.is_packaged:
                success, result, promotion = (
                    _opentui_runtime.refresh_packaged_runtime(
                        location,
                        identity=identity,
                        npm=npm_command,
                        env=env,
                        runner=_run_opentui_build_command,
                    )
                )
                success_message = (
                    "  ✓ OpenTUI writable runtime hydrated + production bundle updated"
                )
            elif not inspection.dependency_refresh_required:
                success, result, promotion = _opentui_runtime.build_bundle(
                    app_dir,
                    npm=npm_command,
                    env=env,
                    runner=_run_opentui_build_command,
                )
                success_message = "  ✓ OpenTUI production bundle updated"
            else:
                success, result, promotion = _opentui_runtime.refresh_runtime(
                    app_dir,
                    identity=identity,
                    npm=npm_command,
                    env=env,
                    runner=_run_opentui_build_command,
                )
                success_message = (
                    "  ✓ OpenTUI dependencies + production bundle updated"
                )
            if not success:
                if failure_key is not None:
                    _opentui_runtime.record_refresh_failure(state_dir, failure_key)
                preview = _opentui_runtime.failure_preview(result)
                print("  ⚠ OpenTUI refresh failed; the previous runtime is unchanged.")
                if preview:
                    print(preview)
                return False

            if promotion is None:
                raise RuntimeError(
                    "successful OpenTUI refresh has no promotion transaction"
                )
            try:
                (
                    refresh_current,
                    completed,
                    completed_packaged_current,
                ) = _completed_opentui_refresh(location, identity)
            except BaseException:
                promotion.rollback()
                raise
            if not refresh_current:
                promotion.rollback()
                if failure_key is not None:
                    _opentui_runtime.record_refresh_failure(state_dir, failure_key)
                print(
                    "  ⚠ OpenTUI refresh produced a non-current runtime; "
                    "refusing to launch it."
                )
                return False

            promotion.commit()
            _opentui_runtime.clear_refresh_failure(state_dir, failure_key)
            _prune_validated_opentui_backups(
                location,
                completed,
                packaged_current=completed_packaged_current,
            )
            print(success_message)
            return True
    except Exception as exc:
        print(f"  ⚠ OpenTUI update failed; the previous runtime is unchanged: {exc}")
        return False



def _config_tui_engine_early() -> str | None:
    """Read ``display.tui_engine`` through the profile-aware config owner.

    Returns the configured engine string, or ``None`` when unset/unreadable so the
    caller can apply the availability-gated default. Mirrors
    :func:`_config_default_interface_early`.
    """
    try:
        from hermes_cli.config import load_config_readonly

        disp = load_config_readonly().get("display", {})
        if isinstance(disp, dict):
            eng = disp.get("tui_engine")
            if isinstance(eng, str) and eng.strip():
                return eng.strip().lower()
    except Exception:
        pass
    return None


def _resolve_tui_engine(
    *, opentui_runtime_state_dir: Path | None = None
) -> str:
    """Which TUI engine to launch: "ink" (default) or "opentui".

    Precedence: ``HERMES_TUI_ENGINE`` env > ``display.tui_engine`` config >
    (OpenTUI when this host can run it — Node >= 26.3 + the built package — else Ink).
    The OpenTUI engine runs on Node 26.3+ via the experimental ``node:ffi`` renderer,
    which is not validated on Windows or Termux — a request for "opentui" there falls
    back to "ink" with a notice so a stale flag never strands the user on an engine
    that can't start.
    """
    env = (os.environ.get("HERMES_TUI_ENGINE") or "").strip().lower()
    # Explicit choice (env > config) wins; otherwise default to OpenTUI when this
    # host is genuinely set up for it (Node >= 26.3 + the built bundle), else Ink.
    engine = env or _config_tui_engine_early() or (
        "opentui"
        if _opentui_available(runtime_state_dir=opentui_runtime_state_dir)
        else "ink"
    )
    if engine != "opentui":
        return "ink"

    # opentui requested — gate on platform support.
    unsupported = sys.platform.startswith("win") or _is_termux_startup_environment()
    if unsupported:
        if not os.environ.get("HERMES_QUIET"):
            where = "Windows" if sys.platform.startswith("win") else "Termux"
            print(
                f"HERMES_TUI_ENGINE=opentui is not supported on {where} "
                f"(needs Node 26.3+ with experimental FFI) — falling back to the Ink engine.",
                file=sys.stderr,
            )
        return "ink"
    return "opentui"


NODE26_MIN_VERSION = (26, 3, 0)


def _node_version_tuple(node_bin: str) -> tuple[int, int, int] | None:
    """Return (major, minor, patch) for a node binary, or ``None`` if unreadable."""
    try:
        out = subprocess.run([node_bin, "--version"], capture_output=True,
                             text=True, encoding="utf-8", errors="replace", timeout=5)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    raw = (out.stdout or "").strip().lstrip("v").split("-", 1)[0]
    parts = raw.split(".")
    try:
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except (IndexError, ValueError):
        return None


def _fnm_node26_candidates() -> list[str]:
    """Node binaries from fnm's installed versions, newest first.

    fnm keeps each version at ``<FNM_DIR>/node-versions/v<X.Y.Z>/installation/
    bin/node`` (default ``FNM_DIR``: ``$XDG_DATA_HOME/fnm`` or ``~/.local/share/
    fnm``; macOS Homebrew also uses ``~/Library/Application Support/fnm``). When
    the *active* node is older than 26.3 — e.g. the user's fnm default is on
    v25 — the right 26.x is still installed and usable; surface it so OpenTUI
    works without the user re-aliasing their global default. Version-sorted so
    the newest qualifying node wins.
    """
    roots: list[Path] = []
    fnm_dir = os.environ.get("FNM_DIR")
    if fnm_dir:
        roots.append(Path(fnm_dir))
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        roots.append(Path(xdg) / "fnm")
    roots.append(Path.home() / ".local" / "share" / "fnm")
    roots.append(Path.home() / "Library" / "Application Support" / "fnm")

    seen: set[Path] = set()
    found: list[tuple[tuple[int, int, int], str]] = []
    for root in roots:
        versions_dir = root / "node-versions"
        if versions_dir in seen or not versions_dir.is_dir():
            continue
        seen.add(versions_dir)
        try:
            entries = list(versions_dir.iterdir())
        except OSError:
            continue
        for entry in entries:
            node_bin = entry / "installation" / "bin" / "node"
            if not (node_bin.is_file() and os.access(node_bin, os.X_OK)):
                continue
            # Trust the directory name for sorting; the real probe happens in
            # the caller (a renamed/symlinked dir still gets version-checked).
            name = entry.name.lstrip("v").split("-", 1)[0]
            parts = name.split(".")
            try:
                ver = (int(parts[0]), int(parts[1]), int(parts[2]))
            except (IndexError, ValueError):
                ver = (0, 0, 0)
            found.append((ver, str(node_bin)))
    found.sort(key=lambda pair: pair[0], reverse=True)
    return [path for _, path in found]


def _node26_bin_or_none() -> str | None:
    """Resolve a Node >= 26.3.0 binary (no exit — a probe), or ``None``.

    Order: ``HERMES_NODE`` override > ``node`` on PATH > newest fnm-installed
    version. Each is gated on the real ``--version`` being >= 26.3.0. OpenTUI's
    native renderer loads via the experimental ``node:ffi`` API that only exists
    on Node 26.3+, so an older Node is treated as "not available" — but an
    installed-yet-inactive 26.x (common when fnm's default is on an older line)
    is discovered and used so the engine still launches.
    """
    candidates: list[str] = []
    env_node = os.environ.get("HERMES_NODE")
    if env_node and os.path.isfile(env_node) and os.access(env_node, os.X_OK):
        candidates.append(env_node)
    path = shutil.which("node")
    if path:
        candidates.append(path)
    candidates.extend(_fnm_node26_candidates())
    for cand in candidates:
        ver = _node_version_tuple(cand)
        if ver is not None and ver >= NODE26_MIN_VERSION:
            return cand
    return None


def _node26_bin() -> str:
    """Resolve Node >= 26.3.0 for the OpenTUI engine, or exit with a clear message.

    Use :func:`_node26_bin_or_none` for a non-fatal availability probe.
    """
    node = _node26_bin_or_none()
    if node is not None:
        return node
    print(
        "Node.js >= 26.3.0 not found — the OpenTUI TUI engine needs it for the "
        "experimental node:ffi renderer.\n"
        "Install Node 26.3+ (e.g. via fnm/nvm) or set HERMES_NODE=/path/to/node, "
        "or unset HERMES_TUI_ENGINE to use the default Ink engine.",
        file=sys.stderr,
    )
    sys.exit(1)


def _opentui_runtime_state_dir() -> Path:
    """Writable internal cache for refresh backoff state (not user config)."""
    return get_hermes_home() / "cache" / "opentui-runtime"


def _opentui_runtime_location(
    *, report_error: bool, state_dir: Path | None = None
) -> _opentui_runtime.RuntimeLocation | None:
    location = _opentui_runtime.select_runtime_location(
        _project_root(), state_dir or _opentui_runtime_state_dir()
    )
    if location is None and report_error:
        seed = _project_root() / "ui-opentui"
        print(
            "The installed OpenTUI runtime seed is incomplete at "
            f"{seed}. Reinstall Hermes so package.json, package-lock.json, "
            "tsconfig.json, scripts/build.mjs, src/, and dist/main.js are present.",
            file=sys.stderr,
        )
    return location


def _opentui_node_identity(
    node: str, *, report_error: bool
) -> _opentui_runtime.NodeIdentity | None:
    identity = _opentui_runtime.probe_node_identity(node)
    if identity is None and report_error:
        print(
            "Could not query process.platform/process.arch from the selected "
            "Node 26 executable; refusing to guess the OpenTUI native package.",
            file=sys.stderr,
        )
    return identity


def _prune_validated_opentui_backups(
    location: _opentui_runtime.RuntimeLocation,
    inspection: _opentui_runtime.RuntimeInspection,
    *,
    packaged_current: bool,
) -> bool:
    """Discard crash predecessors only after validating their replacement."""
    if location.is_packaged:
        full_root_current = packaged_current and inspection.dependencies_current
        runtime_dirs_current = False
    else:
        full_root_current = False
        runtime_dirs_current = (
            inspection.dependencies_current
            and not _opentui_runtime.bundle_needs_rebuild(
                location.runtime_dir, env={}
            )
        )
    return _opentui_runtime.prune_obsolete_promotion_backups(
        location.runtime_dir,
        full_root_current=full_root_current,
        runtime_dirs_current=runtime_dirs_current,
    )


def _opentui_refresh_failure_key(
    location: _opentui_runtime.RuntimeLocation,
    identity: _opentui_runtime.NodeIdentity,
) -> str | None:
    """Key retry state to one installation, generation, Node, and host ABI."""
    digest = (
        location.packaged_seed.fingerprint
        if location.packaged_seed is not None
        else _opentui_runtime.refresh_digest(location.runtime_dir)
    )
    if digest is None:
        return None
    return _opentui_runtime.refresh_failure_key(
        location.runtime_dir, digest, identity
    )


def _completed_opentui_refresh(
    location: _opentui_runtime.RuntimeLocation,
    identity: _opentui_runtime.NodeIdentity,
) -> tuple[bool, _opentui_runtime.RuntimeInspection, bool]:
    """Validate the exact generation a successful refresh would launch."""
    inspection = _opentui_runtime.inspect_runtime(
        location.runtime_dir, identity, env={}
    )
    packaged_current = _opentui_runtime.packaged_runtime_current(location)
    current = (
        packaged_current
        and not inspection.refresh_required
        and _opentui_runtime.bundle_payload_present(location.runtime_dir)
    )
    return current, inspection, packaged_current


def _opentui_available(
    *, runtime_state_dir: Path | None = None
) -> bool:
    """Whether the OpenTUI engine can actually launch on this host.

    True only when the platform is supported (not Windows/Termux), a Node >= 26.3
    binary resolves (the node:ffi floor), AND the v2 package is BUILT
    (``dist/main.js``) with its ``node_modules`` installed. This gates the DEFAULT
    engine: a host genuinely set up for OpenTUI defaults to it; everyone else stays
    on Ink. An explicit ``HERMES_TUI_ENGINE`` env or ``display.tui_engine`` config
    choice bypasses this probe (and triggers an on-demand build).
    """
    if sys.platform.startswith("win") or _is_termux_startup_environment():
        return False
    location = _opentui_runtime_location(
        report_error=False, state_dir=runtime_state_dir
    )
    if location is None:
        return False
    node = _node26_bin_or_none()
    if node is None:
        return False
    identity = _opentui_node_identity(node, report_error=False)
    if identity is None:
        return False
    if _opentui_runtime.packaged_prebuilt_runtime_current(location, identity):
        pkg = location.seed_dir
    elif _opentui_runtime.packaged_runtime_current(location):
        pkg = location.runtime_dir
    else:
        return False
    return _opentui_runtime.bundle_payload_present(
        pkg
    ) and _opentui_runtime.runtime_payload_present(pkg, identity)


def _make_opentui_argv(
    tui_dev: bool, *, runtime_state_dir: Path | None = None
) -> tuple[list[str], Path]:
    """Argv for the native OpenTUI engine under Node 26 (no Bun).

    Builds the Solid + Effect-at-boundary engine (``ui-opentui``) with esbuild
    when its production inputs are stale (or always in ``--dev``). Dependency
    graph changes use a staged ``npm ci``; source-only changes stage just the
    bundle. It then launches on Node with the experimental FFI flag:

        node --experimental-ffi --no-warnings dist/main.js

    ``--no-warnings`` keeps the ExperimentalWarning off the TUI's stderr. Returns the
    argv and the package cwd.

    The spawned ``tui_gateway`` resolves its Python from ``HERMES_PYTHON_SRC_ROOT``
    (the caller sets it to ``_project_root()``); the built bundle's own fallback also
    walks up to the checkout root, so the gateway resolves correctly either way.
    """
    state_dir = runtime_state_dir or _opentui_runtime_state_dir()
    location = _opentui_runtime_location(report_error=True, state_dir=state_dir)
    if location is None:
        sys.exit(1)
    app_dir = location.runtime_dir
    entry_src = location.seed_dir / "src" / "entry" / "main.tsx"
    if not entry_src.is_file():
        print(
            f"OpenTUI v2 engine entry not found at {entry_src}.\n"
            f"Unset HERMES_TUI_ENGINE to use the default Ink engine.",
            file=sys.stderr,
        )
        sys.exit(1)

    node = _node26_bin()
    identity = _opentui_node_identity(node, report_error=True)
    if identity is None:
        sys.exit(1)

    # Docker and other immutable installs may bake a host-native, production-
    # only dependency graph beside the bundle. Validate it without writing and
    # launch it in place: copying hundreds of MB into HERMES_HOME on every
    # ephemeral container start would add latency and duplicate image data.
    # Wheels intentionally ship no node_modules, so they continue into the
    # transactional writable-cache hydration path below.
    if (
        not tui_dev
        and not _opentui_runtime.force_build_requested()
        and _opentui_runtime.packaged_prebuilt_runtime_current(location, identity)
    ):
        app_dir = location.seed_dir
        return _opentui_runtime.launch_argv(node, app_dir), app_dir

    built = app_dir / "dist" / "main.js"
    packaged_current = _opentui_runtime.packaged_runtime_current(location)
    initial = _opentui_runtime.inspect_runtime(
        app_dir, identity, rebuild_requested=tui_dev
    )
    if (
        not packaged_current
        or initial.refresh_required
        or _opentui_runtime.promotion_debris_present(app_dir)
    ):
        initial_usable = (
            packaged_current
            and _opentui_runtime.bundle_payload_present(app_dir)
            and initial.payload_present
        )
        try:
            with _opentui_runtime.refresh_lock(app_dir):
                # Another launcher/update may have completed while we waited.
                # Probe and inspect again under the same lock that protects
                # promotion; this is the decision that authorizes mutation.
                locked_identity = _opentui_node_identity(node, report_error=True)
                if locked_identity is None:
                    if tui_dev or not initial_usable:
                        sys.exit(1)
                    print("Using the previous OpenTUI runtime.", file=sys.stderr)
                else:
                    identity = locked_identity
                    _opentui_runtime.recover_interrupted_promotion(app_dir)
                    _opentui_runtime.prune_abandoned_staging(app_dir)
                    inspection = _opentui_runtime.inspect_runtime(
                        app_dir, identity, rebuild_requested=tui_dev
                    )
                    packaged_current = _opentui_runtime.packaged_runtime_current(
                        location
                    )
                    _prune_validated_opentui_backups(
                        location,
                        inspection,
                        packaged_current=packaged_current,
                    )
                    usable_previous = (
                        packaged_current
                        and _opentui_runtime.bundle_payload_present(app_dir)
                        and inspection.payload_present
                    )
                    failure_key = _opentui_refresh_failure_key(location, identity)
                    if packaged_current and not inspection.refresh_required:
                        _opentui_runtime.clear_refresh_failure(
                            state_dir, failure_key
                        )
                    else:
                        bypass_backoff = (
                            tui_dev or _opentui_runtime.force_build_requested()
                        )
                        remaining = (
                            _opentui_runtime.refresh_backoff_remaining(
                                state_dir, failure_key
                            )
                            if failure_key is not None and not bypass_backoff
                            else 0.0
                        )
                        if remaining > 0:
                            print(
                                "OpenTUI refresh is temporarily backed off after a "
                                f"recent failure for these inputs (retry in "
                                f"{int(remaining) + 1}s).",
                                file=sys.stderr,
                            )
                            if not usable_previous:
                                sys.exit(1)
                            print(
                                "Using the previous OpenTUI runtime.", file=sys.stderr
                            )
                        else:
                            npm_command = _opentui_runtime.npm_command(node)
                            if npm_command is None:
                                print(
                                    "npm from the selected Node 26 installation was "
                                    "not found — needed to build the OpenTUI engine.",
                                    file=sys.stderr,
                                )
                                if failure_key is not None:
                                    _opentui_runtime.record_refresh_failure(
                                        state_dir, failure_key
                                    )
                                if tui_dev or not usable_previous:
                                    sys.exit(1)
                                print(
                                    "Using the previous OpenTUI runtime.",
                                    file=sys.stderr,
                                )
                            else:
                                if not os.environ.get("HERMES_QUIET"):
                                    if location.is_packaged:
                                        action = "Hydrating + building"
                                    else:
                                        action = (
                                            "Installing + building"
                                            if inspection.dependency_refresh_required
                                            else "Building"
                                        )
                                    print(
                                        f"{action} the OpenTUI engine…",
                                        file=sys.stderr,
                                    )
                                build_env = _opentui_runtime.build_environment(node)
                                if location.is_packaged:
                                    success, result, promotion = (
                                        _opentui_runtime.refresh_packaged_runtime(
                                            location,
                                            identity=identity,
                                            npm=npm_command,
                                            env=build_env,
                                            runner=_run_opentui_build_command,
                                        )
                                    )
                                elif not inspection.dependency_refresh_required:
                                    success, result, promotion = (
                                        _opentui_runtime.build_bundle(
                                            app_dir,
                                            npm=npm_command,
                                            env=build_env,
                                            runner=_run_opentui_build_command,
                                        )
                                    )
                                else:
                                    success, result, promotion = (
                                        _opentui_runtime.refresh_runtime(
                                            app_dir,
                                            identity=identity,
                                            npm=npm_command,
                                            env=build_env,
                                            runner=_run_opentui_build_command,
                                        )
                                    )
                                if success:
                                    if promotion is None:
                                        raise RuntimeError(
                                            "successful OpenTUI refresh has no "
                                            "promotion transaction"
                                        )
                                    try:
                                        (
                                            refresh_current,
                                            completed,
                                            completed_packaged_current,
                                        ) = _completed_opentui_refresh(
                                            location, identity
                                        )
                                    except BaseException:
                                        promotion.rollback()
                                        raise
                                    if not refresh_current:
                                        promotion.rollback()
                                        success = False
                                        result = subprocess.CompletedProcess(
                                            getattr(
                                                result,
                                                "args",
                                                ["opentui-refresh"],
                                            ),
                                            1,
                                            stdout=getattr(result, "stdout", ""),
                                            stderr=(
                                                "OpenTUI refresh completed but the "
                                                "promoted runtime is not current"
                                            ),
                                        )
                                if success:
                                    promotion.commit()
                                    _opentui_runtime.clear_refresh_failure(
                                        state_dir, failure_key
                                    )
                                    _prune_validated_opentui_backups(
                                        location,
                                        completed,
                                        packaged_current=completed_packaged_current,
                                    )
                                else:
                                    if failure_key is not None:
                                        _opentui_runtime.record_refresh_failure(
                                            state_dir, failure_key
                                        )
                                    print(
                                        "OpenTUI engine refresh failed.",
                                        file=sys.stderr,
                                    )
                                    preview = _opentui_runtime.failure_preview(result)
                                    if preview:
                                        print(preview, file=sys.stderr)
                                    if tui_dev or not usable_previous:
                                        sys.exit(1)
                                    print(
                                        "The previous OpenTUI runtime is still intact "
                                        "and will be used. Run `hermes update` to retry "
                                        "the transactional rebuild.",
                                        file=sys.stderr,
                                    )
        except OSError as exc:
            print(f"OpenTUI refresh lock failed: {exc}", file=sys.stderr)
            print(
                "Refusing to launch while runtime coherence cannot be established.",
                file=sys.stderr,
            )
            sys.exit(1)

    # --expose-gc (parity with Ink, main.py ~1909): makes `global.gc()` a real
    # callable so the OpenTUI engine's GC hooks (W2 proactive idle GC; /heapdump)
    # work instead of being silent no-ops. MUST be an argv flag — Node rejects
    # --expose-gc in NODE_OPTIONS (see the heap-cap injection below).
    return _opentui_runtime.launch_argv(node, app_dir), app_dir


def _restore_tui_workspace(tui_dir: Path) -> bool:
    """Best-effort ``git restore`` of a missing ``ui-tui/`` (Windows AV/NTFS filters can delete
    tracked files after ``hermes update``); True when the directory exists afterwards.

    On Windows an antivirus / NTFS filter driver can leave tracked ``ui-tui/`` files deleted in the working
    tree after ``hermes update`` (HEAD stays intact; the files just vanish — see issue #49145). Those files
    are tracked, so ``git restore`` puts them back deterministically. Best-effort: returns False (rather
    than raising) when git is unavailable, this isn't a checkout, or the restore leaves the directory still
    missing — the caller then prints the manual-recovery message.
    """
    git = shutil.which("git")
    if not git or not (tui_dir.parent / ".git").exists():
        return False
    try:
        subprocess.run(
            [git, "restore", "--", tui_dir.name], cwd=str(tui_dir.parent), capture_output=True,
            text=True, encoding="utf-8", errors="replace", check=False)
    except OSError:
        return False
    return tui_dir.is_dir()


def _ensure_tui_workspace(tui_dir: Path) -> None:
    """Ensure ``ui-tui/`` exists before it is used as a subprocess cwd (else ``NotADirectoryError``
    / ``WinError 267`` with no usable message): git-restore first, then abort with recovery steps.

    Without this, a missing workspace falls through to ``subprocess.run(..., cwd=<missing ui-tui>)``, which
    crashes with ``NotADirectoryError`` (``WinError 267`` on Windows) instead of a usable message (#49145).
    We first try to self-heal via ``git restore``; only if that can't recover the directory do we abort with
    concrete manual-recovery steps.
    """
    if tui_dir.is_dir():
        return

    if _restore_tui_workspace(tui_dir):
        if not os.environ.get("HERMES_QUIET"):
            print(f"Restored missing TUI workspace: {tui_dir}")
        return

    print(
        "Error: the TUI workspace is missing from this Hermes checkout.\n"
        f"Expected directory: {tui_dir}\n"
        "This usually means `hermes update` left tracked ui-tui files deleted.\n"
        "Recovery:\n"
        "  1. From the Hermes checkout, run `git restore -- ui-tui`\n"
        "  2. Run `npm install --silent --no-fund --no-audit --progress=false`\n"
        "  3. Retry `hermes --tui`\n"
        "If the checkout is still inconsistent, run `hermes update --force`.",
        file=sys.stderr)
    sys.exit(1)


def _npm_lifecycle_env(env: dict[str, str] | None = None) -> dict[str, str]:
    """Build a clean environment for the pinned UI toolchain lifecycle."""
    run_env = {**os.environ, **(env or {}), "CI": "1"}
    # esbuild treats this as an executable override. If a shell points it at a
    # different release, the pinned package's postinstall rejects that binary.
    run_env.pop("ESBUILD_BINARY_PATH", None)
    return run_env


def _tui_node_bin(bin: str) -> str:
    """Resolve ``node``/``npm`` for the TUI launch, or exit with a hint. ``HERMES_NODE`` wins for node;
    ``find_node_executable()`` sees the managed ``$HERMES_HOME/node`` tree a bare which() misses."""
    if bin == "node":
        env_node = os.environ.get("HERMES_NODE")
        if env_node and os.path.isfile(env_node) and os.access(env_node, os.X_OK):
            return env_node
    from hermes_constants import find_node_executable
    path = find_node_executable(bin)
    if not path and bin == "node":
        with contextlib.suppress(Exception):
            from hermes_cli.dep_ensure import ensure_dependency
            if ensure_dependency("node"):
                path = find_node_executable("node")
    if not path:
        print(f"{bin} not found — install Node.js to use the TUI.")
        sys.exit(1)
    return path


def _exit_on_npm_failure(result: subprocess.CompletedProcess, message: str, *, sep: str) -> None:
    """Print *message* plus the last 30 lines of npm output and exit 1 on a non-zero rc."""
    if result.returncode == 0:
        return
    combined = f"{result.stdout or ''}{sep}{result.stderr or ''}".strip()
    preview = "\n".join(combined.splitlines()[-30:])
    print(message)
    if preview:
        print(preview)
    sys.exit(1)


def _run_tui_npm_build(npm: str, cwd: Path, failure_message: str) -> None:
    """``npm run build`` in *cwd*; exit with *failure_message* + output tail on failure."""
    result = subprocess.run(
        [npm, "run", "build"], cwd=str(cwd), capture_output=True, text=True, encoding="utf-8",
        errors="replace", env=_npm_lifecycle_env())
    _exit_on_npm_failure(result, failure_message, sep="")


def _install_tui_dependencies(tui_dir: Path, *, termux_startup: bool) -> None:
    """``npm install`` for the TUI workspace, with one EBADENGINE repair retry. Exits on failure.

    ``--workspace ui-tui`` avoids resolving apps/desktop (Electron + node-pty) and
    is omitted when ui-tui/ has its own lockfile. ``--include=dev``: the build
    toolchain is in devDependencies and an inherited ``NODE_ENV=production`` /
    ``omit=dev`` would silently skip it.
    """
    npm = _tui_node_bin("npm")
    if not os.environ.get("HERMES_QUIET"):
        print("Installing TUI dependencies…")
    npm_cwd = _workspace_root(tui_dir)
    # --workspace ui-tui avoids resolving apps/desktop (Electron + node-pty). See #38772. When ui-tui/ has
    # its own package-lock.json (e.g. curl install), _workspace_root() returns tui_dir itself. Passing
    # --workspace in that case fails because npm cannot find a workspace named "ui-tui" inside ui-tui/. See
    # #42973.
    npm_workspace_args: tuple[str, ...] = () if npm_cwd == tui_dir else ("--workspace", "ui-tui")
    if termux_startup:
        npm_cwd, npm_workspace_args = _termux_workspace_install_context(tui_dir, include_child_workspaces=True)
    npm_install_cmd = [
        npm, "install", *npm_workspace_args,
        "--include=dev", "--silent", "--no-fund", "--no-audit", "--progress=false",
    ]

    def _run_tui_install() -> subprocess.CompletedProcess:
        from hermes_constants import with_hermes_node_path
        # Managed tree first on PATH: if the EBADENGINE repair provisioned a
        # managed Node, npm's shebang/lifecycle scripts must resolve that node.
        return subprocess.run(
            npm_install_cmd, cwd=str(npm_cwd), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
            env=_npm_lifecycle_env(with_hermes_node_path()))

    result = _run_tui_install()
    if result.returncode != 0:
        # An npm outside the root `engines.npm` range fails before doing any work;
        # repair once (upgrade a managed npm in place, or provision a managed
        # runtime) and retry rather than dumping EBADENGINE at the user.
        from hermes_cli.npm_engine import maybe_repair_npm_engine
        repaired_npm = maybe_repair_npm_engine(npm, f"{result.stdout or ''}\n{result.stderr or ''}")
        if repaired_npm:
            npm_install_cmd[0] = repaired_npm
            result = _run_tui_install()
    _exit_on_npm_failure(result, "npm install failed.", sep="\n")


def _make_tui_argv(
    tui_dir: Path,
    tui_dev: bool,
    *,
    opentui_runtime_state_dir: Path | None = None,
) -> tuple[list[str], Path]:
    """Build argv for the selected TUI engine while keeping each engine's bootstrap isolated."""
    engine = _resolve_tui_engine(opentui_runtime_state_dir=opentui_runtime_state_dir)
    if engine == "opentui":
        return _make_opentui_argv(tui_dev, runtime_state_dir=opentui_runtime_state_dir)

    _ensure_tui_node()

    # Footgun: --dev against a prebuilt bundle that has no source/node_modules.
    ext_dir = os.environ.get("HERMES_TUI_DIR")
    if tui_dev and ext_dir:
        print(
            f"Error: --dev is incompatible with HERMES_TUI_DIR={ext_dir}\n"
            f"The prebuilt TUI has no source code to hot-reload.\n"
            f"Unset HERMES_TUI_DIR (e.g. `unset HERMES_TUI_DIR`) to use --dev from a checkout.",
            file=sys.stderr)
        sys.exit(1)

    # 1. Prebuilt bundle (nix / packaged release / Docker image): just run it.
    # Must run BEFORE _ensure_tui_workspace(): a prebuilt install ships
    # hermes_cli/tui_dist/entry.js but never ui-tui/ (git checkouts only).
    # 1. A prebuilt install (Docker image, Nix build, or prior `npm run build`) ships
    #   hermes_cli/tui_dist/entry.js but never ships ui-tui/ at all (that directory only exists in a git
    #   checkout) — so requiring the workspace to exist first made every prebuilt dashboard Chat tab
    #   connection hard-exit before it ever got a chance to try the bundled entry.js it already has. See
    #   #56665.
    if not tui_dev:
        if ext_dir:
            p = Path(ext_dir)
            if (p / "dist" / "entry.js").is_file():
                return [_tui_node_bin("node"), "--expose-gc", str(p / "dist" / "entry.js")], p

        bundled = _find_bundled_tui()
        if bundled is not None:
            return [_tui_node_bin("node"), "--expose-gc", str(bundled)], bundled.parent

    # About to npm install/build from source, so the workspace must exist.
    if not ext_dir:
        _ensure_tui_workspace(tui_dir)

    # 2. Normal flow: npm install if needed, esbuild, then node dist/entry.js.
    #    --dev: npm install if needed, then tsx src/entry.tsx.
    termux_startup = _is_termux_startup_environment()
    termux_need_rebuild = termux_startup and not tui_dev and _tui_need_rebuild(tui_dir)
    skip_install_for_fresh_termux_bundle = termux_startup and not tui_dev and not termux_need_rebuild
    did_install = False
    if not skip_install_for_fresh_termux_bundle and _tui_need_npm_install(tui_dir):
        _install_tui_dependencies(tui_dir, termux_startup=termux_startup)
        did_install = True

    if tui_dev:
        # --dev runs src/entry.tsx directly, but @hermes/ink resolves through
        # packages/hermes-ink/dist/entry-exports.js; a stale dist after a pull
        # leaves newer hooks/components missing at runtime. Prebuild it here.
        npm = _tui_node_bin("npm")
        _run_tui_npm_build(npm, tui_dir / "packages" / "hermes-ink", "TUI dev prebuild failed.")
        tsx = tui_dir / "node_modules" / ".bin" / "tsx"
        if tsx.exists():
            return [str(tsx), "src/entry.tsx"], tui_dir
        return [npm, "start"], tui_dir

    # Desktop/dev launches always rebuild; Termux cold starts use the freshness
    # check because esbuild startup is expensive on old mobile CPUs.
    if not termux_startup or did_install or termux_need_rebuild:
        _run_tui_npm_build(_tui_node_bin("npm"), tui_dir, "TUI build failed.")

    return [_tui_node_bin("node"), "--expose-gc", str(tui_dir / "dist" / "entry.js")], tui_dir


def _split_comma_items(items, *, split_non_str: bool = True) -> list[str]:
    """Flatten str / list (comma-separated) input into stripped non-empty parts."""
    raw_items = [items] if isinstance(items, str) else items
    if not isinstance(raw_items, (list, tuple)):
        raw_items = [raw_items]
    normalized: list[str] = []
    for item in raw_items:
        if split_non_str or isinstance(item, str):
            normalized.extend(part.strip() for part in str(item).split(","))
        else:
            normalized.append(str(item).strip())
    return [item for item in normalized if item]


def _normalize_tui_toolsets(toolsets: object) -> list[str]:
    """Normalize argparse/Fire-style toolset input for the TUI subprocess."""
    try:
        from hermes_cli.oneshot import _normalize_toolsets
        return _normalize_toolsets(toolsets) or []
    except (AttributeError, ImportError):
        return _split_comma_items(toolsets, split_non_str=False) if toolsets else []


def _read_cgroup_memory_limit() -> Optional[int]:
    """Container memory limit in bytes, or None if unconstrained (v2 ``memory.max``, then v1).

    V8 is NOT cgroup-aware: a flat 8GB heap grows past a smaller container limit
    and the OOM-killer SIGKILLs Node with no breadcrumb (bare ``stdin EOF``).
    """
    candidates = (
        "/sys/fs/cgroup/memory.max",  # cgroup v2
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",  # cgroup v1
    )
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = f.read().strip()
        except (OSError, ValueError):
            continue
        if raw == "max":
            return None
        if not raw:
            continue  # don't mistake an empty v2 file for "unlimited"
        try:
            limit = int(raw)
        except ValueError:
            continue
        if limit <= 0:
            continue
        if limit >= (1 << 50):  # >= ~1 PB is the v1 "unlimited" sentinel
            return None
        return limit
    return None


def _config_tui_heap_mb_early() -> int | None:
    """Read ``display.tui_heap_mb`` through the profile-aware config owner.

    Returns the configured V8 heap cap in MB, or ``None`` when unset/unreadable.
    Mirrors :func:`_config_tui_engine_early`. A non-secret behavioral setting, so
    it lives in ``config.yaml`` (NOT a ``HERMES_*`` env / the NODE_OPTIONS bridge,
    which is denylisted) — the ``HERMES_TUI_HEAP_MB`` env is only the per-launch
    override on top of this.
    """
    try:
        from hermes_cli.config import load_config_readonly

        disp = load_config_readonly().get("display", {})
        if isinstance(disp, dict):
            val = disp.get("tui_heap_mb")
            if isinstance(val, bool):  # guard: YAML true/false is an int subclass
                return None
            if isinstance(val, int) and val > 0:
                return val
            if isinstance(val, str) and val.strip().isdigit():
                n = int(val.strip())
                if n > 0:
                    return n
    except Exception:
        pass
    return None


def _resolve_tui_heap_override(
    *, env: dict[str, str] | None = None
) -> int | None:
    """The user's explicit V8 heap cap (MB), or ``None`` for the default path.

    Precedence: ``HERMES_TUI_HEAP_MB`` env > ``display.tui_heap_mb`` config
    (matches the ``HERMES_TUI_ENGINE`` env-first pattern). Honored by BOTH engines
    via the shared ``NODE_OPTIONS`` injection. A positive integer wins; anything
    else (unset/garbage/non-positive) falls through to the cgroup-aware default.
    """
    current_env = os.environ if env is None else env
    env_val = current_env.get("HERMES_TUI_HEAP_MB", "").strip()
    if env_val.isdigit() and int(env_val) > 0:
        return int(env_val)
    return _config_tui_heap_mb_early()


def _resolve_tui_heap_mb(
    default_mb: int = 8192, *, env: dict[str, str] | None = None
) -> int:
    """Pick a V8 ``--max-old-space-size`` (MB) that fits the container.

    Returns ``default_mb`` (8192) when unconstrained or when the box is large
    enough that 8GB fits.  In a memory-limited container, returns ~75% of the
    cgroup limit so the heap + non-heap RSS stays under the cgroup ceiling,
    clamped to a sane floor (1536MB — below this V8 GC-thrashes and the TUI
    is barely usable).  Never exceeds ``default_mb``.

    An explicit ``HERMES_TUI_HEAP_MB`` env / ``display.tui_heap_mb`` config
    override REPLACES the 8192 default (D3): setting it low is the low-mem opt-in,
    setting it high raises the ceiling. The cgroup-fit clamp still applies on top
    so an override never exceeds what the container can hold — a low override is
    honored as-is, a too-high one is still trimmed to ~75% of the cgroup limit.
    """
    override = _resolve_tui_heap_override(env=env)
    if override is not None:
        default_mb = override
    limit = _read_cgroup_memory_limit()
    if not limit:
        return default_mb
    limit_mb = limit // (1024 * 1024)
    # Leave headroom for non-heap RSS (Node internals, buffers, the Python
    # gateway child shares the same cgroup): cap the heap at 75% of the limit.
    sized = int(limit_mb * 0.75)
    if sized >= default_mb:
        return default_mb
    # Floor so a tiny limit doesn't drive V8 into constant GC. If the container
    # is smaller than the floor, honor the limit-derived value anyway (better a
    # graceful V8 exit than a silent cgroup kill).
    return max(1536, sized) if limit_mb > 2048 else sized


def _apply_tui_heap_env(env: dict[str, str]) -> None:
    """Merge the cgroup/profile-aware V8 heap cap into a TUI child env."""
    tokens = env.get("NODE_OPTIONS", "").split()
    if not any(token.startswith("--max-old-space-size=") for token in tokens):
        tokens.append(f"--max-old-space-size={_resolve_tui_heap_mb(env=env)}")
    env["NODE_OPTIONS"] = " ".join(tokens)


def _apply_opentui_native_env(
    argv: list[str], cwd: Path | str | None, env: dict[str, str]
) -> None:
    """Make child native-package selection match the selected Node identity."""
    if not argv or cwd is None or "--experimental-ffi" not in argv:
        return
    identity = _opentui_node_identity(argv[0], report_error=False)
    if identity is None or identity.platform != "linux":
        return
    # Current OpenTUI releases accept OPENTUI_LIBC as an explicit native
    # package selector. Set it on musl so older loaders that predate their own
    # auto-detection choose the same payload the packaging guard validated.
    libc = _opentui_runtime.linux_libc_name(env=env)
    if libc == "musl" and not env.get("OPENTUI_LIBC"):
        env["OPENTUI_LIBC"] = "musl"

def _safe_tui_cwd(env: Optional[dict] = None) -> str:
    """Return a stable cwd value for the Node TUI child environment."""
    from hermes_cli.main import PROJECT_ROOT
    try:
        return os.getcwd()
    except FileNotFoundError:
        candidate = ((env or {}).get("PWD") or os.environ.get("PWD") or "").strip()
        if candidate and Path(candidate).is_dir():
            return candidate
        return str(PROJECT_ROOT)


def _apply_tui_python_env(env: dict) -> None:
    """Seed/repair Python-related env vars shared by CLI and dashboard TUI launches."""
    from hermes_cli.main import PROJECT_ROOT
    src_root = str(env.get("HERMES_PYTHON_SRC_ROOT") or "").strip()
    if not src_root or not Path(src_root).is_dir():
        env["HERMES_PYTHON_SRC_ROOT"] = str(PROJECT_ROOT)

    cwd = str(env.get("HERMES_CWD") or "").strip()
    if not cwd or not Path(cwd).is_dir():
        env["HERMES_CWD"] = _safe_tui_cwd(env)

    python = str(env.get("HERMES_PYTHON") or "").strip()
    if os.path.dirname(python):
        python_path = Path(python)
        if not python_path.is_absolute():
            python_path = Path(env["HERMES_CWD"]) / python_path
        python_is_executable = python_path.is_file() and os.access(python_path, os.X_OK)
    else:
        python_is_executable = bool(shutil.which(python, path=env.get("PATH")))
    if not python_is_executable:
        env["HERMES_PYTHON"] = sys.executable


def _setup_tui_worktree() -> dict:
    """Create the ``--worktree`` checkout for a TUI launch (prune + async pack maintenance); exits on failure."""
    wt_info = None
    try:
        from cli import _git_repo_root, _maintain_pack_health, _prune_stale_worktrees, _setup_worktree
        repo = _git_repo_root()
        if repo:
            _prune_stale_worktrees(repo)
            # Repack on pack sprawl so `worktree add` never crawls on a
            # multi-agent box; on a thread so it can't block launch.
            import threading as _threading

            _threading.Thread(
                target=_maintain_pack_health, args=(repo,), name="pack-maintenance", daemon=True).start()
        wt_info = _setup_worktree()
    except Exception as exc:
        print(f"✗ Failed to create TUI worktree: {exc}", file=sys.stderr)
    if not wt_info:
        sys.exit(1)
    return wt_info


def _launch_tui(
    resume_session_id: Optional[str] = None, tui_dev: bool = False, model: Optional[str] = None,
    provider: Optional[str] = None, toolsets: object = None, skills: object = None,
    verbose: Optional[bool] = None, quiet: bool = False, query: Optional[str] = None,
    image: Optional[str] = None, worktree: bool = False, checkpoints: bool = False,
    pass_session_id: bool = False, max_turns: Optional[int] = None, accept_hooks: bool = False):
    """Replace current process with the TUI."""
    from hermes_cli.main import PROJECT_ROOT
    tui_dir = PROJECT_ROOT / "ui-tui"

    # Bare --resume asks the client to open its picker; downstream summary logic only receives IDs.
    resume_picker = resume_session_id is True
    if resume_picker:
        resume_session_id = None

    import tempfile
    # TUI child is a hermes process: propagate the profile-home contract via
    # the single factory; keep secrets (the TUI/agent needs provider creds).
    from tools.environments.local import build_subprocess_env
    env = build_subprocess_env(scrub_secrets=False, inherit_profile_home=True)
    try:
        from hermes_cli.config import apply_terminal_config_to_env
        apply_terminal_config_to_env(env=env)
    except Exception:
        logger.debug("Failed to apply terminal config bridge for TUI launch", exc_info=True)
    active_session_fd, active_session_file = tempfile.mkstemp(
        prefix="hermes-tui-active-session-", suffix=".json")
    os.close(active_session_fd)
    env["HERMES_TUI_ACTIVE_SESSION_FILE"] = active_session_file
    try:
        env["HERMES_TUI_PARSER_CACHE"] = str(get_hermes_home() / "cache" / "opentui-parsers")
    except Exception:
        logger.debug("Failed to resolve OpenTUI parser cache dir", exc_info=True)
    # Engine packages are subprocess cwd; preserve the user's launch cwd for sessions/tools.
    env.setdefault("TERMINAL_CWD", _safe_tui_cwd(env))
    env.setdefault("NODE_ENV", "development" if tui_dev else "production")

    wt_info = None
    if worktree:
        wt_info = _setup_tui_worktree()
        env["HERMES_CWD"] = wt_info["path"]
        env["TERMINAL_CWD"] = wt_info["path"]

    _apply_tui_python_env(env)

    skills_value = ""
    if skills:
        skills_value = (
            ",".join(_split_comma_items(skills)) if isinstance(skills, (list, tuple)) else str(skills).strip())
    for key, value in (
        ("HERMES_MODEL", model), ("HERMES_INFERENCE_MODEL", model),
        ("HERMES_TUI_PROVIDER", provider), ("HERMES_INFERENCE_PROVIDER", provider),
        ("HERMES_TUI_TOOLSETS", ",".join(_normalize_tui_toolsets(toolsets))),
        ("HERMES_TUI_SKILLS", skills_value),
        ("HERMES_TUI_QUERY", query), ("HERMES_TUI_IMAGE", image),
        ("HERMES_TUI_CHECKPOINTS", "1" if checkpoints else None),
        ("HERMES_TUI_PASS_SESSION_ID", "1" if pass_session_id else None),
        ("HERMES_TUI_MAX_TURNS", str(max_turns) if max_turns is not None else None),
        ("HERMES_TUI_TOOL_PROGRESS", "verbose" if verbose else "off" if quiet else None),
        ("HERMES_ACCEPT_HOOKS", "1" if accept_hooks else None)):
        if value:
            env[key] = value
    # Both engines run on V8; respect a user cap and clamp the default to the cgroup limit.
    _apply_tui_heap_env(env)
    # HERMES_TUI_RESUME is an internal hand-off to the Ink app. We start from a
    # full os.environ snapshot, so a stale exported value would make a plain
    # `hermes --tui` try to resume a non-existent session; only forward the id
    # argparse resolved for this invocation.
    env.pop("HERMES_TUI_RESUME", None)
    if resume_picker:
        env["HERMES_TUI_RESUME"] = "picker"
    elif resume_session_id:
        env["HERMES_TUI_RESUME"] = resume_session_id

    argv, cwd = _make_tui_argv(tui_dir, tui_dev)
    _apply_opentui_native_env(argv, cwd, env)
    code: Optional[int] = None
    try:
        try:
            code = subprocess.call(argv, cwd=str(cwd), env=env)
        except KeyboardInterrupt:
            code = 130

        if code in {0, 130}:
            _print_tui_exit_summary(resume_session_id, active_session_file)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(active_session_file)
        if wt_info:
            with contextlib.suppress(Exception):
                from cli import _cleanup_worktree
                _cleanup_worktree(wt_info)

    # Exit code 42 = TUI requested an update. Relaunch as `hermes update`;
    # preserve_inherited=False keeps --tui and other flags out of the subcommand.
    if code == 42:
        from hermes_cli.relaunch import relaunch
        print("\n⚕ Launching update...\n")
        relaunch(["update"], preserve_inherited=False)

    sys.exit(code)


def _pin_kanban_board_env() -> None:
    """Pin the active kanban board into ``HERMES_KANBAN_BOARD`` so in-process tools and shelled-out
    ``hermes kanban`` calls agree even if a concurrent ``boards switch`` flips the file mid-turn.

    Without this, in-process tools (``kanban_*``) and shelled-out CLI calls (``hermes kanban …``) resolve
    the board on different paths: the env-pin if set, otherwise the global ``<root>/kanban/current`` file. A
    concurrent ``hermes kanban boards switch`` from another session can flip the file mid-turn, so the same
    chat sees its tool calls hit board A while its shell calls hit board B (#20074). Pinning at chat boot
    mirrors what the dispatcher already does for spawned workers.
    """
    if os.environ.get("HERMES_KANBAN_BOARD"):
        return
    with contextlib.suppress(Exception):
        from hermes_cli.kanban_db import get_current_board
        os.environ["HERMES_KANBAN_BOARD"] = get_current_board()


def _sync_bundled_skills_quietly() -> None:
    """Seed ``~/.hermes/skills/`` with the bundled library (idempotent, milliseconds when synced).
    Failures are swallowed: skills are an enhancement, not a hard dependency."""
    with contextlib.suppress(Exception):
        from tools.skills_sync import sync_skills
        sync_skills(quiet=True)


def _resolve_use_tui(args) -> bool:
    """Decide whether to launch the TUI: ``--cli`` → classic; ``--tui`` → TUI; no TTY → classic;
    ``HERMES_TUI=1`` → TUI; ``display.interface`` config; default classic.

    The TTY gate is load-bearing: ambient preferences must never hijack a piped
    ``hermes chat -q`` (kanban workers, cron) — the Ink no-TTY bail-out exits 0 and
    the worker dies with a protocol violation. Explicit ``--tui`` still bails out.
    """
    if getattr(args, "cli", False):
        return False
    if getattr(args, "tui", False):
        return True
    try:
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            return False
    except Exception:
        return False
    if os.environ.get("HERMES_TUI") == "1":
        return True
    try:
        from hermes_cli.config import load_config
        iface = (load_config().get("display", {}) or {}).get("interface", "cli")
        return isinstance(iface, str) and iface.strip().lower() == "tui"
    except Exception:
        return False
