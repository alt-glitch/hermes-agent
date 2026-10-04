"""v2 trace lab: record which Hermes functions a real run executes, in the order it first reaches them.

Opt-in and inert by default. `_v2_trace_boot.py` (installed as a .pth hook by install.sh) loads this
file only when V2_TRACE_DIR is set, so every Python process of a traced run (the CLI, the TUI's
gateway child, cron, subprocess workers) writes one JSONL file into that directory.

What is recorded, per process, once per code object (function, method, lambda, module body):
  t    seconds since the process started tracing
  f    "<module>:<qualname>" of the function entered for the first time
  file absolute source path, line = co_firstlineno
  c    "<module>:<qualname>" of the nearest project-code caller at that first call
       (importlib/stdlib frames are skipped, so a module body's caller is the module that imported it;
       this is a first-call tree, not every edge)
  th   thread name
No arguments, return values, locals or environment values are recorded.

Only project code is recorded: anything under the stdlib, site-packages or a frozen module is skipped.

Python >= 3.12 uses sys.monitoring (PEP 669) and disables each code object after its first event,
so the steady-state cost is near zero. Python 3.11 falls back to sys.setprofile, which costs one
Python-level callback per call; expect a slower but usable session.
"""

import json
import os
import site
import sys
import sysconfig
import threading
import time

_lock = threading.Lock()
_state: dict = {}


def _skip_prefixes() -> tuple[str, ...]:
    paths = {sysconfig.get_paths().get(k, "") for k in ("stdlib", "platstdlib", "purelib", "platlib")}
    try:
        paths.update(site.getsitepackages())
    except AttributeError:  # some embedded/venv layouts lack it
        pass
    user = getattr(site, "USER_SITE", None)
    if user:
        paths.add(user)
    return tuple(sorted(p for p in paths if p))


def _make_keep():
    skip = _skip_prefixes()
    cache: dict[str, bool] = {}

    def keep(filename: str) -> bool:
        k = cache.get(filename)
        if k is None:
            k = not (filename.startswith("<") or filename.startswith(skip) or "site-packages" in filename)
            cache[filename] = k
        return k

    return keep


def _name(code, frame) -> str:
    mod = frame.f_globals.get("__name__", "?") if frame is not None else "?"
    return f"{mod}:{getattr(code, 'co_qualname', code.co_name)}"


def _project_caller(caller, keep):
    """Nearest calling frame that is project code (skips importlib/stdlib/library frames)."""
    hops = 0
    while caller is not None and hops < 40 and not keep(caller.f_code.co_filename):
        caller, hops = caller.f_back, hops + 1
    return caller


def _emit(code, frame, caller) -> None:
    st = _state
    caller = _project_caller(caller, st["keep"])
    rec = {
        "t": round(time.perf_counter() - st["t0"], 4),
        "f": _name(code, frame),
        "file": code.co_filename,
        "line": code.co_firstlineno,
        "c": _name(caller.f_code, caller) if caller is not None else None,
        "th": threading.current_thread().name,
    }
    line = json.dumps(rec, separators=(",", ":"))
    with _lock:
        fh = st["fh"]
        if not st["header_written"]:
            st["header_written"] = True
            fh.write(json.dumps({
                "kind": "process", "pid": os.getpid(), "ppid": os.getppid(), "argv": sys.argv,
                "executable": sys.executable, "python": sys.version.split()[0],
                "tag": os.environ.get("V2_TRACE_TAG"), "started": st["wall0"],
                "mode": st["mode"],
            }) + "\n")
        fh.write(line + "\n")


def install(out_dir: str) -> None:
    if _state:
        return
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{int(time.time() * 1000)}-{os.getpid()}.jsonl")
    _state.update(fh=open(path, "a", buffering=1, encoding="utf-8"), t0=time.perf_counter(),  # noqa: SIM115 -- lives for the process
                  wall0=time.time(), header_written=False, mode="")
    keep = _make_keep()
    _state["keep"] = keep

    mon = getattr(sys, "monitoring", None)
    if mon is not None:
        tool = mon.PROFILER_ID
        try:
            mon.use_tool_id(tool, "v2-trace-lab")
        except ValueError:  # another profiler owns the slot; stay out of its way
            return
        _state["mode"] = "sys.monitoring"

        def on_start(code, offset):
            if keep(code.co_filename):
                frame = sys._getframe(1)
                _emit(code, frame, frame.f_back)
            return mon.DISABLE

        mon.register_callback(tool, mon.events.PY_START, on_start)
        mon.set_events(tool, mon.events.PY_START)
        return

    _state["mode"] = "sys.setprofile"
    seen: set = set()

    def prof(frame, event, arg):
        if event != "call":
            return
        code = frame.f_code
        if code in seen:
            return
        seen.add(code)
        if keep(code.co_filename):
            _emit(code, frame, frame.f_back)

    sys.setprofile(prof)
    threading.setprofile(prof)
