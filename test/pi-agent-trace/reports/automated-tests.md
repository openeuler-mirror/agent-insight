# Pi Agent collector automated verification

Date: 2026-07-27

Environment:

- OS: Windows development host
- Node.js: 24.17.0
- npm: 11.13.0
- Pi Agent: 0.82.1
- Formal openEuler 24.03 LTS SP4 validation: pending

Results:

| Check | Result |
| --- | --- |
| Collector, transport, Adapter, distribution target tests | 48 passed, 0 failed (30 Pi/transport + 18 related regressions) |
| Target ESLint | passed |
| CJS syntax checks | passed |
| `pi install` and `pi list` | passed |
| `pi --list-models` Extension load | passed; no model configured |
| `pi remove` then reinstall | passed; exactly one package entry |
| 20 cold-start baseline/installed samples | passed on Windows; median 985.57/987.43 ms, P95 1032.15/1040.97 ms |
| Shared transport equality with issue #159 branch | passed; SHA-256 `8EB1D524F09D7CB42C00511813E2341860661BBDC298A3FB9D9F47FC5E41F868` |

Repository-wide commands were also run against the final source:

| Command | Result |
| --- | --- |
| `npm test` | not clean: 689 tests, 632 passed, 44 failed, 13 skipped |
| `npm run lint` | not clean: 1,967 existing repository problems (1,679 errors, 288 warnings); the targeted Pi file set passed separately |
| `npm run build` | blocked before application compilation because `@next/swc-win32-x64-msvc` was not a valid Win32 application and the WASM fallback does not support `turbo.createProject` |

The full-suite failures include existing Prisma/database-state tests, ingestion
and lifecycle regressions outside this change, and Python-backed AgentDebug and
Hermes tests that invoke an unavailable `python3` command on Windows (exit
9009). The Windows development result is not a substitute for the required
openEuler 24.03 LTS SP4 install, live inference, performance, or eight-hour
soak evidence.
