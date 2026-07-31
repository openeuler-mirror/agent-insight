# Claude Code Context Realtime Upload Implementation Plan

> **Goal:** 让 Claude Code 跨机上下文补传在每轮结束后自动发生，并以异步队列、失败重试和增量扫描保证交互体验与可靠性。

**Architecture:** `Stop`、`SubagentStop`、`StopFailure` hook 仅把 session 任务原子写入本地队列并启动 detached worker；worker 串行调用现有抽取/上传逻辑。`SessionEnd` 写入同一队列并在无活动 worker 时同步排空。checkpoint 在内容 hash 基础上记录 transcript 成功偏移。

**Tech Stack:** Node.js CommonJS uploader、Claude Code hooks、Node test runner、TypeScript tests、Next.js setup routes。

---

### Task 1: 固化 hook 注册契约

**Files:**
- Modify: `test/claude-context-uploader.test.ts`
- Modify: `scripts/claude_context_uploader.js`

1. 写失败测试，断言安装后存在 `Stop`、`SubagentStop`、`StopFailure`、`SessionEnd`，用户 hook 被保留且重复安装幂等。
2. 运行 `npm exec -- tsx --test test/claude-context-uploader.test.ts`，确认测试因当前只注册 `SessionEnd` 而失败。
3. 实现多事件 hook 的安装、升级和卸载。
4. 重跑专项测试。

### Task 2: 实现快速入队和可靠 drain

**Files:**
- Modify: `test/claude-context-uploader.test.ts`
- Modify: `scripts/claude_context_uploader.js`

1. 写失败测试，覆盖按 session 合并、成功删除、失败保留、陈旧锁回收。
2. 运行专项测试并确认预期失败。
3. 实现原子任务文件、detached worker、单 worker 锁和失败重试。
4. 重跑专项测试。

### Task 3: 实现 transcript 增量扫描

**Files:**
- Modify: `test/claude-context-uploader.test.ts`
- Modify: `scripts/claude_context_uploader.js`

1. 写失败测试：首次扫描返回已有 hook，上次偏移后追加 tool result，第二次只返回新增 tool result。
2. 运行专项测试并确认预期失败。
3. 实现字节边界安全的 JSONL 增量扫描和 checkpoint 偏移推进规则。
4. 重跑专项测试。

### Task 4: 更新安装提示与接入文档

**Files:**
- Modify: `src/app/api/ingest/setup/auto/route.ts`
- Modify: `src/app/api/ingest/setup/route.ts`
- Modify: `src/app/api/ingest/claude/context/route.ts`
- Modify: `test/claude-context-e2e.test.ts`
- Modify: `docs/user-guide/observability/view-traces.md`
- Modify: `docs/developer-guide/05-data-and-control-flow.md`

1. 把 “SessionEnd 才补传” 的安装提示和注释改为“每轮异步补传、SessionEnd 兜底”。
2. 更新跨机端到端测试说明和两套指南的数据流描述。
3. 运行相关 route/setup 与上下文专项测试。

### Task 5: 本地完整回归

**Files:**
- Test only

1. 运行：
   `npm exec -- tsx --test test/claude-context-e2e.test.ts test/claude-context-supplement.test.ts test/claude-context-uploader.test.ts test/claude-subagent-map-e2e.test.ts test/session-interactions-merge.test.ts test/claude-otel-ingest.test.ts`
2. 运行 `npm run test`。
3. 运行 `npx tsc --noEmit`。
4. 检查 `git diff --check` 和最终 diff。

### Task 6: 119 真实跨机验证

**Files:**
- Test only

1. 将 MR 最新 uploader 安装到 Claude Code 客户端测试环境，并确认四类 hook 已注册。
2. 运行包含系统提示词、`additionalContext`、普通工具和子 Agent 的唯一标记会话。
3. 主 Agent 一轮结束后不执行 `/exit`，轮询 `119.3.152.42:3000` 的 spool/数据库。
4. 断言唯一 session 已出现补传事件，且 interactions/Agent tree 能看到四类内容。
5. 验证完成后正常退出测试会话，确认 `SessionEnd` 不产生重复内容。

### Task 7: 更新 MR

**Files:**
- Git operations only

1. 确认工作区只包含本次变更。
2. 使用 Conventional Commit 提交。
3. 推送当前 `feat/claude-context-supplement` 到其已配置的 MR 源远端。
4. 通过 GitCode API 核对 MR 244 的新 head SHA 和可合并状态，不执行合并。
