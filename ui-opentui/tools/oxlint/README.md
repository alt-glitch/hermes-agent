# OpenTUI anti-slop audit

Run from `ui-opentui` with Node 26.3 or later:

```sh
npm run lint:anti-slop
npm run --silent lint:anti-slop -- --format json > /tmp/opentui-anti-slop.json
```

This is an explicit migration audit, separate from the existing type-aware
ESLint gate. All 16 upstream generic/Effect rules run at error severity against
owned `src/`, including tests. Unresolved findings return a nonzero exit code.
Vendor, dependencies, generated output, and reference checkouts are excluded.
`npm run check` continues to enforce its existing checks.

## Initial audit, 2026-09-05

The pinned rules inspected 306 source files. A targeted cleanup reduced 1,124
diagnostics to 1,089 (905 in production source and 184 in tests). These are
review findings, not 1,089 proven bugs. Counts are a dated observation, not a
baseline to copy into tests or use as a pass threshold.

| Rule | Remaining |
| --- | ---: |
| no-runtime-typeof | 279 |
| require-safety-comment-for-type-assertion | 245 |
| no-unknown-parameters | 210 |
| no-unsafe-dictionary-type | 137 |
| no-conditional-empty-object-spread | 77 |
| no-known-value-widening | 69 |
| no-unknown-returns | 30 |
| no-shape-in-symbol-names | 14 |
| no-chained-type-assertions | 13 |
| no-module-mocking | 6 |
| no-object-parameters | 5 |
| no-reflect-get | 2 |
| Effect no-service-constructor-imports | 2 |
| no-reflect-apply / no-unknown-type-aliases / no-widen-then-assert | 0 |

The cleanup removed a duplicate telemetry parser and raw assertions by making
status metrics part of the owning Schema. Malformed metrics remain individually
omitted; valid session state survives. It also replaced status aliases with a
typed lookup, made status ranking exhaustive, retained the known markdown
plugin keys, renamed the transport contract for its role, and removed stale
claims that only the fake gateway existed.

## Review findings by ownership

- Decoder inputs: `unknown` is the correct external input type. Move validation
  to the owning boundary and pass typed results inward; do not relabel incoming
  JSON as trusted solely to silence `no-unknown-parameters` or `no-runtime-typeof`.
- Optional request fields: absence is not equivalent to explicit `undefined`.
  Preserve wire omission when replacing conditional object spreads.
- Composition root: `entry/main.tsx` intentionally constructs application and
  fixture Layers. The generic constructor-import rule currently reports this
  legitimate wiring; do not relocate or rename construction to evade it.
- Journey rendering: the follow-up added visual schemas in `JourneyResponses.ts`
  and removed the view's double assertion. Malformed frames or legends fall back
  independently to empty visuals without hiding the validated learning list;
  `journey.test.ts` and `journeyView.test.tsx` cover this boundary and interaction.
  The initial diagnostic totals above predate this follow-up.
- Assertions: justify only invariants established by real code. Prefer removing
  the assertion or fixing the owner contract over adding a stock safety comment.

Before making the audit blocking, adjudicate the boundary and composition-root
rules, resolve remaining findings, and verify the current tree. Do not add an
error-count allowance, suppress all of `src/boundary`, or weaken existing gates.

The lightweight cleanup metric counts `if`, ternary, loops, catch, switch cases,
and logical/nullish operators in TypeScript AST function bodies, excluding
nested functions. It is a branch count, not ESLint's default complexity score.
The telemetry reader/projection changed from 40 to 34 points; status alias
normalization changed from 26 to 2. Those measurements explain particular
refactors and are not a reason to hide real decisions behind helper calls.

See [vendor provenance](anti-slop/PROVENANCE.md) for the pinned revision and
update procedure.
