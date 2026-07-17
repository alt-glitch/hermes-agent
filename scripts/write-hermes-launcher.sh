#!/usr/bin/env bash
# Write the user-facing Hermes launcher.
#
# Usage:
#   write-hermes-launcher.sh <target> <managed-hermes-entrypoint> [trusted-checkout...]
#
# The launcher normally executes the managed install. In an explicitly trusted
# Hermes Git checkout (or any linked worktree sharing its common Git dir), it
# imports that checkout with the nearest dependency-complete Python environment.
set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "usage: $0 <target> <managed-hermes-entrypoint> [trusted-checkout...]" >&2
    exit 2
fi

target="$1"
managed_cli="$2"
target_dir="$(dirname "$target")"
trust_file="${target}.trusted-roots"
mkdir -p "$target_dir"

trusted_roots=()

add_trusted_common_dir() {
    local value="$1"
    local existing
    [ -n "$value" ] && [ -d "$value" ] || return 0
    for existing in "${trusted_roots[@]}"; do
        [ "$existing" = "$value" ] && return 0
    done
    trusted_roots+=("$value")
}

add_trusted_checkout() {
    local checkout="$1"
    local common_dir
    [ -d "$checkout" ] || return 0
    common_dir="$(git -C "$checkout" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    add_trusted_common_dir "$common_dir"
}

# Explicit trust survives installer reruns. Only existing absolute Git common
# directories are retained; repository-controlled files are never consulted.
if [ -f "$trust_file" ] && [ ! -L "$trust_file" ]; then
    while IFS= read -r common_dir || [ -n "$common_dir" ]; do
        case "$common_dir" in
            /*) add_trusted_common_dir "$common_dir" ;;
        esac
    done < "$trust_file"
fi

managed_bin_dir="$(dirname "$managed_cli")"
managed_root="$(cd "$managed_bin_dir/../.." 2>/dev/null && pwd -P || true)"
add_trusted_checkout "$managed_root"
if [ "$#" -gt 2 ]; then
    for checkout in "${@:3}"; do
        add_trusted_checkout "$checkout"
    done
fi

tmp="$(mktemp "$target_dir/.hermes-launcher.XXXXXX")"
tmp_trust="$(mktemp "$target_dir/.hermes-trust.XXXXXX")"
cleanup() {
    rm -f "$tmp" "$tmp_trust"
}
trap cleanup EXIT

for common_dir in "${trusted_roots[@]}"; do
    printf '%s\n' "$common_dir"
done > "$tmp_trust"
chmod 600 "$tmp_trust"

{
    cat <<'HEADER'
#!/usr/bin/env bash
set -euo pipefail

unset PYTHONPATH
unset PYTHONHOME
export PYTHONSAFEPATH=1
HEADER
    printf 'managed_cli=%q\n' "$managed_cli"
    printf 'trust_file=%q\n' "$trust_file"
    cat <<'LAUNCHER'
managed_python="$(dirname "$managed_cli")/python"

if command -v git >/dev/null 2>&1 &&
    repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" &&
    common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" &&
    [ -f "$trust_file" ] &&
    [ ! -L "$trust_file" ] &&
    grep -Fqx -- "$common_dir" "$trust_file" &&
    [ -f "$repo_root/pyproject.toml" ] &&
    [ -f "$repo_root/run_agent.py" ] &&
    [ -f "$repo_root/hermes_cli/main.py" ]; then
    candidates=(
        "$repo_root/.venv/bin/python"
        "$repo_root/venv/bin/python"
    )

    common_root="${common_dir%/.git}"
    if [ "$common_root" != "$repo_root" ]; then
        candidates+=(
            "$common_root/.venv/bin/python"
            "$common_root/venv/bin/python"
        )
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
mv -f "$tmp_trust" "$trust_file"
mv -f "$tmp" "$target"
trap - EXIT
