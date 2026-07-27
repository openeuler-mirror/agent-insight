# Pi Agent Trace collector E2E evidence

Date: 2026-07-27

## Environment and scope

- OS: openEuler 24.03 LTS SP4, x86_64
- Node.js: 22.23.1
- Pi Agent: 0.82.1
- Source HEAD: `87c99c9afebfe6a51d965413fc9c71e5775d442a`
- Agent Insight storage: isolated SQLite database

No Pi provider credentials were available. Package lifecycle checks therefore
used the real Pi CLI, while Trace semantics used the collector's public
Extension-core interface with deterministic Pi-shaped events. This validates
the integration contract and server persistence, but is not a real model
inference claim.

## Package lifecycle

The following lifecycle was exercised against the source package:

```bash
pi install "$PWD/scripts/agent-trace-collectors/pi-agent"
pi list
pi --list-models
pi remove "$PWD/scripts/agent-trace-collectors/pi-agent"
pi install "$PWD/scripts/agent-trace-collectors/pi-agent"
```

Observed results:

- install, list, no-inference Extension load, remove, and reinstall passed;
- self-check passed before and after reinstall;
- ordinary uninstall retained the Pi spool;
- an unrelated Codex sentinel hash was unchanged;
- reinstall produced a new persisted root session.

## API Key isolation and scoped purge

A second isolated openEuler HOME exercised the managed package layout and the
real `uninstall.cjs --purge` entry. Two independently generated, non-secret
Agent Insight test keys wrote one event each through `DurableTraceWriter`.
Their SHA-256 namespace prefixes were `855f029e9c2d` and `569aecb5330f`.

The current-key package was installed with `pi install`, listed by `pi list`,
and passed its managed self-check before purge. After `--purge`:

- the current-key namespace no longer existed;
- the other-key namespace and its only spool file remained;
- the other spool SHA-256 remained
  `ad76faca4bdc1407ff804e24109a63267904096b7334fa5dc39b60ec7f865138`;
- an unrelated Codex sentinel remained byte-identical with SHA-256
  `f7645328669332c6e7154d83032cdc781c51b5c4273a7e8f636b5a280cd8093e`;
- the managed Pi package was removed and `pi list` reported no packages.

This verifies the filesystem and Pi settings effects of scoped purge without
using a provider credential or contacting an ingestion endpoint.

## Collector and persistence

The deterministic Extension-core fixture emitted Agent, Skill, LLM, Tool, MCP,
a three-level SubAgent chain, and five sibling SubAgents. Agent Insight
persisted one root plus eight child executions.

The primary root record contained:

- 32 tokens: 18 input, 14 output, 2 reasoning;
- 3 cache-read input tokens and 1 cache-creation input token;
- 16 maximum tokens in one LLM call and 9 LLM calls;
- 6 Tool calls with 1 error;
- `fixture-skill@3`;
- the root, three nested agents, and five sibling workers;
- final result `inspection complete`.

The final database contained three root sessions for the primary fixture,
failure recovery, and reinstall.

## Failure recovery

A local endpoint returned HTTP 500 for the first upload. The checkpoint hash
remained unchanged. After recovery, one event was uploaded; an immediate replay
uploaded zero events. This confirms checkpoint safety and replay idempotency for
the exercised batch.

## Performance samples

Twenty no-inference startup samples were collected for each state:

| State | Median | P95 |
| --- | ---: | ---: |
| Baseline | 529.952 ms | 549.756 ms |
| Collector installed | 534.719 ms | 552.462 ms |

The installed median was 4.767 ms higher. One Pi RPC process RSS sample was
164,600 KB. This is full-process RSS, not an isolated Extension memory delta or
a growth curve.

## Evidence integrity

The local structured evidence summary was stored at
`/root/agent-insight-e2e/evidence/issue-158-e2e/evidence-summary.json`.
Selected artifact hashes:

- collector driver: `8911da6be47d930bead745b9d6e24d18fa8be83c651ef9a85f1be908247054d6`
- database summary: `65c685a0c4f7d0cbc99dc67146b94565b4444051c37eae5d62877518ee596322`
- startup samples: `56b5e39b227c5fc8589cbf728fd27baecca905bc9461ea531ecddc5b08a66233`
- final summary: `07ff97c8a20a35f6d9fb214169ef7dd3584dcecffa67bc46614da5e7adbfc316`
- double-key managed purge result:
  `c21a3a6fc846a57dbcb4d3e04590ef95ab460342fcd8f352d0549aaec55e6f2f`

## Remaining gates

- real Pi provider/model inference and native usage comparison;
- real automatic Skill selection driven by a model;
- a provider-backed SubAgent/MCP extension run;
- 30-sample real TTFT comparison;
- isolated Extension RSS delta and memory growth curve;
- eight-hour soak.
