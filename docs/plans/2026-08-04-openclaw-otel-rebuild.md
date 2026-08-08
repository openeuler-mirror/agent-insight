# OpenClaw OTel Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 保留并修正 OpenClaw OTel 接入，恢复 MR !203 破坏的旧功能，并证明其他采集框架不受影响。

**Architecture:** 共享 OTLP normalizer 只增加兼容属性并保留 span 类型，OpenClaw 的聚合和存储语义封装在专属 adapter 中。watcher 使用通用 record 上传链路，旧专用地址仅作无损兼容；模型代理停止转发。

**Tech Stack:** Next.js App Router、TypeScript、Node test runner、Prisma、SQLite、OTLP JSON/Protobuf。

---

### Task 1: 固化注册回归并恢复首次注册语义

**Files:**
- Create: `test/auth-apikey-registration.test.ts`
- Modify: `src/app/api/auth/apikey/route.ts`

**Step 1: Write the failing tests**

- 新用户注册后断言内置 Agent、Skill、数据集和 3 条 Execution 已生成。
- `Alice` 与 `alice` 断言归一到同一用户。
- 10 路并发首次注册断言全部 200、返回同一 key、数据库只有一个用户。
- 非法邮箱格式断言 400。

**Step 2: Run tests to verify RED**

Run: `node --import tsx --test test/auth-apikey-registration.test.ts`

Expected: 示例数据、大小写、竞态和邮箱用例按当前缺陷失败。

**Step 3: Implement the minimal fix**

- 恢复 `trim().toLowerCase()` 和邮箱校验。
- 恢复唯一约束异常后的重新查询。
- 仅由真正创建用户的请求调用 `seedBuiltinExampleForUser`。
- 保留当前 `wi_` key 格式，避免无关兼容变更。

**Step 4: Verify GREEN**

Run: `node --import tsx --test test/auth-apikey-registration.test.ts`

Expected: PASS。

### Task 2: 固化 setup 兼容回归并恢复非交互模式

**Files:**
- Create: `test/setup-noninteractive-compat.test.ts`
- Modify: `src/app/api/ingest/setup/route.ts`
- Modify: `src/app/(main)/accessconfig/install/page.tsx`

**Step 1: Write the failing tests**

- URL `yes/y/noninteractive`、`nokey/no-key`、`frameworks` 参数。
- Bash `-y/--yes/--no-key/--frameworks` 与环境变量。
- PowerShell 非交互和强制清 key。
- 断言 OpenCode、Claude、OpenClaw、CodeAgent、Hermes、Jiuwen 仍在生成脚本中。

**Step 2: Run tests to verify RED**

Run: `node --import tsx --test test/setup-noninteractive-compat.test.ts test/codeagent-otel-setup-env.test.ts test/claude-otel-setup-env.test.ts`

Expected: 新兼容用例失败，既有框架用例保持通过。

**Step 3: Implement the minimal fix**

- 将 noninteractive/framework/no-key 状态作为显式参数传入 Bash/PowerShell 生成器。
- 恢复旧 CLI/env 解析，但保留当前框架白名单和后来新增的 setup 代码块。
- 保持 OpenClaw OTel 与 watcher 互斥说明。

**Step 4: Verify GREEN and cross-framework setup**

Run: `node --import tsx --test test/setup-noninteractive-compat.test.ts test/codeagent-otel-setup-env.test.ts test/claude-otel-setup-env.test.ts test/opencode-env-shadow.test.ts`

Expected: PASS。

### Task 3: 固化 OpenClaw OTLP 契约并修复归一化

**Files:**
- Modify: `test/openclaw-e2e.test.ts`
- Modify: `test/otel-trace-aggregator.test.ts`
- Modify: `src/lib/ingest/claude-otel/otlp-json.ts`
- Modify: `src/lib/ingest/otel/types.ts`

**Step 1: Write the failing tests**

- 使用文档中的 `witty.session.id`、`witty.agent.*`、`witty.tool.*`、`witty.skill.*`。
- 使用 `gen_ai.usage.prompt_tokens/completion_tokens/total_tokens`。
- 断言 root=agent、tool/skill=tool、LLM=llm，session 和 Token 正确。
- 同一载荷 JSON/Protobuf 解码结果等价。

**Step 2: Run tests to verify RED**

Run: `node --import tsx --test test/openclaw-e2e.test.ts test/otlp-protobuf-decoder.test.ts`

Expected: 当前实现出现 session fallback、类型错误和 Token=0。

**Step 3: Implement additive normalization**

- session 优先级增加 `witty.session.id`。
- user 增加 `witty.user.id`。
- agent/tool/skill 属性和名称按契约分类。
- Token 增加 prompt/completion 别名。
- 保留 `agent` 类型，不再压成 `llm`。

**Step 4: Verify GREEN and generic adapters**

Run: `node --import tsx --test test/openclaw-e2e.test.ts test/otel-trace-aggregator.test.ts test/codeagent-otel-ingest.test.ts test/claude-otel-ingest.test.ts`

Expected: PASS。

### Task 4: 重建 OpenClaw 聚合与幂等存储

**Files:**
- Modify: `src/lib/ingest/otel/adapters/openclaw.ts`
- Modify: `src/lib/ingest/adapters/openclaw.ts`
- Modify: `test/openclaw-e2e.test.ts`
- Create: `test/openclaw-storage-normalization.test.ts`

**Step 1: Write the failing tests**

- 聚合 root/LLM/tool/skill/sub-agent，断言 interaction 数、tool 计数、错误数、Token 和最终输出。
- 连续三次 `normalizeForStorage`，断言 content 不增长。
- 重传同批事件，断言聚合结果稳定。

**Step 2: Run tests to verify RED**

Run: `node --import tsx --test test/openclaw-e2e.test.ts test/openclaw-storage-normalization.test.ts`

Expected: tool_count=0、agent 被算作 LLM、content 重复。

**Step 3: Implement the minimal adapter fix**

- LLM 生成 assistant interaction。
- tool/skill 生成规范 tool call，并保留输入、结果和错误。
- agent 生成可供现有子 Agent 投影识别的边界 interaction。
- storage normalizer 按稳定签名去重已有扁平 tool block。

**Step 4: Verify GREEN**

Run: `node --import tsx --test test/openclaw-e2e.test.ts test/openclaw-storage-normalization.test.ts test/framework-adapter-registry.test.ts`

Expected: PASS。

### Task 5: 将 watcher 恢复为无损 record 上传

**Files:**
- Modify: `scripts/openclaw_watcher_client.ts`
- Modify: `src/app/api/ingest/openclaw/upload/route.ts`
- Modify: `test/ingest-payload-contract.test.ts`
- Modify: `test/ingest-endpoint-contract.test.ts`

**Step 1: Write the failing tests**

- watcher 新地址解析到通用 `/api/ingest/upload`。
- 旧专用入口保持完整 interactions，不产生合成 span。
- 无 key、错误 key 分别复用通用上传的 400/401。

**Step 2: Run tests to verify RED**

Run: `node --import tsx --test test/ingest-payload-contract.test.ts test/ingest-endpoint-contract.test.ts`

Expected: 当前 bridge 丢 interactions 且错误身份返回成功。

**Step 3: Implement compatibility delegation**

- watcher 改用 canonical `/api/ingest/upload`。
- 旧专用 handler 原样委托通用 upload handler，不再写 OTel spool。

**Step 4: Verify GREEN and OpenCode isolation**

Run: `node --import tsx --test test/ingest-payload-contract.test.ts test/ingest-endpoint-contract.test.ts test/opencode-uploader-signature.test.ts test/opencode-collection.test.ts`

Expected: PASS。

### Task 6: 停止不属于 OTel 的模型代理并清理明文测试脚本

**Files:**
- Modify: `src/app/api/proxy/v1/chat/completions/route.ts`
- Delete: `scripts/start_openclaw_test.ps1`
- Delete: `scripts/install_openclaw_demo.ps1`
- Create: `test/openclaw-proxy-disabled.test.ts`
- Modify: `test/ingest-endpoint-contract.test.ts`

**Step 1: Write the failing test**

- 无论请求是否带 Authorization，代理都返回 410，且不会调用 `fetch`。
- 仓库当前文件中不存在提交过的 key/token 字面量。

**Step 2: Run tests to verify RED**

Run: `node --import tsx --test test/openclaw-proxy-disabled.test.ts`

Expected: 当前代理发起上游请求，测试失败。

**Step 3: Implement safe shutdown**

- 路由改为无副作用的 410 响应并给出迁移说明。
- 删除仅用于旧 demo 的两个脚本。

**Step 4: Verify GREEN**

Run: `node --import tsx --test test/openclaw-proxy-disabled.test.ts test/ingest-endpoint-contract.test.ts`

Expected: PASS。

### Task 7: 同步用户与开发者指南

**Files:**
- Modify: `docs/user-guide/quickstart.md`
- Modify: `docs/user-guide/concepts.md`
- Modify: `docs/developer-guide/05-data-and-control-flow.md`
- Modify: `docs/developer-guide/09-otlp-attribute-contract.md`
- Modify: `docs/developer-guide/INDEX.md` only if its provenance instructions require it

**Step 1: Update documentation**

- 明确 OTel 是主路径、watcher 是兼容路径且二者互斥。
- 删除模型代理和有损 bridge 描述。
- 使属性契约与实际解析、聚合、身份错误语义一致。

**Step 2: Run documentation contract tests**

Run: `node --import tsx --test test/ingest-endpoint-contract.test.ts test/openclaw-e2e.test.ts`

Expected: PASS。

### Task 8: 全面验证

**Files:**
- No production changes expected

**Step 1: Run targeted regression matrix**

Run: `node --import tsx --test test/auth-apikey-registration.test.ts test/setup-noninteractive-compat.test.ts test/openclaw-e2e.test.ts test/openclaw-storage-normalization.test.ts test/openclaw-proxy-disabled.test.ts test/ingest-payload-contract.test.ts test/ingest-endpoint-contract.test.ts test/codeagent-otel-ingest.test.ts test/claude-otel-ingest.test.ts test/otel-trace-aggregator.test.ts`

Expected: PASS。

**Step 2: Run the full suite against an isolated database copy**

Run: `DATABASE_URL=file:<isolated-copy> npm run test`

Expected: 0 failures; any pre-existing failure must be reproduced on the branch base and reported separately.

**Step 3: Run build and static checks**

Run: `npm run build`

Expected: exit 0。

**Step 4: Run final live verification if approved**

- 启动 `bash scripts/develop_start.sh`。
- 新用户注册并检查示例数据。
- 发送 OpenClaw JSON/Protobuf OTel 请求并检查 Trace 页面。
- 发送 watcher record 并检查完整多轮内容。
- 运行 OpenCode golden path，确认正文、工具和 Skill 不丢失。
