# 内置故障覆盖矩阵

> **Insight 拓扑说明**：编排与 Judge 在 agent-insight 服务端；本机 FI Worker + [`agent_fault_injection/`](../../../agent_fault_injection/) 负责注入与采集。 独立 FastAPI/Vite 不纳入产品路径。见 [server-client-split.md](server-client-split.md) · [ras-fi-insight-relationship.md](ras-fi-insight-relationship.md)。


> 权威发现方式：`python -m agent_fault_injection.cli fault list`。每个故障目录**必须**含 `SKILL.md`（YAML frontmatter 必填 `name` / `description`）。多数故障仅需该文件；若需声明 tools / `agent_tools` / `authoritative_verifier`，可另加**可选**的 `fault.json`。  
> 子模式由 `fault_inject/catalog/scenarios.py` 从「场景总览」表或 `## 场景N：…` 标题解析；Insight 建任务用 TS `compose-prompt.ts` 合成用户任务。  
> 注入方式 key（`injection_method`）：`skill_inject` / `file_tamper` / `prompt_modify` / `tool_result_tamper` / `intercept_rewrite`；无旧版别名。纯 Skill 故障默认 `skill_inject`。展示标签见各 `skills/*/SKILL.md` 的 `metadata`；method 中文名见 `capability_api.yaml`。  
> **新增故障模式（Lane A）**：见 [guides/lane-a-add-fault.md](../guides/lane-a-add-fault.md)。

| 目录名 (`--fault`) | frontmatter `name` (`skill_name`) | 子模式 (id → 名称) | 关联检测 / 主题 | 示例配置 | 设计文档 |
|-|-|-|-|-|-|
| `analysis-paralysis` | `analysis-paralysis` | 1 → 分析瘫痪长文注入 | 过度思考 / Analysis Paralysis | Insight FI 任务表单 | [analysis-paralysis](../../agent-ras/designs/features/analysis-paralysis.md) |
| `planning-logic-error` | `ras-planning-logic-error` | 1 → 依赖颠倒；2 → 环依赖；3 → 步骤缺失 | Planning Logic Error（规划逻辑错误） | Insight FI 任务表单 | [planning-error](../../agent-ras/designs/features/planning-error.md) |
| `thinking-dead-loop` | `thinking-dead-loop` | 1 → 字面重复死循环；2 → 逻辑死循环；3 → 计划-执行死循环 | Thinking 死循环 | — | 与 analysis-paralysis 边界见 Skill 正文 |
| `tool_repeat_dead_loop` | `tool_repeat_dead_loop` | 1–4 → generic / unknown / global / ping_pong | 工具重复死循环 | — | — |
| `tool-selection-error` | `ras-tool-selection-error` | 见 Skill 场景一 / 场景二 | 工具选择错误 | — | — |
| `step-omission` | `ras-step-omission` | 1 → beta 文件遗漏 | 计划正确、执行跳步 | Insight FI 任务表单 | Planning 边界：执行偏离 |
| `step-order-error` | `ras-step-order-error` | 1 → beta 先于 alpha | 计划正确、执行错序 | — | 同上；对比 planning-logic-error |
| `ras-early-stop` | `ras-early-stop` | A → 基础产物 | 分阶段交付 / 早停相关流水线 | — | — |
| `unverified-success` | `ras-two-condition-test` | —（协议型，无子模式表） | 未经验证的成功；可选 `fault.json` + tools + 权威 verifier | — | — |
| `execution-goal-drift` | `ras-routing-continuity-test` | 1 → 跨阶段批次连续性 | 执行目标漂移；可选 `fault.json` + tools + 权威 verifier | — | — |
| `memory-noise-interference` | `ras-memory-noise-interference` | 1–3 → 无关历史 / 冲突事实 / 错误响应 | 记忆噪声干扰 | — | [memory-noise-interference](../../agent-ras/designs/features/memory-noise-interference.md) |
| `memory-file-loss` | `ras-memory-file-loss` | 1 → 删除全文；2 → 删除约束段 | 记忆文件丢失（文件篡改） | Insight FI 任务表单 | [memory-file-loss](../../agent-ras/designs/features/memory-file-loss.md) |
| `tool-result-corruption` | `ras-tool-result-corruption` | — | 工具结果篡改 | Insight FI 任务表单 | [runtime FI](runtime-middleware-fault-injection.md) |
| `prompt-system-override` | `ras-prompt-system-override` | — | 提示词修改（system 覆盖） | Insight FI 任务表单 | [runtime FI](runtime-middleware-fault-injection.md) |
| `interception-history-inject` | `ras-interception-history-inject` | — | 拦截改写（历史注入） | Insight FI 任务表单 | [runtime FI](runtime-middleware-fault-injection.md) |
| `interception-assistant-corruption` | `ras-interception-assistant-corruption` | — | 拦截改写（助手文本） | Insight FI 任务表单 | [runtime FI](runtime-middleware-fault-injection.md) |

## 尚未落地（仅有检测/注入设计）

| 主题 | 文档 | 本仓状态 |
|------|------|----------|
| 领域认知偏差 Domain Cognitive Bias | [domain-cognitive-bias](../../agent-ras/designs/features/domain-cognitive-bias.md) | **无**对应 Skill；FI 仍为 Phase1 方案 |
| 记忆损坏/投毒 / 会话历史裁剪 | [memory-file-loss](../../agent-ras/designs/features/memory-file-loss.md) | `memory-file-loss` 已落地（FI-P0 文件层）；corruption / poison / history-loss / compacting 未落地 |
| 记忆噪声 S4 压缩失真 | [memory-noise-interference](../../agent-ras/designs/features/memory-noise-interference.md) | S1–S3 已落地；**S4 未实施**（需 middleware） |
| Planning 其余子类（constraint_ignorance 等） | [planning-error](../../agent-ras/designs/features/planning-error.md) | FI-P0 仅 `planning-logic-error`；其余见 FI-P1+ |

## 评判边界

本仓隔离 Judge 对照 **Skill 规范 ↔ 实际轨迹**，输出四元组（见 [server-judge.md](modules/server-judge.md)）。  
这**不等于** agent-insight / `agent_ras` 检测器是否报警；检测器对齐需另接 RAS 观测链路。

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-08-05 | Insight 吸纳：证据边界 / inconclusive；链接改挂 agent-ras features
| 2026-08-04 | 注入方式意译六 key（无旧版兼容）；落地 prompt / intercept 示例故障 |
| 2026-08-04 | 落地 `tool-result-corruption`（L3 中间件 tool_result 改写） |
| 2026-08-04 | 落地 `memory-file-loss`（文件结构注入）；脚本迁至 `skills/*/scripts/` |
| 2026-08-03 | 对齐当前内置 Skill；记忆噪声干扰 Skill S1–S3 已落地，S4 未实施 |
| 2026-08-03 | 对齐当时 10 个内置 Skill；契约改为 SKILL.md + 可选 fault.json |
| 2026-08-03 | 尚未落地表增加 Memory Fault 方案链接 |
| 2026-07-31 | 初版：对齐当时 7 个内置 Skill 与去 `fault.json` 契约 |
| 2026-03-23 | 初建覆盖矩阵 |
