---
title: OpenCode 采集改造：OTel 语义 + 本地 JSONL 真源
date: 2026-04-28
status: approved
---

## 背景与目标

现状：项目通过 OpenCode 插件把 session/messages/tool 等信息聚合成自定义 payload 并上传；存在“运行时聚合、上传重试、以及数据一致性/去重”方面的复杂度与风险。

目标：完整改造 OpenCode 的采集方式，使其具备 OpenTelemetry 的语义表达（trace/span/log/metric 的概念与层级），同时以本地 JSONL 作为“真源”缓冲，再由 uploader 统一上传到现有后端 API。要求尽量不影响 OpenCode 运行过程。

明确约束（已确认）：
- 改造范围：完全替换现有采集插件链路（不依赖 ShareNext 作为你们的数据源）。
- 数据去向：本地 jsonl → 你们现有 API（不是直接 OTLP→Collector）。
- 不截断范围：system prompt + user prompt + assistant output 需要全文保存/上传；tool input/output 允许截断或单独落文件引用。
- 本地保留：默认 10 天，env 可配置。

## 总体方案（推荐架构）

组件拆分为两部分：

1) **采集插件（Collector Plugin）**
- 接入点：OpenCode 插件 hooks（`event`、`chat.message`、`experimental.chat.system.transform`）。
- 输出：追加写入 JSONL 文件（本地 spool），每行一条 record。
- 语义：以 OTel 思维组织字段，但不要求使用 OTLP 协议。
  - trace：以 session 作为 trace（`trace_id=sessionID` 或可替换为稳定 hash）。
  - span：message/tool/step 作为 span（`span_id`、`parent_span_id` 可由 messageID、partID、callID 派生）。
  - log：事件流（session/message/part/status/diff/permission）。
  - metric：可在 uploader 端派生计算（避免在采集路径做重计算）。
- 性能：hook 内只做“入队 + 快速序列化”，写文件由后台 flush 协程完成，避免阻塞 OpenCode 主流程。
- 安全：严禁落盘 provider apiKey、token、authorization 等敏感字段；必须做字段级脱敏/剔除（比当前“原样写 config”更严格）。

2) **上传器（Uploader）**
- 输入：扫描/消费本地 spool JSONL 文件，按 session 归并与派生。
- 输出：构建与现有后端兼容的 payload（尽量保持你们已有字段），新增 OTel 语义字段（trace/subagent/system prompt 等），上传到现有 API。
- 幂等：通过稳定签名（sessionID + lastTs + lastAssistantLen/sha256 等）做“可重复上传但不覆盖回退”的幂等策略；本地维护 checkpoint，崩溃后可继续。
- 可靠性：上传失败时保留 spool，指数退避重试；成功后可标记/归档并参与过期清理。

## 数据模型（JSONL Record）

每条记录至少包含：
- `t`：ISO 时间
- `kind`：`plugin.start` | `plugin.config`(脱敏后) | `system.prompt` | `chat.message` | `event` | `error`
- `sessionID`：可空（部分全局事件无 session）
- `agent` / `model`：可空
- `trace_id` / `span_id` / `parent_span_id`：可选（后续逐步补齐，或在 uploader 中派生）
- `payload`：具体事件内容（脱敏后，且遵循“不截断范围”要求）

不截断策略：
- `system.prompt`：全文（建议分片或单独文件存储，但逻辑上“可复原全文”）。
- `chat.message`：用户输入全文与 assistant 输出全文（通过 `message.part.delta` 重建或直接记录最终文本）。
- tool input/output：可截断或落为 “blob 文件 + hash 引用”。

## 关键流程

1) OpenCode 运行中触发 hooks → 采集插件入队 record → 后台 writer 追加写入 `~/.skill-insight/opencode-spool/YYYY-MM-DD/run-<ts>-<pid>.jsonl`
2) uploader 周期性/退出前/后台常驻执行：
   - 扫描未完成文件
   - 解析并按 session 聚合出你们现有的 session payload（query、final_result、interactions、tokens、latency、tool_call_count、subagent 信息等）
   - 追加 OTel 语义字段（trace tree、span 列表、system prompt）
   - 调用你们现有 API 上传
   - 写入 checkpoint（按文件 offset 或按“已上传 signature”）
3) 过期清理：删除超过保留天数的 spool/归档文件与过期 checkpoint

## 配置与安装

### 配置来源
- 新增 `~/.skill-insight/.env`：只存本采集系统所需配置（上传 host/key、保留天数、spool 目录、队列大小等）。
- 优先级：运行时环境变量 > `~/.skill-insight/.env` > 内置默认值。

### curl 安装行为（你们的安装器）
- 安装/升级时：
  - 写入新插件文件到 OpenCode 全局插件目录（例如 `~/.config/opencode/plugins/Witty-Skill-Insight-OTel.ts` 或等价位置）
  - 更新 OpenCode 全局配置 `~/.config/opencode/opencode.json(.jsonc)` 的 `plugin` 列表：
    - 添加新插件 spec
    - 删除旧的采集插件 spec（仅删除命中你们旧插件名称的项；不影响用户其它插件）
  - 创建（或补全）`~/.skill-insight/.env` 模板（不写入真实 key）

## 风险与对策

1) “不阻塞且不丢失”不可同时无条件保证
- 对策：默认不阻塞 hook；当队列超过高水位时，允许短暂阻塞 writer 或降级（记录告警事件），避免 OOM。

2) 磁盘爆涨
- 对策：按天目录 + 文件滚动（size/time）+ 10 天默认过期清理；tool 大输出走 blob 引用。

3) 重复上传/重评/抖动
- 对策：uploader 以 session 视角做幂等（单调签名 + checkpoint），对同一 session 多次上传做“只前进不回退”。

4) 安全与隐私
- 对策：默认脱敏并禁止记录 secrets；system/user/assistant 全文可能敏感，按你们要求保存/上传，但应提供可配置开关与访问控制策略。

## 兼容界面（表达逻辑）

保持你们现有 payload 结构作为主展示输入：
- `task_id/query/model/tokens/latency/.../interactions/final_result`
- 增强字段：
  - `system_prompts[]`：每次 LLM 调用的 system prompt（全文或分片引用）
  - `trace`：`trace_id`、`spans[]`（message/tool/step）、`subagent_sessions[]`（parentID 关系）

界面改造原则：先“无痛接入”（旧字段继续工作），再逐步把 trace tree、子 Agent 链路、system prompt 入口做成可折叠/可检索的增强视图。

