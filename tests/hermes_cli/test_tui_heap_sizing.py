"""Tests for cgroup-aware TUI V8 heap sizing.

V8 is not cgroup-aware: a flat ``--max-old-space-size=8192`` lets the heap grow
toward 8GB in a memory-limited container, so the cgroup OOM-killer SIGKILLs Node
before V8's own monitor fires — leaving the user with only a bare gateway
``stdin EOF`` and no breadcrumb. ``_resolve_tui_heap_mb`` reads the real cgroup
limit and sizes the cap below it so V8 exits gracefully instead.
"""

import builtins
import io
from unittest import mock

import hermes_cli.main as m

V2 = "/sys/fs/cgroup/memory.max"
V1 = "/sys/fs/cgroup/memory/memory.limit_in_bytes"
GB = 1024 ** 3


def _fake_open(files: dict):
    """Return an open() shim serving cgroup paths from ``files`` (path->str)."""
    real_open = builtins.open

    def opener(path, *args, **kwargs):
        if path in (V2, V1):
            content = files.get(path)
            if content is None:
                raise FileNotFoundError(path)
            return io.StringIO(content)
        return real_open(path, *args, **kwargs)

    return opener


def _read(files: dict):
    with mock.patch.object(builtins, "open", _fake_open(files)):
        return m._read_cgroup_memory_limit()


class TestReadCgroupMemoryLimit:
    def test_v2_max_is_unlimited(self):
        assert _read({V2: "max"}) is None

    def test_v2_numeric_limit(self):
        assert _read({V2: str(4 * GB)}) == 4 * GB

    def test_v1_unlimited_sentinel_is_none(self):
        # cgroup v1 reports "unlimited" as a near-INT64 huge value.
        assert _read({V1: "9223372036854771712"}) is None

    def test_v1_numeric_limit_when_no_v2(self):
        assert _read({V1: str(2 * GB)}) == 2 * GB

    def test_no_files_present(self):
        assert _read({}) is None

    def test_empty_v2_falls_through_to_v1(self):
        # A blank v2 file must NOT be mistaken for "unlimited" — fall to v1.
        assert _read({V2: "", V1: str(3 * GB)}) == 3 * GB

    def test_v2_wins_over_v1(self):
        assert _read({V2: str(6 * GB), V1: str(2 * GB)}) == 6 * GB

    def test_zero_is_skipped(self):
        assert _read({V2: "0"}) is None

    def test_petabyte_plus_treated_as_unlimited(self):
        assert _read({V2: str(1 << 51)}) is None


class TestResolveTuiHeapMb:
    def _resolve(self, limit_bytes):
        with mock.patch.object(m, "_read_cgroup_memory_limit", return_value=limit_bytes):
            return m._resolve_tui_heap_mb()

    def test_unconstrained_uses_default(self):
        assert self._resolve(None) == 8192

    def test_large_container_clamps_to_default(self):
        # 16GB -> 75% = 12288 >= 8192 -> clamp to 8192.
        assert self._resolve(16 * GB) == 8192

    def test_4gb_container_75_percent(self):
        assert self._resolve(4 * GB) == 3072

    def test_3gb_container_above_floor(self):
        assert self._resolve(3 * GB) == 2304

    def test_2gb_container_at_floor(self):
        assert self._resolve(2 * GB) == 1536

    def test_tiny_container_honors_limit_below_floor(self):
        # 1GB -> 75% = 768; honored even though below the 1536 floor, because a
        # graceful V8 exit beats a silent cgroup SIGKILL.
        assert self._resolve(1 * GB) == 768

    def test_never_exceeds_default(self):
        assert self._resolve(64 * GB) == 8192


class TestHeapOverride:
    """HERMES_TUI_HEAP_MB env / display.tui_heap_mb config override (W1/D3).

    The override REPLACES the 8192 default; the cgroup-fit clamp still applies on
    top so a too-high override can't exceed the container. Precedence: env > config.
    """

    def _resolve(self, limit_bytes, env=None, config_mb=None):
        with mock.patch.object(m, "_read_cgroup_memory_limit", return_value=limit_bytes), \
             mock.patch.object(m, "_config_tui_heap_mb_early", return_value=config_mb), \
             mock.patch.dict(m.os.environ, env or {}, clear=False):
            if env is None:
                m.os.environ.pop("HERMES_TUI_HEAP_MB", None)
            return m._resolve_tui_heap_mb()

    def test_env_override_unconstrained(self):
        # explicit low cap, no cgroup limit -> used as-is (the low-mem opt-in).
        assert self._resolve(None, env={"HERMES_TUI_HEAP_MB": "256"}) == 256

    def test_env_override_raises_ceiling(self):
        # a higher-than-default cap is honored when unconstrained.
        assert self._resolve(None, env={"HERMES_TUI_HEAP_MB": "16384"}) == 16384

    def test_env_wins_over_config(self):
        assert self._resolve(None, env={"HERMES_TUI_HEAP_MB": "512"}, config_mb=4096) == 512

    def test_config_used_when_no_env(self):
        assert self._resolve(None, config_mb=2048) == 2048

    def test_override_still_cgroup_clamped(self):
        # user asks for 16GB but the container is 4GB -> trimmed to 75% = 3072.
        assert self._resolve(4 * GB, env={"HERMES_TUI_HEAP_MB": "16384"}) == 3072

    def test_low_override_honored_under_big_container(self):
        # a deliberately low cap is NOT raised by a roomy container.
        assert self._resolve(16 * GB, env={"HERMES_TUI_HEAP_MB": "256"}) == 256

    def test_garbage_env_falls_through_to_default(self):
        assert self._resolve(None, env={"HERMES_TUI_HEAP_MB": "nope"}) == 8192

    def test_nonpositive_env_falls_through(self):
        assert self._resolve(None, env={"HERMES_TUI_HEAP_MB": "0"}) == 8192


class TestExposeGcOnOpenTuiArgv:
    """W1/D4: the OpenTUI engine argv must carry --expose-gc (parity with Ink) so
    global.gc() is a real call, not a no-op."""

    def test_opentui_argv_has_expose_gc(self, tmp_path):
        (tmp_path / ".git").mkdir()
        app_dir = tmp_path / "ui-opentui"
        (app_dir / "src" / "entry").mkdir(parents=True)
        (app_dir / "src" / "entry" / "main.tsx").write_text("// entry")
        (app_dir / "node_modules" / "@opentui").mkdir(parents=True)
        (app_dir / "dist").mkdir()
        (app_dir / "dist" / "main.js").write_text("// built")
        with mock.patch.object(m, "PROJECT_ROOT", tmp_path), \
             mock.patch.object(m, "_node26_bin", return_value="/usr/bin/node"), \
             mock.patch.object(
                 m,
                 "_opentui_node_identity",
                 return_value=m._opentui_runtime.NodeIdentity(
                     executable="/usr/bin/node",
                     version="v26.3.0",
                     platform="linux",
                     arch="x64",
                 ),
             ), \
             mock.patch.object(
                 m._opentui_runtime, "runtime_sentinels_current", return_value=True
             ), \
             mock.patch.object(
                 m._opentui_runtime, "dependencies_current", return_value=True
             ), \
             mock.patch.object(
                 m._opentui_runtime, "bundle_needs_rebuild", return_value=False
             ):
            argv, cwd = m._make_opentui_argv(tui_dev=False)
        assert "--expose-gc" in argv
        assert argv[0] == "/usr/bin/node"
        assert argv[-1].endswith("dist/main.js")
        assert cwd == app_dir


class TestNodeOptionsTokenMerge:
    """The _launch_tui token-merge block must add the sized cap unless the user
    already supplied one, and must preserve unrelated NODE_OPTIONS flags."""

    def _merge(self, node_options, limit_bytes):
        with mock.patch.object(m, "_read_cgroup_memory_limit", return_value=limit_bytes):
            tokens = node_options.split()
            if not any(t.startswith("--max-old-space-size=") for t in tokens):
                tokens.append(f"--max-old-space-size={m._resolve_tui_heap_mb()}")
            return " ".join(tokens)

    def test_unconstrained_empty(self):
        assert self._merge("", None) == "--max-old-space-size=8192"

    def test_constrained_container(self):
        assert self._merge("", 4 * GB) == "--max-old-space-size=3072"

    def test_user_override_respected(self):
        assert self._merge("--max-old-space-size=12288", 2 * GB) == "--max-old-space-size=12288"

    def test_preserves_other_flags(self):
        assert self._merge("--enable-source-maps", 4 * GB) == "--enable-source-maps --max-old-space-size=3072"
