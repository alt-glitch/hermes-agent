#!/usr/bin/env bash
# Write the user-facing Hermes launcher.
#
# Usage: write-hermes-launcher.sh <target> <managed-hermes-entrypoint>
#
# The generated launcher normally executes the managed install. When invoked
# from a trusted Hermes source checkout or linked worktree, it instead imports
# that checkout with the nearest dependency-complete Python environment.
set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "usage: $0 <target> <managed-hermes-entrypoint>" >&2
    exit 2
fi

target="$1"
managed_cli="$2"
target_dir="$(dirname "$target")"
mkdir -p "$target_dir"
tmp="$(mktemp "$target_dir/.hermes-launcher.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

{
    cat <<'HEADER'
#!/usr/bin/env bash
set -euo pipefail

unset PYTHONPATH
unset PYTHONHOME
export PYTHONSAFEPATH=1
HEADER
    printf 'managed_cli=%q\n' "$managed_cli"
    cat <<'LAUNCHER'
managed_python="$(dirname "$managed_cli")/python"

# A bare hermes inside a Hermes source checkout should exercise that exact
# checkout, including its TUI and gateway. Requiring all four markers avoids
# accidentally treating an unrelated repository as Hermes.
if command -v git >/dev/null 2>&1 \
    && repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" \
    && [ -f "$repo_root/pyproject.toml" ] \
    && [ -f "$repo_root/run_agent.py" ] \
    && [ -f "$repo_root/hermes_cli/main.py" ] \
    && [ -f "$repo_root/ui-opentui/package.json" ]; then
    candidates=(
        "$repo_root/.venv/bin/python"
        "$repo_root/venv/bin/python"
    )

    # Linked worktrees share the primary checkout's dependency environment.
    # Source imports remain pinned to repo_root below.
    common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [ -n "$common_dir" ]; then
        common_root="${common_dir%/.git}"
        if [ "$common_root" != "$repo_root" ]; then
            candidates+=(
                "$common_root/.venv/bin/python"
                "$common_root/venv/bin/python"
            )
        fi
    fi
    candidates+=("$managed_python")

    python=""
    for candidate in "${candidates[@]}"; do
        if [ -x "$candidate" ]; then
            python="$candidate"
            break
        fi
    done

    if [ -n "$python" ]; then
        export PYTHONPATH="$repo_root"
        export HERMES_PYTHON_SRC_ROOT="$repo_root"
        export HERMES_PYTHON="$python"
        exec "$python" -m hermes_cli.main "$@"
    fi
fi

exec "$managed_cli" "$@"
LAUNCHER
} > "$tmp"

chmod 755 "$tmp"
mv -f "$tmp" "$target"
trap - EXIT
