# 内置故障覆盖矩阵

> **Insight 拓扑说明**：编排与 Judge 在 agent-insight 服务端；本机 FI Worker + [`agent_fault_injection/`](../../../../agent_fault_injection/) 负责注入与采集。独立 FastAPI/Vite 不纳入产品路径。


> 权威发现方式：`python -m agent_fault_injection.cli fault list`。每个故障目录**必须**含 `SKILL.md`（YAML frontmatter 必填 `name` / `description`）。多数故障仅需该文件；若需声明 tools / `agent_tools` / `authoritative_verifier`，可另加**可选**的 `fault.json`。  
> 子模式由 `fault_inject/catalog/scenarios.py` 从「场景总览」表或 `## 场景N：…` 标题解析；Insight 建任务用 TS `compose-prompt.ts` 合成用户任务。  
> 注入方式 key（`injection_method`）：`skill_inject` / `file_tamper` / `prompt_modify` / `tool_result_tamper` / `intercept_rewrite`；无旧版别名。纯 Skill 故障默认 `skill_inject`。展示标签见各 `skills/*/SKILL.md` 的 `metadata`；method 中文名见 `capability_api.yaml`。

| 目录名 (`--fault`) | frontmatter `name` (`skill_name`) | 子模式 (id → 名称) | 关联检测 / 主题 | 示例配置 |
|-|-|-|-|-|
| `analysis-paralysis` | `analysis-paralysis` | 1 → 分析瘫痪长文注入 | 过度思考 / Analysis Paralysis | Insight FI 任务表单 |
| `thinking-dead-loop` | `thinking-dead-loop` | 1 → 字面重复死循环；2 → 逻辑死循环；3 → 计划-执行死循环 | Thinking 死循环 | Insight FI 任务表单 |
| `tool_repeat_dead_loop` | `tool_repeat_dead_loop` | 1–4 → generic / unknown / global / ping_pong | 工具重复死循环 | Insight FI 任务表单 |
| `ras-early-stop` | `ras-early-stop` | A → 基础产物 | 分阶段交付 / 早停相关流水线 | — |
| `step-omission` | `ras-step-omission` | 1 → beta 文件遗漏 | 计划正确、执行跳步 | Insight FI 任务表单 |
| `step-order-error` | `ras-step-order-error` | 1 → beta 先于 alpha | 计划正确、执行错序 | Insight FI 任务表单 |
| `tool-selection-error` | `ras-tool-selection-error` | 见 Skill 场景一 / 场景二 | 工具选择错误 | — |
| `skill-selection-conflict` | `ras-skill-selection-conflict` | 1 → 代码审查语义诱饵 | Skill 选择冲突（`assistant.tool_call.replace_argument`） | Insight FI 任务表单 |
| `tool-argument-error` | `ras-tool-argument-error` | 1 → 文件名参数替换 | 工具参数错误（intercept_rewrite） | Insight FI 任务表单 |
| `planning-logic-error` | `ras-planning-logic-error` | 1 → 依赖颠倒；2 → 环依赖；3 → 步骤缺失；4 → 规划约束冲突 | Planning Logic Error | Insight FI 任务表单 |
| `unverified-success` | `ras-two-condition-test` | —（协议型，无子模式表） | 未经验证的成功；可选 `fault.json` + tools + 权威 verifier | — |
| `execution-goal-drift` | `ras-routing-continuity-test` | 1 → 跨阶段批次连续性 | 执行目标漂移；可选 `fault.json` + tools + 权威 verifier | — |
| `memory-noise-interference` | `ras-memory-noise-interference` | 1–3 → 无关历史 / 冲突事实 / 错误响应；4 → 会话记忆虚假先验 | 记忆噪声干扰 | Insight FI 任务表单 |
| `memory-file-loss` | `ras-memory-file-loss` | 1 → 删除全文；2 → 删除约束段 | 记忆文件丢失（文件篡改） | Insight FI 任务表单 |
| `tool-observation-delta` | `ras-tool-observation-delta` | 1 → 工具观测似真偏移 | 工具噪声干扰 | Insight FI 任务表单 |
| `intermediate-conclusion-drift` | `ras-intermediate-conclusion-drift` | 1 → 中间结论漂移 | 推理错误 / 中间结论漂移 | Insight FI 任务表单 |
| `compositional-implicit-intent` | `ras-compositional-implicit-intent` | 1 → 配置外泄 | 组合式隐含意图（Skill 组合涌现） | Insight FI 任务表单 |

## 尚未落地（仅有检测/注入设计）

| 主题 | 本仓状态 |
|------|----------|
| 领域认知偏差 Domain Cognitive Bias | **无**对应 Skill；FI 仍为 Phase1 方案 |
| 记忆损坏/投毒 / 会话历史裁剪 | `memory-file-loss` 已落地（FI-P0 文件层）；corruption / poison / history-loss / compacting 未落地 |
| 记忆噪声压缩失真 | S1–S4 已落地（S4=假先验 middleware）；**S5 压缩失真未实施** |
| Planning 其余子类（constraint_ignorance 等） | `planning-logic-error` 含 S1–S3 结构错 + S4 约束冲突；其余未落地 |
| 工具超时歧义 / 限流 / 权限拒绝 / MCP 挂起 | 需新 runtime op；本轮未落地 |

## 评判边界

本仓隔离 Judge 对照 **Skill 规范 ↔ 实际轨迹**，输出四元组。  
这**不等于** agent-insight / `agent_ras` 检测器是否报警；检测器对齐需另接 RAS 观测链路。

TOKEN 探针（旧 `tool-result-corruption` / `prompt-system-override` / `interception-*`）已迁至 [`tests/fixtures/injection-smoke/`](../../../../agent_fault_injection/tests/fixtures/injection-smoke/)，**不**出现在 `fault list`。

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-08-13 | 去掉设计文档互指列；覆盖矩阵只列 Skill |
| 2026-08-05 | Insight 吸纳：证据边界 / inconclusive；链接改挂 agent-ras features |
| 2026-08-04 | 注入方式意译五 key（无旧版兼容）；落地 prompt / intercept 示例故障 |
| 2026-08-04 | 落地 `tool-result-corruption`（L3 中间件 tool_result 改写） |
| 2026-08-04 | 落地 `memory-file-loss`（文件结构注入）；脚本迁至 `skills/*/scripts/` |
| 2026-08-03 | 对齐当前内置 Skill；记忆噪声干扰 Skill S1–S3 已落地，S4 未实施 |
| 2026-08-03 | 对齐当时 10 个内置 Skill；契约改为 SKILL.md + 可选 fault.json |
| 2026-08-03 | 尚未落地表增加 Memory Fault 方案链接 |
| 2026-07-31 | 初版：对齐当时 7 个内置 Skill 与去 `fault.json` 契约 |
| 2026-03-23 | 初建覆盖矩阵 |
