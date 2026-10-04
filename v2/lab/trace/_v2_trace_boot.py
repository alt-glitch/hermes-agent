"""Installed into a Hermes venv's site-packages by v2/lab/trace/install.sh, loaded by v2_trace_lab.pth.

Does nothing unless V2_TRACE_DIR is set. When it is, loads the tracer from V2_TRACE_LAB (a file path)
without touching sys.path, and installs it for this process.
"""

import os

if os.environ.get("V2_TRACE_DIR") and os.environ.get("V2_TRACE_LAB"):
    try:
        import importlib.util

        _spec = importlib.util.spec_from_file_location("hermes_trace_lab", os.environ["V2_TRACE_LAB"])
        if _spec is None or _spec.loader is None:
            raise ImportError(f"no tracer at {os.environ['V2_TRACE_LAB']}")
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        _mod.install(os.environ["V2_TRACE_DIR"])
    except Exception as _exc:  # noqa: BLE001 -- a broken lab must never break a Hermes run
        import sys

        sys.stderr.write(f"v2 trace lab disabled: {_exc!r}\n")
