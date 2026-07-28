# Pi Agent Trace collector E2E evidence

Date: 2026-07-28

## Environment and scope

- OS: openEuler 24.03 LTS SP4, x86_64
- Node.js: 22.23.1
- Pi Agent: 0.82.1
- Provider: TokenMP
- Model: MiniMax-M3
- Runtime evidence source: `cbc5372d9169864b997866b9b28cdb5f0d41fb16`
- Latest upstream rebase verification source:
  `87f4e6e7aa8484fcf2a3a205fd7e23a3402a2868`
- Agent Insight storage: isolated SQLite databases

The run combined real Pi package lifecycle checks, real provider-backed model
tasks, and deterministic public Extension-core fixtures. The real model tasks
cover base inference, automatic Skill selection, MCP, and one official
SubAgent-extension child. The deterministic fixture remains the evidence for
the exact three-level and five-sibling graph shapes.

## Central onboarding and package distribution

The installation page, central setup route, and central auto-setup route retain
the existing six frameworks in their original order and append `Pi Agent` as
the seventh choice. Framework preselection accepts only the server-side
allowlist; invalid values are discarded before either shell script is built.
The no-parameter path remains interactive.

The generated Bash and PowerShell scripts passed `bash -n` and the native
PowerShell parser. A Windows run used an isolated `USERPROFILE` and completed
central installation, self-check, scoped `--purge`, reinstall, a second
self-check, and final uninstall without changing the user's real Pi or editor
configuration.

The final local npm package was installed from, and remained backed by, this
unpublished tarball:

| Field | Value |
| --- | --- |
| Package | `agent-insight-0.5.4.tgz` |
| SHA-256 | `0a3a153afe5b99e5bcf77eaca21b68f3c1cff88a09bdebe818d25aa0347e055b` |
| Size | 80,977,077 bytes |
| Installed version | `0.5.4` |
| Packaged `scripts/install.js` SHA-256 | `51c42e5f81f8fb52582bb1b45adf4bf9e77cbc020dbb8177564443a1538f59e0` |

On openEuler, the installed package executed
`scripts/install.js -> /api/setup/auto -> Pi installer`, completed self-check,
and left the target configuration at mode `0600`. Installer output identified
the current local package, so the unpublished tarball was not replaced by an
npm registry copy.

The installation page was also checked at 1440x900 and 390x844 in Light and
Dark themes. Pi Agent remained last, selecting it added
`frameworks=pi-agent` to the Bash and PowerShell commands, horizontal overflow
was absent, and the browser console reported no errors or warnings.

## Cross-machine installation and persistence

The server and collector ran across two independent virtual-machine network
boundaries:

| Role | Environment | Address boundary |
| --- | --- | --- |
| Agent Insight server | VMware, openEuler 24.03 LTS-SP3 | VMnet8 `192.168.118.xxx:31880` |
| Pi collector | WSL2, openEuler 24.03 LTS-SP4 | WSL NAT `172.30.75.xxx` |

The collector host used Node.js 22.23.1 and Pi Agent 0.82.1. It downloaded the
central Bash installer from the server's non-loopback VMnet8 address, installed
Pi, completed self-check, ran a MiniMax-M3 task, and uploaded the resulting
Trace across the same address. The server returned a successful HTTP response
and its SQLite database contained the resulting execution:

| Field | Persisted value |
| --- | --- |
| Framework | `pi-agent` |
| User | `intern-pi-e2e` |
| Input / output / total tokens | 1,552 / 39 / 1,719 |
| Cache read / reasoning tokens | 128 / 28 |
| LLM calls | 1 |
| Session interactions | 2 |

The addresses above are intentionally masked after the routable network
boundary. API Keys and provider credentials are omitted.

## Package lifecycle

The following lifecycle was exercised against the source package:

```bash
pi install "$PWD/scripts/agent-trace-collectors/pi-agent"
pi list
pi --list-models
pi remove "$PWD/scripts/agent-trace-collectors/pi-agent"
pi install "$PWD/scripts/agent-trace-collectors/pi-agent"
```

Install, list, Extension load, remove, reinstall, and self-check passed.
Ordinary uninstall retained the Pi spool, an unrelated Codex sentinel hash was
unchanged, and reinstall produced a new persisted root session.

## API Key isolation and scoped purge

A second isolated openEuler HOME exercised the managed package layout and the
real `uninstall.cjs --purge` entry. Two independently generated, non-secret
Agent Insight test keys wrote one event each through `DurableTraceWriter`.
Their SHA-256 namespace prefixes were `855f029e9c2d` and `569aecb5330f`.

After purging the current key:

- the current-key namespace no longer existed;
- the other-key namespace and its only spool file remained;
- the other spool SHA-256 remained
  `ad76faca4bdc1407ff804e24109a63267904096b7334fa5dc39b60ec7f865138`;
- an unrelated Codex sentinel remained byte-identical with SHA-256
  `f7645328669332c6e7154d83032cdc781c51b5c4273a7e8f636b5a280cd8093e`;
- `pi list` reported no packages.

A post-run literal scan of both real-model spool files found zero occurrences
of the TokenMP provider key and zero occurrences of the Agent Insight API Key.

## Real model, Skill, MCP, and SubAgent

Four independent Pi model tasks were uploaded to Agent Insight. The structured
summary asserted all six checks as `true`: every execution persisted,
provider/model matched, native usage matched, automatic Skill was captured,
MCP was captured, and the SubAgent was captured.

### Base inference and native usage

Pi and the collector agreed exactly on all six native usage fields:

| Field | Pi | Collector |
| --- | ---: | ---: |
| input | 289 | 289 |
| output | 45 | 45 |
| cache read | 256 | 256 |
| cache write | 0 | 0 |
| reasoning | 34 | 34 |
| total | 590 | 590 |

The persisted record used provider `tokenmp`, model `MiniMax-M3`, one LLM call,
and the expected final response.

### Automatic Skill

A neutral orbital-code prompt caused the model to read
`skills/zephyr-checksum/SKILL.md`. The collector emitted Agent, LLM, Skill, and
Tool events and the database recorded `zephyr-checksum` as an invoked Skill.
The model returned the checksum defined by that Skill.

### MCP

The model called the real extension tool `mcp__fixture__lookup` for `K-42`.
The collector mapped it to MCP server `fixture`, tool `lookup`, and Agent
Insight persisted the MCP call and returned catalog value.

### SubAgent

Pi's official SubAgent example launched an independent Pi child process through
the `subagent` tool. The child used model `tokenmp/MiniMax-M3`, returned
`CHILD_TOKENMP_OK`, and reported 4,252 native tokens. The parent execution
persisted one successful child, three LLM calls, and one SubAgent Tool call.

## Deterministic graph and failure recovery

The public Extension-core fixture emitted Agent, Skill, LLM, Tool, MCP, a
three-level SubAgent chain, and five sibling SubAgents. Agent Insight persisted
one root plus eight child executions. The primary root contained 32 tokens,
9 LLM calls, 6 Tool calls with 1 error, and `fixture-skill@3`.

A local endpoint returned HTTP 500 for the first upload. The checkpoint hash
remained unchanged. After recovery, one event was uploaded; an immediate replay
uploaded zero events.

## Performance

Twenty no-inference startup samples were collected for each state:

| State | Median | P95 |
| --- | ---: | ---: |
| Baseline | 529.952 ms | 549.756 ms |
| Collector installed | 534.719 ms | 552.462 ms |

The installed startup median was 4.767 ms higher.

Thirty real MiniMax-M3 TTFT samples were then collected for each alternating
state. The harness records the first text delta but waits for each Pi child to
exit before starting the next sample.

| State | Median | P95 |
| --- | ---: | ---: |
| Baseline | 2,271.518 ms | 6,909.425 ms |
| Collector installed | 2,326.948 ms | 3,070.352 ms |

The installed median was 55.431 ms higher. The baseline P95 contains provider
long-tail samples; the lower installed P95 is not interpreted as a collector
speedup.

For a short matched-process RSS curve, baseline and installed Pi RPC processes
ran the same offline, no-inference workload for 61.2 seconds each at 5-second
intervals. Two startup points were retained in raw evidence but excluded from
the steady-state summary:

| State | Samples | Median RSS | P95 RSS | Steady growth |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 11 | 120,508 KB | 120,508 KB | 0 KB |
| Collector installed | 11 | 122,332 KB | 122,332 KB | 0 KB |
| Installed minus baseline | 11 | 1,824 KB | 1,824 KB | 0 KB |

This is a controlled full-process RSS differential.

## Evidence integrity

Local structured evidence is stored under
`/root/agent-insight-e2e/evidence/issue-158-real-model/`.
Selected SHA-256 values:

- real-model summary:
  `f0ea7d11c685945dbf5f2f2c535ad547226aa3bae1474200e63adfa5e03c0dcf`
- 30+30 real TTFT:
  `ce3505922338bf338017170368d3437b71c92d2d1174c751b3c2f5d769cf93b9`
- short RSS differential:
  `71a7d870f6c8850c816484ea7232ac244a735aae928473d3e8a308edc3cd3f87`
- deterministic E2E final summary:
  `07ff97c8a20a35f6d9fb214169ef7dd3584dcecffa67bc46614da5e7adbfc316`
- double-key managed purge result:
  `c21a3a6fc846a57dbcb4d3e04590ef95ab460342fcd8f352d0549aaec55e6f2f`
