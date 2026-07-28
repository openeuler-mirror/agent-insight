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

## Central onboarding verification

```powershell
node --import tsx --test `
  test/pi-agent-central-setup.test.ts `
  test/pi-agent-distribution.test.ts
```

The final 12-test selection passed. It covers the three append-only framework
lists, preselection and invalid-value filtering, Bash and PowerShell syntax,
local package detection, fixed asset allowlists, setup staging, self-check,
reinstall, and API-Key-scoped purge. The final production build and
`git diff --check` also passed.

## Repository-wide test

Fresh databases and isolated user homes were used:

| Environment | Command | Result |
| --- | --- | --- |
| Windows | `npm test` | 710 tests: 658 passed, 39 failed, 13 skipped |
| openEuler SP4 | `npm test` | 710 tests: 696 passed, 13 failed, 1 skipped |
| Windows | `npm run lint` | 1,973 tracked problems: 1,685 errors, 288 warnings |

The Windows failure set is identical on the Pi and Codex branches apart from
the absolute experiment-engine test path. It consists of repository database
fixtures, Windows Hermes Python assumptions, and infrastructure/OTLP test
environment dependencies. The openEuler failures are the same fixture and
infrastructure baseline plus the central PowerShell parser assertion when
PowerShell is unavailable (`status=null`); the native Windows focused run
passed that parser assertion. The tracked full-lint count is unchanged from the
repository baseline and is dominated by existing
`@typescript-eslint/no-explicit-any` findings.

## Runtime evidence

The openEuler E2E covered central Bash installation, the local npm tarball
chain, real Pi package lifecycle, MiniMax-M3 inference, exact native usage,
automatic Skill, MCP, a provider-backed child process, cross-machine server
persistence, HTTP 500 recovery, scoped purge, 20-sample startup, 30+30 real
TTFT, and short matched-process RSS curves. Details are recorded in
`test/pi-agent-trace/reports/e2e.md`.
