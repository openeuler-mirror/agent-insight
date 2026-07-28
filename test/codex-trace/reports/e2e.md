# Codex Trace collector E2E evidence

Date: 2026-07-28

## Environment and evidence boundary

- OS: openEuler 24.03 LTS SP4, x86_64
- Node.js: 22.23.1
- Codex CLI: 0.145.0
- Model authentication: ChatGPT
- Model: `gpt-5.6-sol`
- Runtime evidence source: `c63864fa5d99c8abe9aeb19935e09143d24583b6`
- Latest upstream rebase verification source:
  `21c8f02d3d7798d19e7667a92fede585dc79a4ce`
- Agent Insight storage: isolated SQLite database

The openEuler run used the real Codex executable, model, Hook runtime, native
OTel exporter, relay, uploader, and Agent Insight service. Raw evidence remains
local; this report records only non-secret facts and SHA-256 digests.

## Central onboarding and package distribution

The installation page, central setup route, and central auto-setup route retain
the existing six frameworks in their original order and append `Codex` as the
seventh choice. Framework preselection accepts only the server-side allowlist;
invalid values are discarded before either shell script is built. The
no-parameter path remains interactive.

The generated Bash and PowerShell scripts passed `bash -n` and the native
PowerShell parser. A Windows run used an isolated `USERPROFILE`, a temporary
Codex CLI 0.145.0, and completed central installation, registration of all 11
Hooks, relay startup, self-check, uninstall, reinstall, a second self-check,
and final uninstall. The isolated relay and managed configuration were removed,
and the user's real Codex and editor configuration was not changed.

The final local npm package was installed from, and remained backed by, this
unpublished tarball:

| Field | Value |
| --- | --- |
| Package | `agent-insight-0.5.4.tgz` |
| SHA-256 | `901135d0737d4ccbbf2644b1c3f002b46705c7b34ab020a5f82402bd068b8222` |
| Size | 80,720,804 bytes |
| Installed version | `0.5.4` |
| Packaged `scripts/install.js` SHA-256 | `51c42e5f81f8fb52582bb1b45adf4bf9e77cbc020dbb8177564443a1538f59e0` |

On openEuler, the installed package executed
`scripts/install.js -> /api/setup/auto -> Codex installer`, completed self-check,
and left the target configuration, Hook trust data, and Codex config at mode
`0600`. Installer output identified the current local package, so the
unpublished tarball was not replaced by an npm registry copy.

The installation page was also checked at 1440x900 and 390x844 in Light and
Dark themes. Codex remained last, selecting it added `frameworks=codex` to the
Bash and PowerShell commands, horizontal overflow was absent, and the browser
console reported no errors or warnings.

## Cross-machine installation and persistence

The server and collector ran across two independent virtual-machine network
boundaries:

| Role | Environment | Address boundary |
| --- | --- | --- |
| Agent Insight server | VMware, openEuler 24.03 LTS-SP3 | VMnet8 `192.168.118.xxx:31881` |
| Codex collector | WSL2, openEuler 24.03 LTS-SP4 | WSL NAT `172.30.75.xxx` |

The collector host used Node.js 22.23.1 and Codex CLI 0.145.0. It downloaded
the central Bash installer from the server's non-loopback VMnet8 address,
installed Codex Trace, completed self-check, ran a real `gpt-5.6-sol` task, and
uploaded the resulting Trace across the same address. The server returned a
successful HTTP response and its SQLite database contained the resulting
execution:

| Field | Persisted value |
| --- | --- |
| Framework | `codex` |
| User | `intern-codex-e2e` |
| Model | `gpt-5.6-sol` |
| Input / output / total tokens | 14,773 / 12 / 14,785 |
| LLM calls | 1 |
| Session interactions | 2 |
| Thread | `019fa6f5-f0ad-7271-af82-78dbf845e212` |

The addresses above are intentionally masked after the routable network
boundary. API Keys and authentication material are omitted.

## Installation, persistent Hook trust, and uninstall

One-click installation, self-check, and exact registration of all 11 supported
Hook event types passed. Codex 0.145.0 presented its native Hook review screen.
A PTY recording selected `Trust all and continue`, after reviewing the exact
Agent Insight handler paths, and persisted trust for all 11 handler hashes.

A subsequent model run did not use `--dangerously-bypass-hook-trust`:

- session: `019fa48d-0391-7dc3-9242-6a8fc855dfc4`
- result: `TRUSTED_HOOKS_REAL_MODEL_OK`
- model: `gpt-5.6-sol`
- usage: 15,591 input, 13 output, 13,056 cached input, 15,604 total
- native TTFT: 2,084 ms
- persisted Agent Insight record: 1 LLM call, 0 Tool calls, 14,641 ms latency

Its stdout contained no trust-bypass or untrusted-Hook warning.

An isolated lifecycle run then added an unrelated MCP table after the managed
OTel section, uninstalled the collector, reinstalled it, ran self-check, and
uninstalled it again. Both uninstalls removed exactly 11 Hook handlers and the
managed OTel section while preserving the MCP table. Reinstall reported
`ok: true`, 11 trusted handlers with matching hashes, and a connected relay.

## Real model telemetry

Four earlier independent model tasks exercised base inference, automatic Skill,
MCP, and a provider-backed SubAgent. These automation runs used
`--dangerously-bypass-hook-trust` only after the local handler source was
reviewed and before persistent trust was established. They are valid model,
OTel, relay, and persistence evidence, but are not presented as trust evidence.

The structured summary asserted all nine checks as true: every execution
persisted, provider/model matched, native usage and TTFT matched, automatic
Skill, MCP, and SubAgent were captured, sensitive raw attributes were redacted,
and credentials were absent from raw spool files.

### Base inference

The native JSONL, raw OTel, collector events, and database agreed on:

- 15,591 input, 12 output, and 15,603 total tokens;
- TTFT 2,082 ms;
- provider `openai`, model `gpt-5.6-sol`;
- result `CODEX_COLLECTOR_REAL_MODEL_OK`.

### Automatic Skill

A neutral orbital-code request caused the model to read
`skills/zephyr-checksum/SKILL.md`. Agent Insight persisted
`zephyr-checksum`, its file-read Tool, two LLM calls, 31,578 tokens, and the
Skill-defined result.

### MCP

The model invoked the real MCP server/tool `fixture/lookup` for `K-42`.
The collector normalized the native MCP name, persisted one successful MCP
interaction, three LLM calls, 51,565 tokens, and the catalog result.

### SubAgent

The real Codex collaboration tool started one child Agent. The collector
persisted the shared child ID, parent `root`, result `CHILD_CODEX_OK`, three LLM
calls, two Tools, and 47,191 tokens.

## Deterministic merge, persistence, and recovery

A separate public-interface sequence covered all 11 Hook event types, native
OTel log shapes, IDE input, Agent, SubAgent, explicit Skill, LLM, Bash, MCP,
FileEdit, and one Tool error. Agent Insight persisted the root and child.

The representative root contained 150 tokens, 125 ms TTFT, one LLM call, three
Tools with one error, Skill `openEuler-check`, and child `reviewer`.

A local endpoint returned HTTP 500 for the first upload. The checkpoint did not
advance. Recovery uploaded two events, and immediate replay uploaded zero.
Raw OTel is redacted before durable append; test and real spool scans found no
provider credential, Agent Insight key, email, or account identifier.

## Performance

Twenty no-inference CLI startup samples were collected for each state:

| State | Median | P95 |
| --- | ---: | ---: |
| Baseline | 39.906 ms | 42.181 ms |
| Collector installed | 39.777 ms | 43.007 ms |

The -0.129 ms median difference is measurement noise, not a speedup.

Thirty real model TTFT samples were then run for each alternating state with
the same ChatGPT account, model, read-only sandbox, disabled apps/plugins, empty
MCP configuration, and prompt. The harness records first assistant output and
waits for every Codex child to exit successfully before continuing.

| State | Median | P95 | Min | Max |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 11,527.988 ms | 16,123.768 ms | 9,632.954 ms | 68,085.443 ms |
| Collector installed | 11,978.893 ms | 15,875.691 ms | 9,959.050 ms | 19,340.632 ms |

The installed median was 450.905 ms higher. The baseline maximum is an upstream
model/network long-tail sample and remains in the raw evidence. All 30 installed
sessions produced one persisted `gpt-5.6-sol` Execution and one LLM call.

Matched Codex app-server processes were sampled for 61 seconds at five-second
intervals. A long-running relay was sampled concurrently for 121 seconds:

| Process | Samples | Median RSS | P95 RSS | Growth |
| --- | ---: | ---: | ---: | ---: |
| Baseline app-server | 13 | 47,872 KB | 47,872 KB | 0 KB |
| Installed app-server | 13 | 47,872 KB | 47,872 KB | 0 KB |
| Long-running relay | 25 | 72,528 KB | 72,528 KB | 0 KB |

The matched app-server median and P95 deltas were both 0 KB.

## VS Code, Cursor, and Windsurf

The dependency-free builder produced a 19,062-byte VSIX containing only the
five required archive entries. The same VSIX completed install, version list,
uninstall, zero-match verification, and reinstall in all three products.
Each product finished with one
`openeuler.agent-insight-codex-trace@0.1.0` installation.

| Product | Product/engine version | Extension Host result |
| --- | --- | --- |
| VS Code | 1.130.0 x64 | activation, 5 commands, 7 Settings, FileEdit, Terminal passed |
| Cursor | 3.12.17 CLI / VS Code API 1.128.0 | activation, 5 commands, 7 Settings, FileEdit, Terminal passed |
| Windsurf | 2.3.15 product / VS Code API 1.110.1 | activation, 5 commands, 7 Settings, FileEdit, Terminal passed |

Each isolated Extension Host used its own HOME, user-data, extensions,
workspace, result, relay, and spool. Cursor and Windsurf used the committed
product bridge before loading the shared Extension Host test. In all three:

- a real workspace edit emitted `tool.FileEdit`;
- a real shell-integrated command emitted `tool.Terminal` with exit code 0;
- both events belonged to the active IDE-originated turn;
- extension activation and the public Terminal Shell Execution APIs passed.

Windows UI Automation found `workbench.parts.statusbar` and status item
`openeuler.agent-insight-codex-trace` with label and tooltip
`Codex Trace, Connected; waiting for a Codex IDE turn`. This confirms the real
connected/idle status item. The available raster capture is obscured by a
first-run modal, so it is not used as the status-bar assertion.

The official VS Code extension `openai.chatgpt@26.721.41059` was also present.
Its bundled Codex CLI `0.146.0-alpha.3.1` reported `Logged in using ChatGPT`
and completed a real read-only model request using the same IDE runtime:

- session: `019fa4b3-b68e-72f2-aa7c-ad3a631a0b53`
- result: `IDE_BUNDLED_LOGIN_OK`
- usage: 20,983 input, 10 output, 7,936 cached input

This proves the installed IDE runtime's login and model path without reading
account storage.

## Evidence integrity

Selected local SHA-256 values:

- deterministic E2E summary:
  `9804e0f675023ae8efb3f15a2cd320358e2ba397e8055d1de37e382c3acd6b12`
- real-model four-scenario summary:
  `087245c61cfdf8eed9dc71b1a491ddc7dd69031a602d33158475321763aca6f7`
- persistent Hook trust PTY:
  `bdfe9344a280baa0b542c5234a5da890b97ae9c21635a8f2518569574e3d6c13`
- no-bypass trusted model JSONL:
  `c6c0530a2fba2eb0e60c17cdfb9faae151b284972c9e5ceada9d04b53cb4d182`
- uninstall/MCP lifecycle:
  `cf8270a7111bd3d393646db11cc703ab5aefaaf47a180daa49881be57dbe9e86`
- 30+30 TTFT:
  `d91acbef933f5184c71d27625168560cb7ae7c7ff3d7daac30479c966ee689df`
- short RSS curves:
  `dafc8e8866f51ea2a03d01d55011deb6b54a007c749bfbd2bb196d4ad90a2c14`
- VSIX:
  `983b496e098245ad7eb119118317796920e0d65fb8166a894a7e49468bc740f7`
- VS Code result/canonical spool:
  `73cd00ea171aef497dbab9da704d70d1022782de90af2bf72b20e2511fd8eeaa` /
  `a3235209da758990c57a874233d1580f39e3c847cb3cf77a4b498fa2e4cd3865`
- Cursor result/canonical spool:
  `eb03d64df41e7cef1ab7d8f405c31ead7e54694bb700c7e18dbaf174ce945160` /
  `f1198d0d0111fe542962db52c16433b6676ead459e43cfa5fc87766dee4047f9`
- Windsurf result/canonical spool:
  `120f73c79b9a054a55e0b1c49cf85eade4c05bfec3d5e0859321f96a14ea208a` /
  `c13eeef490b5c59af169c6b3251564486a638784fc36ad89032cef0e1c51e14a`
- IDE bundled runtime native session:
  `e2e39c8ae1be69ba204a492e9b31610e93f92967fad2d1d63b4c4181eded0ad8`
