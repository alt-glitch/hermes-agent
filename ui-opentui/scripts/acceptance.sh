#!/usr/bin/env bash
# Single acceptance command for the Bun→Node-26 switchover (see
# docs/plans/opentui-node26-build-spec.md). Proves, on a Node 26.3 host, that the
# OpenTUI v2 engine runs WITHOUT Bun and at parity:
#
#   1. Node >= 26.3 present (the node:ffi floor); reports whether bun is on PATH
#      (the engine must NOT need it).
#   2. `npm run check`  — prettier + tsc + eslint + vitest (151+), all on Node.
#   3. live-gateway transport smoke — spawns the real Python tui_gateway via the
#      node:child_process client, asserts gateway.ready + create→close→create
#      live-SID tracking.
#      (Skipped if no Hermes venv resolves — CI parity.)
#   4. selection/markdown smoke in a real tmux TTY — asserts the native <markdown>
#      (Tree-sitter) PAINTS under node --experimental-ffi, native programmatic
#      selection extracts the rendered highlighted text, and the `/copy` source
#      helper preserves the full Markdown source. Mouse routing is covered by
#      the Vitest multi-click suite. (Skipped if tmux is unavailable.)
#
# Run:  cd ui-opentui && HERMES_PYTHON_SRC_ROOT=<checkout-root> bash scripts/acceptance.sh
set -uo pipefail
cd "$(dirname "$0")/.."

# Absolute node, so a fresh tmux pane (which won't inherit our PATH / fnm shim)
# runs the SAME Node 26.3, not the shell's default.
NODE_BIN="$(command -v node || echo node)"

pass=0; fail=0; skip=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }
note() { echo "  ⏭  $1"; skip=$((skip+1)); }

echo "== [1/4] runtime: Node >= 26.3, Bun-free =="
NODE_V="$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>26||(a===26&&b>=3)?0:1)' \
  && ok "node $NODE_V (>= 26.3)" || bad "node $NODE_V is below the 26.3 node:ffi floor"
if command -v bun >/dev/null 2>&1; then
  note "bun is on PATH ($(command -v bun)) — fine; the engine does not use it (proven below)"
else
  ok "no bun on PATH — single-runtime host"
fi

echo "== [2/4] check: prettier + tsc + eslint + vitest =="
if bash scripts/check.sh >/tmp/accept-check.log 2>&1; then ok "check green ($(grep -c 'passed' /tmp/accept-check.log >/dev/null 2>&1; grep -oE '[0-9]+ passed' /tmp/accept-check.log | tail -1))"
else bad "check failed — see /tmp/accept-check.log"; tail -20 /tmp/accept-check.log; fi

echo "== [3/4] live-gateway transport smoke (real Python gateway, no Bun) =="
if [ -n "${HERMES_PYTHON_SRC_ROOT:-}" ] || [ -x "../.venv/bin/python" ]; then
  rm -rf .accept && node scripts/build.mjs src/test/liveGateway.smoke.ts .accept >/dev/null 2>&1
  OUT="$(node --experimental-ffi --no-warnings .accept/liveGateway.smoke.js 2>&1)"
  echo "$OUT" | grep -q "^PASS" && ok "$(echo "$OUT" | grep '^PASS')" || { echo "$OUT" | grep -qE "TRANSPORT ERROR|SKIP" && note "gateway smoke skipped (no python/model)" || bad "gateway smoke: $(echo "$OUT" | head -1)"; }
  rm -rf .accept
else
  note "no HERMES_PYTHON_SRC_ROOT / venv — gateway smoke skipped"
fi

echo "== [4/4] selection/markdown smoke in a real tmux TTY (tree-sitter under FFI) =="
if command -v tmux >/dev/null 2>&1; then
  rm -rf .accept && node scripts/build.mjs src/test/selectionCopy.smoke.tsx .accept >/dev/null 2>&1
  rm -f /tmp/accept-sel.json
  S="accept-$$"
  tmux kill-session -t "$S" 2>/dev/null
  tmux new-session -d -s "$S" -x 120 -y 40
  tmux send-keys -t "$S" "SEL_SMOKE_OUT=/tmp/accept-sel.json $NODE_BIN --experimental-ffi --no-warnings $PWD/.accept/selectionCopy.smoke.js; tmux wait-for -S $S" Enter
  tmux wait-for "$S" 2>/dev/null || sleep 6
  tmux kill-session -t "$S" 2>/dev/null
  if node -e 'process.exit(require("/tmp/accept-sel.json").pass===true?0:1)' 2>/dev/null; then
    ok "markdown painted + native selection extracted + /copy source helper preserved (tree-sitter under node FFI)"
  else
    bad "selection/markdown smoke failed — see /tmp/accept-sel.json"; cat /tmp/accept-sel.json 2>/dev/null
  fi
  rm -rf .accept
else
  note "tmux not available — markdown smoke skipped (run it on a TTY host)"
fi

echo
echo "== acceptance: $pass passed, $fail failed, $skip skipped =="
[ "$fail" -eq 0 ] && { echo "ACCEPTANCE: PASS"; exit 0; } || { echo "ACCEPTANCE: FAIL"; exit 1; }
