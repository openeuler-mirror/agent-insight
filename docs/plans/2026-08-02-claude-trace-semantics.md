# Claude Trace Semantics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修正 Claude Code 跨机 Trace 的内部调用、query、system prompt 和子 Agent 归属，并避免高频 hook 重复拉起 worker。

**Architecture:** 保留 Claude 官方 OTel 为主数据源，补传器只增加无法跨机获得的正文与归属元数据。所有语义修正在 Claude uploader、Claude context contract 和 Claude aggregator 内完成；通用建树器和其它 framework 的输入不变。

**Tech Stack:** Node.js CommonJS hook、TypeScript、Next.js route、Node test runner、Prisma/SQLite。

---

### Task 1: 过滤内部 raw body 并标注子 Agent system prompt

**Files:**
- Modify: `test/claude-context-uploader.test.ts`
- Modify: `scripts/claude_context_uploader.js`

**Step 1: Write the failing tests**

- 构造 `generate_session_title` raw request，断言 `collectSystemPrompts` 不返回它。
- 构造 root + 两个 `cc_is_subagent=true` request、主 transcript Agent tool_use 和两个 meta，断言 root item 无 `toolUseId`，两个 child item 分别带真实 `toolUseId/agentType`。
- 覆盖 prompt 精确匹配和 mtime 有界兜底；无可靠匹配的 child prompt 不挂 root。

**Step 2: Run tests to verify RED**

Run: `npx tsx --test --test-name-pattern='system prompt.*归属|内部标题' test/claude-context-uploader.test.ts`

Expected: FAIL，因为当前 collector 会上传标题提示词，且 system item 没有 child scope。

**Step 3: Implement the minimal collector changes**

- 从 Agent/Task `tool_use` 收集 `toolUseId/prompt`。
- 从 subagent meta 收集 `toolUseId/agentType/mtime`。
- 检测内部标题 raw body并跳过。
- 子 Agent request 优先按任务 prompt 匹配，mtime 仅作有界兜底。
- 将 `toolUseId/agentType` 写入 child `system_prompt` item。

**Step 4: Run tests to verify GREEN**

Run: `npx tsx --test test/claude-context-uploader.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add scripts/claude_context_uploader.js test/claude-context-uploader.test.ts
git commit -m "fix: 补齐 Claude system prompt 归属"
```

### Task 2: 过滤内部 assistant response 并按 scope 聚合

**Files:**
- Modify: `test/claude-context-supplement.test.ts`
- Modify: `test/claude-otel-ingest.test.ts`
- Modify: `src/lib/ingest/claude-otel/context-supplement.ts`
- Modify: `src/lib/ingest/claude-otel/aggregator.ts`

**Step 1: Write the failing tests**

- 依次输入 `generate_session_title`、`prompt_suggestion`、`prompt_suggestion_generate`、`away_summary`、`agent_summary` 的 assistant_response，断言全部不进入 interactions/finalResult。
- 输入 root prompt、两个带不同 `toolUseId` 的 child prompt 和 subagent_map，断言 root/child system prompt 分别落到三个 scope。
- 断言 subagent_map 的 `agentType=general-purpose` 回填父 task arguments，`buildAgentCallTree` 得到两个 child，task 均有 `spawnedChildId`。
- 保留一个普通 assistant_response 断言，证明过滤没有扩大。

**Step 2: Run tests to verify RED**

Run: `npx tsx --test test/claude-context-supplement.test.ts test/claude-otel-ingest.test.ts`

Expected: FAIL，当前内部 response 被输出、system prompt 全落 root、task 类型仍为 `agent`。

**Step 3: Implement the minimal aggregator changes**

- context contract 将 system item 的可选 `toolUseId/agentType` 写入事件 attributes。
- 内部 query source 在进入 assistant fallback 前统一跳过。
- supplement system state 拆成 root 和 `toolUseId` 两类。
- mapped subagent turn 创建前发射其专属 system interaction。
- 构造/合并父 task 时用 subagent_map 的真实 `agentType` 回填参数。

**Step 4: Run tests to verify GREEN**

Run: `npx tsx --test test/claude-context-supplement.test.ts test/claude-otel-ingest.test.ts test/claude-subagent-map-e2e.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/lib/ingest/claude-otel test/claude-context-supplement.test.ts test/claude-otel-ingest.test.ts
git commit -m "fix: 还原 Claude 内部调用与子 Agent 语义"
```

### Task 3: 修正 Claude 占位 query 并启用既有 child Execution

**Files:**
- Modify: `test/ingest-query-refresh.test.ts`（若无该文件，则在现有 data-service 相关测试中新增用例）
- Modify: `test/claude-subagent-map-e2e.test.ts`
- Modify: `src/lib/storage/data-service.ts`

**Step 1: Write the failing tests**

- `Claude Code Session <UUID>` + framework `claudecode` 返回可刷新。
- 任意真实 Claude query、其它 framework 的相似字符串均不可刷新。
- 保存 claudecode root interactions 后派生两个 `isSubagent=true` child，并保留 parent/root 链接。

**Step 2: Run tests to verify RED**

Run: `npx tsx --test --test-name-pattern='Claude.*query|claudecode.*子 Agent' test/**/*.test.ts`

Expected: FAIL，当前 placeholder detector 不识别 UUID，framework 集合不含 claudecode。

**Step 3: Implement the minimal storage changes**

- 只对 `claudecode` 识别 `^Claude Code Session <id>$`。
- 仅将 `claudecode` 加入 `SUBAGENT_TREE_FRAMEWORKS`。

**Step 4: Run tests to verify GREEN**

Run: `npx tsx --test test/claude-subagent-map-e2e.test.ts test/session-interactions-merge.test.ts test/otel-trace-aggregator.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/lib/storage/data-service.ts test
git commit -m "fix: 刷新 Claude query 并派生子 Agent"
```

### Task 4: 高频 hook 单 worker 启动保护

**Files:**
- Modify: `test/claude-context-uploader.test.ts`
- Modify: `scripts/claude_context_uploader.js`

**Step 1: Write the failing tests**

- 300 次 burst enqueue 只调用一次 `spawnWorker`，但仍产生每个 Session 的最新 queue job。
- worker 完成并释放令牌后，新 enqueue 可再次 spawn。
- 超时启动令牌可恢复；新鲜令牌不可抢占。
- spawn 失败释放令牌，下一次 hook 能重试。

**Step 2: Run tests to verify RED**

Run: `npx tsx --test --test-name-pattern='worker 启动|burst' test/claude-context-uploader.test.ts`

Expected: FAIL，当前每次 enqueue 都 spawn。

**Step 3: Implement the minimal worker token**

- 原子创建 `.worker-starting` 令牌。
- 只有令牌持有者 spawn；失败立即释放。
- `drainQueue` finally 释放并在竞态新任务存在时重新调度。
- 令牌超时后恢复，不删除 queue job。

**Step 4: Run tests to verify GREEN**

Run: `npx tsx --test test/claude-context-uploader.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add scripts/claude_context_uploader.js test/claude-context-uploader.test.ts
git commit -m "perf: 合并 Claude 高频补传 worker"
```

### Task 5: 文档、全量验证和 119 端到端

**Files:**
- Modify: `docs/user-guide/observability/view-traces.md`
- Modify: `docs/developer-guide/05-data-and-control-flow.md`
- Modify: `docs/developer-guide/INDEX.md`

**Step 1: Update affected guides**

- 说明 Claude 内部辅助调用不进入业务 Trace。
- 说明 system prompt 按 root/child scope 展示和补传器仅用于 Claude。
- 记录高频 hook 合并与 30 完整 Session/s 的容量边界。

**Step 2: Run focused verification**

Run:

```bash
npx tsx --test test/claude-context-uploader.test.ts test/claude-context-supplement.test.ts test/claude-context-e2e.test.ts test/claude-subagent-map-e2e.test.ts test/claude-otel-ingest.test.ts
npx tsc --noEmit
node --check scripts/claude_context_uploader.js
git diff --check
```

Expected: 全部 PASS。

**Step 3: Run full regression**

Run: `npm run test`

Expected: 0 failures；仅允许仓库既有的外部 API Key 条件跳过。

**Step 4: Run live E2E on 119**

- 在测试 Claude 会话中产生两条真实 user 任务、两个子 Agent、prompt suggestion 和 away summary。
- Claude 进程不 `/exit` 时确认数据已可见。
- 断言 query 为首条真实 user 输入；内部调用正文均不存在；root 有一个 system prompt；两个 child 各有自己的 system prompt；task 均由 child 认领。
- 记录补传 queue、HTTP 延迟和消费完成时间，不修改正式 consumer 并发参数。

**Step 5: Commit docs and verification metadata**

```bash
git add docs
git commit -m "docs: 更新 Claude Trace 补传说明"
```

**Step 6: Refresh MR branch and verify remote state**

```bash
git push upstream HEAD:refs/heads/feat/claude-context-supplement
```

通过 AtomGit OpenAPI确认 MR !244 最新 head、`conflict_passed` 和 CI 状态，不修改 WIP/审批/合并状态。
