# Pi Agent collector automated verification

Date: 2026-07-27

## Environment

- OS: openEuler 24.03 LTS SP4, x86_64
- Node.js: 22.23.1
- npm: 10.9.8
- Pi Agent: 0.82.1
- Source HEAD under test: `87c99c9afebfe6a51d965413fc9c71e5775d442a`

The upstream lockfile was not installable as-is: it resolved
`protobufjs@8.0.1` where the package graph requires `7.6.5`. Validation used an
isolated clone with:

```bash
npm install --package-lock=false --no-audit --no-fund
```

The Linux production build also needed an isolated `ws@8` installation because
the existing `langsmith@0.8.7` peer dependency was absent. Neither workaround
changed `package.json`, `package-lock.json`, or this PR's source diff.

## Targeted verification

```bash
node --import tsx --test \
  test/trace-transport.test.ts \
  test/pi-agent-collector.test.ts \
  test/pi-agent-adapter.test.ts \
  test/pi-agent-distribution.test.ts \
  test/framework-adapter-registry.test.ts \
  test/otel-trace-aggregator.test.ts
```

| Check | Result |
| --- | --- |
| Pi collector core selection | 24 passed, 0 failed |
| Collector, transport, Adapter, distribution, registry, and aggregator selection | 48 passed, 0 failed |
| Target ESLint | passed |
| Pi/shared CommonJS syntax checks | passed |
| Production build | passed |
| `git diff --check` | passed |
| Shared transport equality with issue #159 branch | passed; SHA-256 `8EB1D524F09D7CB42C00511813E2341860661BBDC298A3FB9D9F47FC5E41F868` |

## Repository-wide test

A fresh SQLite database and isolated HOME were used:

| Command | Result |
| --- | --- |
| `npm test` | 689 tests: 673 passed, 15 failed, 1 skipped |

The 15 failures are shared with the Codex branch and are outside the Pi target
selection. They cover existing setup-wrapper assertions, experiment-engine and
experiment API database initialization, trace lifecycle assertions, and OTel
consumer cooldown timing. The Pi target suites, target lint, and production
build are clean.

## Runtime evidence

The openEuler E2E covered real Pi package installation, listing, Extension
loading without a provider, removal, reinstall, self-check, server persistence,
HTTP 500 recovery, replay idempotency, a 20-sample startup comparison, and one
RSS point sample. Details and remaining gates are recorded in
`test/pi-agent-trace/reports/e2e.md`.
