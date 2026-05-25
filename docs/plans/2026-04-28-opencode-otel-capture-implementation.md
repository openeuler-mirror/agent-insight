# OpenCode OTel 语义采集（本地 JSONL 真源）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用新的 OpenCode 采集插件替换旧链路：本地 JSONL 作为真源缓冲，uploader 统一上传到现有 Skill-Insight API，并补齐 system prompt / trace / subagent 等所需信息。

**Architecture:** OpenCode 插件只负责“低开销采集→落盘”，uploader 负责“聚合/幂等/上传/清理”。system/user/assistant 全文保存与上传；tool 输出允许截断或 blob 引用以控成本。

**Tech Stack:** TypeScript (tsx runtime)、Next.js API routes（下发 setup 脚本与插件文件）、Node.js fs/stream、现有上传 API（沿用当前 payload 形状）。

---

## Task 1: 盘点现有链路与替换点（只读）

**Files:**
- Review: [scripts/opencode_plugin.ts](file:///Users/guoyichen/code/gitee/witty-skill-insight/scripts/opencode_plugin.ts)
- Review: [src/app/api/setup/route.ts](file:///Users/guoyichen/code/gitee/witty-skill-insight/src/app/api/setup/route.ts)
- Review: [src/app/api/setup/opencode/route.ts](file:///Users/guoyichen/code/gitee/witty-skill-insight/src/app/api/setup/opencode/route.ts)
- Review: [scripts/activate_telemetry.sh](file:///Users/guoyichen/code/gitee/witty-skill-insight/scripts/activate_telemetry.sh)
- Review: [docs/guide/2-环境配置与安装.md](file:///Users/guoyichen/code/gitee/witty-skill-insight/docs/guide/2-环境配置与安装.md)

**Step 1: 列出“旧插件”判定规则**
- 明确旧 OpenCode 插件文件名/安装路径（例如 `Witty-Skill-Insight.ts` 与历史 `Skill-Insight.ts` 的兼容）。
- 明确 setup 脚本里下载到哪些位置（`$OPENCODE_CONFIG_DIR/plugins` 与 `$HOME/.opencode/plugins`）。

**Step 2: 列出“必须保持兼容”的上传字段**
- 以现有 `payload` 为准：`task_id/query/model/tokens/latency/.../interactions/final_result/subagent_*` 等。

**Verification:**
- 无需运行命令；输出一份替换点清单（内部自检）。

---

## Task 2: 定义新采集产物（JSONL schema）与脱敏规则

**Files:**
- Create: `scripts/opencode_otel_schema.ts`（schema/类型/常量，供插件与 uploader 共用）
- Create: `test/opencode_otel_schema.test.ts`

**Step 1: 写 failing test（schema 不变量）**
- 断言 record 最小字段存在：`t/kind/sessionID?`。
- 断言不允许字段：`apiKey/authorization/token` 等写入（脱敏规则覆盖）。

**Step 2: 运行测试确认失败**
Run: `npm test`
Expected: FAIL（文件不存在或导出缺失）

**Step 3: 写最小实现**
- 定义 `Kind` 枚举、`JsonlRecord` 类型、`redact()` 规则（pattern + key-list）。

**Step 4: 运行测试确认通过**
Run: `npm test`
Expected: PASS

---

## Task 3: 实现新的 OpenCode 采集插件（落盘 + 后台队列）

**Files:**
- Create: `scripts/opencode_plugin_otel.ts`（新的 OpenCode 插件源文件，由 /api/setup/opencode 下发）
- Create: `scripts/opencode_uploader.ts`（可被插件 spawn 的 uploader；也可供 watcher 调用）
- Modify: `src/app/api/setup/opencode/route.ts`（改为下发新插件文件）
- Test: `test/opencode_plugin_redact.test.ts`

**Step 1: 设计插件运行时的配置读取**
- 从 `process.env` 读取（优先）。
- 解析 `~/.skill-insight/.env`（后备，沿用现有 setup 写入位置）。
- 配置项至少包括：
  - `SKILL_INSIGHT_HOST`、`SKILL_INSIGHT_API_KEY`
  - `SKILL_INSIGHT_OPENCODE_SPOOL_DIR`（默认 `~/.skill-insight/otel_data/opencode` 或新目录）
  - `SKILL_INSIGHT_RETENTION_DAYS`（默认 10）
  - `SKILL_INSIGHT_MAX_TOOL_IO`（tool input/output 截断上限）

**Step 2: 写 failing test（env 解析与优先级）**
- 构造临时 `.env` 文件内容，断言优先级：env > file > defaults。

**Step 3: 运行测试确认失败**
Run: `npm test`

**Step 4: 插件最小实现（不阻塞）**
- hooks：`event`、`chat.message`、`experimental.chat.system.transform`。
- 写入策略：内存队列 + 单 writer 循环；writer 处理 `stream.write` backpressure（等 `drain`）。
- 落盘路径：按天目录 + run 文件名（`run-<ts>-<pid>.jsonl`）。
- 不截断范围：
  - system prompt：全文写入（可分片/多行 record，保证可复原）
  - user prompt：全文写入（来自 `chat.message` 或 `message.updated`）
  - assistant output：尽量记录最终文本（来自 `message.part.updated(type=text)`；delta 可选记录）
- tool input/output：允许截断（默认），或 blob 引用（可选二期）。
- 安全：禁止把 `plugin.config` 原样写入（只允许写 `plugin.config.redacted`，去除 provider secrets）。

**Step 5: 运行测试确认通过**
Run: `npm test`

---

## Task 4: uploader：聚合 + 幂等上传（降低重评/丢失风险）

**Files:**
- Modify/Create: `scripts/opencode_uploader.ts`
- Create: `test/opencode_uploader_dedupe.test.ts`

**Step 1: 写 failing test（幂等签名）**
- 输入：同一 session 的两段 jsonl（第二段是第一段的超集）。
- 预期：uploader 只上传一次“最新超集”，或第二次覆盖但服务端幂等（本地 checkpoint 防止回退）。

**Step 2: 运行测试确认失败**
Run: `npm test`

**Step 3: 最小实现**
- 解析 jsonl → 按 `sessionID` 归并：
  - `query`：第一条 user message
  - `interactions`：message.updated + part.updated/tool parts 归并（尽量保持现有结构）
  - `final_result`：最后一条 assistant text
  - `tokens/latency/tool_call_count/...`：从事件派生（复用当前计算逻辑）
  - `subagent_*`：从 `session.created parentID` 和 message.agent 派生
  - `system_prompts[]`：从 `system.prompt` records 提取
  - `trace`：按 session 生成 trace_id，span 列表可先从 message/tool 事件派生（最小可用）
- checkpoint：
  - 每个 session 保存 `lastTs`、`lastAssistantLen/hash`、`uploadedAt`
  - 上传前比较，防止回退/重复
- 上传：沿用现有 API 与认证方式（读取 `SKILL_INSIGHT_HOST/API_KEY`）。

**Step 4: 运行测试确认通过**
Run: `npm test`

---

## Task 5: setup 脚本改造（curl 安装时换新插件、删除旧插件）

**Files:**
- Modify: [src/app/api/setup/route.ts](file:///Users/guoyichen/code/gitee/witty-skill-insight/src/app/api/setup/route.ts)
- Modify: [docs/guide/2-环境配置与安装.md](file:///Users/guoyichen/code/gitee/witty-skill-insight/docs/guide/2-环境配置与安装.md)

**Step 1: 旧插件移除策略（安全）**
- 仅移除匹配以下文件名的 OpenCode 插件：
  - `Skill-Insight.ts`（历史）
  - `Witty-Skill-Insight.ts`（当前）
- 不移除用户其它 plugin entries。

**Step 2: setup 脚本下载新插件**
- 把 `curl "$BASE/api/setup/opencode" -o "$OPENCODE_CONFIG_DIR/plugins/Witty-Skill-Insight.ts"` 改为新文件名（例如 `Witty-Skill-Insight-OTel.ts`），并同步到 `$HOME/.opencode/plugins/`。
- 同时更新 TUI 插件（若需要展示 trace/system prompt 入口）。

**Step 3: 测试（人工验证）**
Run:
- 启动平台：`npm run dev`（或按现有启动方式）
- 执行：`curl -sSf http://127.0.0.1:3000/api/setup | bash`
Expected:
- `~/.skill-insight/.env` 存在并包含必要字段
- OpenCode 插件目录下只有新插件（旧插件被清理）

---

## Task 6: 本地过期文件清理（默认 10 天，可配置）

**Files:**
- Modify: `scripts/opencode_uploader.ts`（或插件启动时也做一次轻量清理）
- Create: `test/retention_cleanup.test.ts`

**Step 1: failing test（按 mtime 删除）**
- 构造临时目录与不同 mtime 文件，断言超过 N 天删除，近 N 天保留。

**Step 2: 实现清理逻辑**
- 以 `SKILL_INSIGHT_RETENTION_DAYS` 为准，默认 10。
- 清理范围：
  - spool 目录（jsonl）
  - blob 目录（若启用）
  - uploader checkpoint（可选）

**Step 3: 运行测试**
Run: `npm test`

---

## Task 7: UI 适配（最小可用）

**Files:**
- Modify: `src/components/...`（根据现有 Dashboard/详情页字段决定）
- Add/Modify: 对应展示组件（system_prompts、trace tree、subagent 链路）

**Step 1: 先保证旧字段展示不变**
- 如果后端仍接收旧 payload，优先保持现有页面无回归。

**Step 2: 增量展示**
- 在详情页新增可折叠区块：
  - system prompts（按 model/agent 分组）
  - trace/subagent tree（session.parentID 链接）

**Verification:**
- 手工跑一次 OpenCode 任务并上传后，在 Dashboard 能看到：
  - system prompt 全文入口
  - 子 Agent 链路（Xuanyuan/Fuxi/Dayu/Kuafu）

---

## 执行说明

- 计划完成后进入实现阶段时，优先选择“子任务驱动”逐项落地，确保每步都有可验证产物（文件、测试、可运行脚本）。
- 本计划不包含自动 git commit；如你希望每个 task 自动提交，我再补充 commit 粒度与 message 规范。

