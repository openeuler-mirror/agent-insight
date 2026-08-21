# DeepSeek Harness System Prompt Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve root and child DeepSeek Harness System Prompts in Trace nodes and prove the child path with a real Harness run.

**Architecture:** Normalize each source Session's `request/header.header.system` into the existing `role=system` interaction contract inside the Harness aggregator. Reuse the current Agent Tree and System Prompt UI; no client protocol or UI special case is added.

**Tech Stack:** TypeScript, Node test runner, Next.js, SQLite/Prisma, DeepSeek Harness `dsh`, OTLP JSON logs.

---

### Task 1: Root and child aggregation regression

**Files:**
- Modify: `test/deepseek-harness-otel-ingest.test.ts`
- Test: `test/deepseek-harness-otel-ingest.test.ts`

**Step 1: Write the failing tests**

Add a root test that inserts a `request/header` containing `system: 'Root Harness system prompt'` and asserts exactly one interaction with:

```ts
{
  role: 'system',
  agent: 'DeepSeek Harness',
  content: 'Root Harness system prompt',
  system_prompt_length: 26,
}
```

Add a parent/child test whose parent aggregate includes child `subagent/descriptor` plus repeated child `request/header` events. Assert exactly one child system interaction and that it contains `subagent_session_id: childSessionId` and `agent: 'Researcher'`.

**Step 2: Run the focused test to verify RED**

Run:

```bash
npx --yes --package node@22 node --import tsx --test --test-reporter=spec test/deepseek-harness-otel-ingest.test.ts
```

Expected: the new assertions fail because the aggregator currently skips `header.system`.

### Task 2: Minimal aggregator implementation

**Files:**
- Modify: `src/lib/ingest/deepseek-harness-otel/aggregator.ts:20-42`
- Modify: `src/lib/ingest/deepseek-harness-otel/aggregator.ts:226-234`
- Test: `test/deepseek-harness-otel-ingest.test.ts`

**Step 1: Extend the working interaction contract**

Allow `role: 'system'` and optional `system_prompt_length`.

**Step 2: Emit one prompt per source Session**

Before the event loop create `seenSystemPromptSources`. In the `request/header` branch, preserve the original non-empty string and append:

```ts
{
  role: 'system',
  content: systemPrompt,
  agent,
  ...(isSubagent ? { subagent_name: agent, subagent_session_id: source } : {}),
  system_prompt_length: systemPrompt.length,
  timeInfo: { created: event.eventTimestamp, completed: event.eventTimestamp },
  _orderMs: eventTimeMs(event),
  _sourceSessionId: source,
}
```

Keep model extraction unchanged. Mark a source as seen only after a non-empty prompt is emitted.

**Step 3: Run the focused test to verify GREEN**

Run the Task 1 command. Expected: all Harness ingest/aggregation tests pass.

### Task 3: Real Harness child-Agent acceptance

**Files:**
- Inspect: installed `dsh` profiles and tools
- Inspect: isolated server spool and SQLite database

**Step 1: Prepare an isolated live server**

Build/restart the existing isolated Agent Insight instance with the updated aggregator while retaining its test API key, spool and database paths.

**Step 2: Run a constrained Harness task**

Use a query that explicitly requires the main Agent to delegate a simple read-only command to a child Agent, forbids the main Agent from running that command, and requires reporting the child's marker.

**Step 3: Verify raw telemetry**

Require all of:

- a parent-side child-agent Tool call;
- `subagent/descriptor` with `session.parent_id`;
- a child `request/header.header.system`;
- child Tool result and child final response.

If the model does not delegate, strengthen the query and rerun; do not synthesize evidence.

**Step 4: Verify persisted Trace**

Query the isolated SQLite database and `/api/observe/session`. Require a root system interaction, a child system interaction with the real child Session id, and an Agent Tree child node whose System Prompt count is non-zero.

### Task 4: Regression and build verification

**Files:**
- Test: `test/deepseek-harness-otel-ingest.test.ts`
- Test: `test/deepseek-harness-plugin.test.ts`
- Test: `test/deepseek-harness-setup.test.ts`
- Test: `test/framework-adapter-registry.test.ts`

**Step 1: Run Harness regression tests**

Run the focused Harness and shared Trace tests with Node 22. Expected: zero failures.

**Step 2: Check the diff**

Run `git diff --check`. Expected: no output and exit 0.

**Step 3: Build production output**

Run `npx --yes --package node@22 --call 'npm run build'`. Expected: Next.js compilation, TypeScript, page generation and route listing complete with exit 0.

**Step 4: Record completion evidence**

Update the current-day work log only after the automated and live child-Agent acceptance both complete.
