# DeepSeek Harness Zip-Free Plugin Install Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the DeepSeek Harness observability ZIP Bundle with three allow-listed, hash-verified file downloads so client installation no longer requires `unzip`.

**Architecture:** The setup route will build a deterministic manifest from the three plugin source files and inject the combined digest plus per-file SHA-256 values into the existing shell installer. A new allow-listed asset route will serve only those files. The installer will stage and verify every file before registering the plugin with the existing DSH profile flow.

**Tech Stack:** Next.js App Router, TypeScript, Node.js test runner, POSIX shell, DeepSeek Harness Cordis plugins.

---

### Task 1: Specify the zip-free server contract

**Files:**
- Modify: `test/deepseek-harness-setup.test.ts`

**Step 1: Write the failing manifest and asset-route tests**

Require the manifest to expose exactly `package.json`, `index.js`, and `cordis.patch.yml`, each with source content, MIME type, and SHA-256. Require the asset route to return each valid file with `X-Agent-Insight-SHA256`, and return 404 for an unknown name.

**Step 2: Write the failing installer-response assertions**

Require the generated installer to contain the three asset URLs and expected hashes, and to contain neither `.zip`, `unzip`, nor `/bundle`.

**Step 3: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test test/deepseek-harness-setup.test.ts
```

Expected: FAIL because the manifest/asset route does not exist and the installer still references ZIP.

### Task 2: Implement the allow-listed plugin sources

**Files:**
- Create: `src/app/api/ingest/setup/deepseek-harness/files.ts`
- Create: `src/app/api/ingest/setup/deepseek-harness/assets/[asset]/route.ts`
- Delete: `src/app/api/ingest/setup/deepseek-harness/bundle.ts`
- Delete: `src/app/api/ingest/setup/deepseek-harness/bundle/route.ts`
- Modify: `src/app/api/ingest/setup/deepseek-harness/route.ts`

**Step 1: Add the deterministic manifest**

Read only the three fixed regular, non-symbolic-link source files. Compute a SHA-256 for each file and a combined source digest over file name plus bytes.

**Step 2: Add the allow-listed asset route**

Return the selected source bytes with the corresponding MIME type, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `X-Agent-Insight-SHA256`. Reject any non-allow-listed asset with 404.

**Step 3: Inject the manifest into the installer route**

Replace the ZIP digest placeholder with the combined source digest and three per-file digest placeholders.

**Step 4: Run the focused test**

Run the Task 1 command. Expected: server contract assertions pass; installer assertions remain RED until Task 3.

### Task 3: Replace ZIP extraction with staged file downloads

**Files:**
- Modify: `scripts/agent-trace-collectors/deepseek-harness/install.sh`
- Modify: `test/deepseek-harness-setup.test.ts`

**Step 1: Remove the ZIP-specific installer flow**

Delete the `unzip` prerequisite, Bundle URL, ZIP path, ZIP checksum, extraction, and archive completeness checks.

**Step 2: Add a hash-verifying download function**

Download each fixed asset into `$STAGE_DIR/deepseek-harness/<name>`, compute SHA-256 with the already-required Node.js runtime, compare it with the injected expected digest, and fail before plugin registration on any mismatch.

**Step 3: Preserve activation behavior**

Use the combined source digest as the version directory, copy the verified staged directory, persist `~/.dsh/.env`, and register/dump both profiles exactly as before.

**Step 4: Run the focused setup tests and Bash syntax check**

```bash
node --import tsx --test test/deepseek-harness-setup.test.ts test/deepseek-harness-unified-setup.test.ts
bash -n scripts/agent-trace-collectors/deepseek-harness/install.sh
```

Expected: all tests pass and Bash exits 0.

### Task 4: Update installation documentation

**Files:**
- Modify: `docs/user-guide/observability/view-traces.md`
- Modify: `docs/developer-guide/04-api-and-contracts.md`
- Modify if referenced: `docs/developer-guide/05-data-and-control-flow.md`

**Step 1: Remove ZIP and `unzip` statements**

Document the three allow-listed downloads, per-file verification, staged activation, and unchanged DSH profile behavior.

**Step 2: Search for stale Harness Bundle references**

```bash
rg -n "deepseek-harness.*bundle|Harness.*ZIP|unzip" docs scripts src test
```

Expected: no active DeepSeek Harness installation contract references ZIP or `unzip`.

### Task 5: Verify runtime installation and ingestion

**Files:**
- Test only; no production file changes expected.

**Step 1: Run all focused Harness tests**

```bash
node --import tsx --test \
  test/deepseek-harness-plugin.test.ts \
  test/deepseek-harness-setup.test.ts \
  test/deepseek-harness-unified-setup.test.ts \
  test/deepseek-harness-otel-ingest.test.ts
```

Expected: 19 or more tests pass, zero fail.

**Step 2: Run type checking or the repository test command**

```bash
npx tsc --noEmit
npm test
```

Expected: zero newly introduced failures; any pre-existing failure must be reproduced and attributed separately.

**Step 3: Exercise the generated installer in an isolated HOME/DSH_HOME**

Use the running local Agent Insight instance, a valid API Key passed only through the installer environment, and the installed DSH executable. Confirm the three files exist, no ZIP is created, `.env` is mode 0600, and both profile configs dump successfully.

**Step 4: Run one DSH smoke task without runtime Agent Insight variables**

Unset `AGENT_INSIGHT_API_KEY` and `AGENT_INSIGHT_BASE_URL`, provide only the existing model credential, run a uniquely marked task, and verify a new `framework=deepseek-harness` Execution plus Trace page.

### Task 6: Commit the implementation

**Files:**
- Stage only files changed by this plan.

**Step 1: Review the scoped diff**

```bash
git diff -- scripts/agent-trace-collectors/deepseek-harness \
  src/app/api/ingest/setup/deepseek-harness \
  test/deepseek-harness-setup.test.ts \
  test/deepseek-harness-unified-setup.test.ts \
  docs/user-guide/observability/view-traces.md \
  docs/developer-guide/04-api-and-contracts.md
```

**Step 2: Commit only the zip-free implementation**

```bash
git add <scoped files>
git commit -m "refactor: remove Harness plugin zip dependency"
```
