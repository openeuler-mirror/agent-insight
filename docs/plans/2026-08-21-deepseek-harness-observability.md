# DeepSeek Harness Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an authenticated, privacy-bounded DeepSeek Harness OTLP Logs integration that projects official Session Events into Agent Insight Trace, Skill, and evaluation data, then verify it with a real Harness task on macOS.

**Architecture:** Keep DeepSeek Harness as the execution owner and reuse its official Session Telemetry backend. A small Agent Insight dsh plugin package configures the exporter and transforms outbound records; the existing OTLP Logs endpoint branches raw Harness resources into a dedicated durable spool and deterministic aggregator before saving a canonical `ExecutionRecord`.

**Tech Stack:** Next.js App Router, TypeScript, Node test runner, OTLP/HTTP JSON Logs, filesystem JSONL spool, Cordis/dsh plugin package, shell installer.

---

### Task 1: Harness OTLP parsing, authentication, and spool

**Files:**
- Create: `test/deepseek-harness-otel-ingest.test.ts`
- Create: `src/lib/ingest/deepseek-harness-otel/types.ts`
- Create: `src/lib/ingest/deepseek-harness-otel/detect.ts`
- Create: `src/lib/ingest/deepseek-harness-otel/otlp-json.ts`
- Create: `src/lib/ingest/deepseek-harness-otel/spool.ts`
- Modify: `src/app/api/ingest/otel/v1/logs/route.ts`

**Steps:**
1. Write fixtures that use `service.name=deepseek-harness`, official scope names, `event.type`, `event.seq`, structured AnyValue bodies, and a temporary spool.
2. Run `node --import tsx --test test/deepseek-harness-otel-ingest.test.ts`; expect failures because the Harness modules do not exist.
3. Implement resource partitioning, structured-body decoding, nanosecond timestamps and per-session JSONL append/read.
4. Add strict Harness API-key handling and keep non-Harness behavior unchanged.
5. Re-run the focused test; expect all parser, partition, auth, isolation and dedupe assertions to pass.

### Task 2: Deterministic Session Event aggregation

**Files:**
- Modify: `test/deepseek-harness-otel-ingest.test.ts`
- Create: `src/lib/ingest/deepseek-harness-otel/aggregator.ts`
- Create: `src/lib/ingest/adapters/deepseek-harness.ts`
- Modify: `src/lib/ingest/adapters/registry.ts`
- Modify: `src/lib/ingest/otel-consumer/sources.ts`
- Modify: `src/lib/storage/data-service.ts`

**Steps:**
1. Add failing tests for user/assistant content, usage, Tool result pairing, Skill extraction, errors, parent metadata and framework capabilities.
2. Run the focused test and confirm failures are caused by the absent aggregator/adapter.
3. Implement ordered last-write dedupe and canonical interaction projection.
4. Register the framework and spool source; include Harness in the subagent-tree capability path.
5. Re-run the focused test and relevant consumer/adapter tests.

### Task 3: Privacy policy and installable dsh plugin

**Files:**
- Create: `scripts/agent-trace-collectors/deepseek-harness/package.json`
- Create: `scripts/agent-trace-collectors/deepseek-harness/index.js`
- Create: `scripts/agent-trace-collectors/deepseek-harness/cordis.patch.yml`
- Create: `test/deepseek-harness-plugin.test.ts`

**Steps:**
1. Write failing tests for recursive key redaction, value-pattern redaction, Unicode-safe truncation, integration attributes and secret-free config dumps.
2. Run `node --import tsx --test test/deepseek-harness-plugin.test.ts`; expect missing-file failures.
3. Implement a synchronous Cordis waterfall policy and the full replacement telemetry config.
4. Re-run tests and run `dsh --profile headless --dump-config` against an installed local plugin.

### Task 4: Dedicated setup API and documentation

**Files:**
- Create: `src/app/api/ingest/setup/deepseek-harness/files.ts`
- Create: `src/app/api/ingest/setup/deepseek-harness/assets/[asset]/route.ts`
- Create: `src/app/api/ingest/setup/deepseek-harness/route.ts`
- Create: `scripts/agent-trace-collectors/deepseek-harness/install.sh`
- Create: `test/deepseek-harness-setup.test.ts`
- Modify: `docs/user-guide/observability/view-traces.md`
- Modify: `docs/developer-guide/04-api-and-contracts.md`
- Modify: `docs/developer-guide/05-data-and-control-flow.md`

**Steps:**
1. Add failing route tests for deterministic source and per-file digests, placeholder replacement and API-key-safe generated shell.
2. Serve three allow-listed plugin files directly and implement an idempotent macOS/Linux installer for `headless` and `web` profiles without ZIP/`unzip`.
3. Document install, data content, auth, best-effort delivery and uninstall behavior.
4. Re-run setup and documentation contract tests.

### Task 5: Real macOS end-to-end validation

**Files:**
- No production files beyond Tasks 1–4.

**Steps:**
1. Install `@deepseek-ai/dsh@0.1.0-rc.8`, matching official master commit `141eb6f`.
2. Start Agent Insight through `scripts/develop_start.sh` with isolated test spool/database configuration.
3. Obtain a valid local Agent Insight API key without printing it, install the local plugin into the Harness `headless` profile, and verify composed config.
4. Run a real headless task that invokes one Skill and one Tool using an available DeepSeek credential.
5. Poll platform persistence until the Harness `session.id` becomes an Execution; verify framework, query, output, Tool, Skill and usage fields.
6. Run focused tests, relevant regressions, `npx tsc --noEmit`, `npm run build`, and report upstream baseline failures separately.
