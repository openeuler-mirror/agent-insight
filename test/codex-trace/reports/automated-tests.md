# Codex Trace collector automated verification

Date: 2026-07-28

## Environment

- OS: openEuler 24.03 LTS SP4, x86_64
- Node.js: 22.23.1
- npm: 10.9.8
- Codex CLI: 0.145.0
- Initial openEuler E2E source HEAD:
  `e23f599ddde766eebe4e413580731535b5ff2abb`
- Post-rebase verification HEAD:
  `ff733e0e212ad4b13754ba7e2f7bd28a62b2374b`
- Final implementation verification HEAD:
  `c63864fa5d99c8abe9aeb19935e09143d24583b6`
- Latest upstream rebase verification source HEAD:
  `21c8f02d3d7798d19e7667a92fede585dc79a4ce`
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
  test/codex-hook-collector.test.ts \
  test/codex-otel-relay.test.ts \
  test/codex-install.test.ts \
  test/codex-extension-core.test.ts \
  test/codex-adapter.test.ts \
  test/framework-adapter-registry.test.ts \
  test/otel-trace-aggregator.test.ts
```

| Check | Result |
| --- | --- |
| Hook, OTel relay, Adapter, installer, VSIX core, transport, registry, and aggregator selection | 75 passed, 0 failed |
| Target ESLint | passed |
| Codex/shared CommonJS syntax checks | passed |
| Production build | passed |
| `git diff --check` | passed |
| Shared transport equality with issue #158 branch | passed; SHA-256 `DF9C6F22083B86C2B133241EB1DE1AEC4B08F46C979263DCC39DE07486F08139` |

After upstream `master` advanced, the branch was rebased and the shared OTel
adapter-order assertion was resolved by preserving upstream `openclaw` before
`codex`. The targeted 75-test selection, added-file ESLint, CommonJS syntax,
`git diff --check`, Prisma initialization, and production build were rerun at
the final implementation verification HEAD and passed.

After the later rebase to upstream `1c6eaf7f`, the 75-test target selection,
repository-wide test, repository-wide lint, and production build were rerun on
openEuler. The target selection and build passed; the refreshed repository-wide
results are recorded below.

## Central onboarding and deduplication verification

```powershell
node --import tsx --test `
  test/codex-central-setup.test.ts `
  test/codex-install.test.ts `
  test/otel-trace-aggregator.test.ts
```

The final 38-test selection passed. It covers the three append-only framework
lists, preselection and invalid-value filtering, Bash and PowerShell syntax,
local package detection, fixed asset allowlists, setup staging, Hook/OTel
install and rollback, and the deduplication contrast: generic OTel retains the
first duplicate snapshot while Codex preprocessing retains the latest completed
snapshot. The final production build and `git diff --check` also passed.

## Repository-wide test

Fresh databases and isolated user homes were used:

| Environment | Command | Result |
| --- | --- | --- |
| Windows | `npm test` | 737 tests: 685 passed, 39 failed, 13 skipped |
| openEuler SP4 | `npm test` | 737 tests: 724 passed, 12 failed, 1 skipped |
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
chain, persistent trust for 11 Hooks, a no-bypass real model run, exact native
OTel usage/TTFT, automatic Skill, MCP, a provider-backed SubAgent,
cross-machine relay/server persistence, recovery, reversible
uninstall/reinstall, 20-sample startup, 30+30 real TTFT, and short
app-server/relay RSS curves. VS Code, Cursor, and Windsurf each passed VSIX
lifecycle and real Extension Host FileEdit/Terminal checks. Details are
recorded in `test/codex-trace/reports/e2e.md`.
