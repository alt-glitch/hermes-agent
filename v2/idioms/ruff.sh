#!/usr/bin/env bash
# Ruff counts for the ruff-backed idioms in v2/PRINCIPLES.md. Isolated: ignores the repo's ruff config
# on purpose, because the point is to measure against the v2 idioms, not today's lint baseline.
# Static analysis only. Never runs tests.
set -euo pipefail
cd "$(dirname "$0")/../.."
uvx ruff@0.15.10 check --isolated --no-cache --exit-zero --output-format json \
  --target-version py314 \
  --select UP006,UP007,UP035,UP045,E722,G004,T201,PTH,C901 \
  --config 'lint.mccabe.max-complexity = 15' \
  agent tools hermes_cli gateway tui_gateway cron plugins pm acp_adapter providers hermes_platform \
  $(ls *.py | grep -vE '^(batch_runner|mini_swe_runner|trajectory_compressor|toolset_distributions)\.py$') \
  --exclude '**/tests/**' > v2/idioms/ruff.json
python3 -c "import json;d=json.load(open('v2/idioms/ruff.json'));print(len(d),'ruff diagnostics')"
