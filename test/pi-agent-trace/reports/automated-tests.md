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

The Windows development result is not a substitute for the required
openEuler 24.03 LTS SP4 install, live inference, performance, or eight-hour
soak evidence.
