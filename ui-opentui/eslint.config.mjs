import js from "@eslint/js"
import tseslint from "typescript-eslint"
import unusedImports from "eslint-plugin-unused-imports"

export default tseslint.config(
  {
    // .bench/ and .demo/ are build artifacts (bench `nodes` cell and the
    // smoke demo: `node scripts/build.mjs scripts/demo.tsx .demo`) — never lint.
    ignores: [
      "node_modules/**",
      "dist/**",
      ".accept*/**",
      ".bench/**",
      ".demo/**",
      ".repos/**",
      "*.frame.txt",
      "*.ansi",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      // Boundary code bans these; the Solid view follows TS-strict but is not Effect.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-non-null-assertion": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        { vars: "all", varsIgnorePattern: "^_", args: "after-used", argsIgnorePattern: "^_" },
      ],

      // --- Type-aware, high-value: ON as ERROR ---
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // --- Type-safety: ENFORCED as errors in our boundary/logic .ts code ---
      // Production .ts is clean of the no-unsafe-* family (the loose-typed gateway
      // payloads are Schema-decoded). The only sources are (a) *.tsx — @opentui/solid's
      // JSX namespace types every component `return (<…>)` as `error`/unknown, a
      // framework limitation disabled for views below — and (b) the test harness
      // (loose render/effect fixtures + async mocks), exempt below. So we enforce ERROR.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/require-await": "error",
      // Defensive guards on untrusted runtime/gateway data: TS's narrowing doesn't
      // model the wire, so "condition is always truthy" here is intentional armor,
      // not dead code. Kept as a hint (warn), not a gate failure.
      "@typescript-eslint/no-unnecessary-condition": "warn",
    },
  },
  {
    // @opentui/solid's custom JSX namespace types component returns as `error`/
    // unknown, so EVERY `return (<…>)` in a view trips the no-unsafe-* family.
    // That's a framework typing limitation, not unsafe app code — off for views.
    files: ["**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
  {
    // Test helpers/fixtures: keep `!` on known-present data, and allow the loose
    // render/effect harness casts + async mock signatures (they satisfy real
    // Promise-returning interfaces with no body to await).
    files: ["**/*.test.ts", "**/*.test.tsx", "src/test/lib/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Build/config scripts (the eslint flat config, the esbuild build.mjs, the
    // vitest config) are not part of the typed TS program, so the project service
    // can't type them — disable type-aware linting there to avoid parser errors,
    // and declare the Node globals they use (process, console, URL).
    files: ["**/*.mjs", "*.config.ts"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { process: "readonly", console: "readonly", URL: "readonly", URLSearchParams: "readonly" },
    },
  },
)
