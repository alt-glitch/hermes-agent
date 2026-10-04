#!/usr/bin/env bash
# Install (or remove with --uninstall) the opt-in trace hook into the interpreters a Hermes run uses.
#
# Sid's daily `hermes` is ~/.local/bin/hermes -> ~/.hermes/hermes-agent/venv/bin/hermes (a 3.11 venv
# console script). hermes_bootstrap may then os.execv into PM's managed runtime with `-I -c ...`
# (see `~/.hermes/hermes-agent/.hermes/bin/hermes --print-runtime-command`). Isolated mode still
# processes .pth files in the interpreter's own site-packages, so the hook goes into both.
# It is inert unless V2_TRACE_DIR is set; `hermes-traced` sets it for one run.
#
# usage: install.sh [--uninstall] [--python PATH]...   (default: both interpreters above)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fork="$HOME/.hermes/hermes-agent"
mode=install; pys=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) mode=uninstall; shift ;;
    --python) pys+=("$2"); shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [[ ${#pys[@]} -eq 0 ]]; then
  pys+=("$fork/venv/bin/python")
  runtime="$("$fork/.hermes/bin/hermes" --print-runtime-command 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])' 2>/dev/null || true)"
  [[ -n "$runtime" ]] && pys+=("$runtime")
fi
for py in "${pys[@]}"; do
  purelib="$("$py" -I -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
  if [[ "$mode" == uninstall ]]; then
    rm -f "$purelib/v2_trace_lab.pth" "$purelib/_v2_trace_boot.py"
    echo "removed v2 trace hook from $purelib"
  else
    cp "$here/_v2_trace_boot.py" "$purelib/_v2_trace_boot.py"
    printf 'import _v2_trace_boot\n' > "$purelib/v2_trace_lab.pth"
    echo "installed v2 trace hook into $purelib ($("$py" -I -c 'import sys; print(sys.version.split()[0])'))"
  fi
done
