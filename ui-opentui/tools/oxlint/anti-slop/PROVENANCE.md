# Vendored anti-slop rules

Source: https://github.com/dmmulroy/anti-slop

Revision: `e8c4880471b23ab7f216fba7b27d173a6ef07d4c`

Copied with the upstream `skills/install-anti-slop/scripts/install.mjs` on
2026-09-05. Rule sources are unchanged. The upstream MIT license is included.

`npm run lint:anti-slop` audits owned `src/` with all generic rules and the
Effect rule enabled. It reports unresolved findings and exits nonzero; it does
not replace ESLint or run inside `npm run check` yet. The normal type-aware
ESLint, formatting, build, and test gates remain in force.

Treat findings as review leads. Hermes deliberately accepts `unknown` at
external decoder boundaries and uses framework-owned callbacks; satisfying a
blanket rule by lying about those input types would weaken the program.
Resolve or document boundary policy before promoting this audit to a gate.

To update, compare a pinned upstream revision, run its installer into a new
temporary directory, review the rule diff, and update this revision. Keep
`oxlint` and `@oxlint/plugins` on the same exact version.
