#!/usr/bin/env bash
# Write the user-facing Hermes launcher.
#
# Usage:
#   write-hermes-launcher.sh <target> <managed-hermes-entrypoint> [ignored...]
#
# The launcher always executes the managed install, whatever the caller's
# working directory. Extra arguments are accepted and ignored so older
# installers that passed trusted checkouts keep working. A stale
# `<target>.trusted-roots` file from an earlier launcher is removed.
set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "usage: $0 <target> <managed-hermes-entrypoint>" >&2
    exit 2
fi

target="$1"
managed_cli="$2"
target_dir="$(dirname "$target")"
mkdir -p "$target_dir"

tmp="$(mktemp "$target_dir/.hermes-launcher.XXXXXX")"
cleanup() {
    rm -f "$tmp"
}
trap cleanup EXIT

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
exec "$managed_cli" "$@"
LAUNCHER
} > "$tmp"

chmod 755 "$tmp"
mv -f "$tmp" "$target"
rm -f "${target}.trusted-roots"
trap - EXIT
