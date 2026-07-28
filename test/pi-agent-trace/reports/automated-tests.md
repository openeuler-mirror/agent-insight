# Pi Agent collector automated verification

Date: 2026-07-28

## Environment

- OS: openEuler 24.03 LTS SP4, x86_64
- Node.js: 22.23.1
- npm: 10.9.8
- Pi Agent: 0.82.1
- Initial openEuler E2E source HEAD:
  `87c99c9afebfe6a51d965413fc9c71e5775d442a`
- Post-rebase verification HEAD:
  `e7841ce0cbe5978d6c1e00fc37f4dfed1513b1ec`
- Final implementation verification HEAD:
  `cbc5372d9169864b997866b9b28cdb5f0d41fb16`
- Latest upstream rebase verification source HEAD:
  `87f4e6e7aa8484fcf2a3a205fd7e23a3402a2868`
- Upstream `master`: `1c6eaf7f7b7c833ab99ce44472f26f50cd422be3`

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
| Shared transport equality with issue #159 branch | passed; SHA-256 `DF9C6F22083B86C2B133241EB1DE1AEC4B08F46C979263DCC39DE07486F08139` |

After upstream `master` advanced, the branch was rebased and the shared OTel
adapter-order assertion was resolved by preserving upstream `openclaw` before
`pi-agent`. The targeted 48-test selection, added-file ESLint, CommonJS syntax,
`git diff --check`, Prisma initialization, and production build were rerun at
the final implementation verification HEAD and passed.

After the later rebase to upstream `1c6eaf7f`, the 48-test target selection,
repository-wide test, repository-wide lint, and production build were rerun on
openEuler. The target selection and build passed; the refreshed repository-wide
results are recorded below.

## Repository-wide test

A fresh SQLite database and isolated HOME were used:

| Command | Result |
| --- | --- |
| `npm test` | 703 tests: 693 passed, 9 failed, 1 skipped |
| `npm run lint` | failed: 1,973 problems (1,685 errors, 288 warnings) |

The 9 failures are shared with the Codex branch and are outside the Pi target
selection. They are the existing experiment-engine suite and experiment API
tests, which pin a repository-local database path that was not initialized by
the isolated `DATABASE_URL`. The Pi target suites, added-file lint, syntax
checks, and production build are clean. Repository-wide lint also fails
identically on both branches, primarily on pre-existing
`@typescript-eslint/no-explicit-any` findings outside this change set.

## Runtime evidence

The openEuler E2E covered real Pi package lifecycle, MiniMax-M3 inference,
exact native usage, automatic Skill, MCP, a provider-backed child process,
server persistence, HTTP 500 recovery, scoped purge, 20-sample startup,
30+30 real TTFT, and short matched-process RSS curves. Details and remaining
gates are recorded in `test/pi-agent-trace/reports/e2e.md`.
