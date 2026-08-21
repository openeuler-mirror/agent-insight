# DeepSeek Harness Unified Client Install Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add DeepSeek Harness to every unified Agent Insight client-install path while reusing the existing verified Harness installer.

**Architecture:** The UI and both setup generators accept one canonical `deepseek-harness` value. Unix generators delegate installation to `/api/ingest/setup/deepseek-harness`; PowerShell recognizes the selection and emits an explicit WSL/macOS/Linux support boundary.

**Tech Stack:** Next.js App Router, React, generated Bash/PowerShell, Node test runner, TypeScript.

---

### Task 1: Add failing unified-install contracts

**Files:**
- Create: `test/deepseek-harness-unified-setup.test.ts`

**Steps:**

1. Assert the install page and both setup routes declare `deepseek-harness`.
2. Request Unix and Windows setup scripts with only that framework selected.
3. Assert Unix delegates to the dedicated installer with base URL and API Key in the child environment.
4. Assert Windows reports the unsupported boundary and does not claim Harness installation success.
5. Run `npx --yes --package node@22 node --import tsx --test test/deepseek-harness-unified-setup.test.ts` and verify failure because the framework is absent.

### Task 2: Implement the normal setup path

**Files:**
- Modify: `src/app/(main)/accessconfig/install/page.tsx`
- Modify: `src/app/api/ingest/setup/route.ts`

**Steps:**

1. Add the framework to the page and route allowlists and interactive selector.
2. Add Bash and PowerShell selection flags.
3. Delegate the Bash install to `/api/ingest/setup/deepseek-harness` and track success.
4. Add success-only summary/next-step output on Unix and an explicit unsupported message on Windows.
5. Run the focused contract and keep iterating until the normal path passes.

### Task 3: Implement the auto setup path

**Files:**
- Modify: `src/app/api/ingest/setup/auto/route.ts`

**Steps:**

1. Mirror the allowlist, selector and flag changes from normal setup.
2. Delegate Unix installation to the same dedicated endpoint.
3. Add the same Windows boundary and success-only summary.
4. Run the focused contract and relevant setup tests.

### Task 4: Verify the product path

**Files:**
- Test: `test/deepseek-harness-unified-setup.test.ts`
- Test: `test/deepseek-harness-setup.test.ts`
- Test: `test/ingest-endpoint-contract.test.ts`

**Steps:**

1. Run all DeepSeek Harness tests and relevant setup regressions.
2. Run `git diff --check`.
3. Run the Node 22 Next.js production build.
4. Inspect the generated install page command and generated scripts for both platform paths.

