# 分支变更 Summary（agent_reliability_dev）

## Summary

在 agent-core 落地 **Agent RAS（Reliability Assurance System）**，使单 Agent 的可靠性监控、异常检测与本地恢复能力由 harness 统一提供，core 仅保留最小协作契约；enterprise DeepAgent 等上层通过 `create_deep_agent(agent_ras=...)` 透传配置即可启用。

相对 `enterprise-dev`，本分支以 **单 Agent 双检测器**（`repeat_tool` + `llm_thinking_loop`）为稳定交付范围；流式观测走 harness `StreamObserver` 监听 `Session.write_stream`，**不扩展** core Rail 事件面。

---

## 主要变更

### 1. 新增 Agent RAS 运行时（harness）

`openjiuwen/harness/agent_ras/`：

| 模块 | 职责 |
|------|------|
| `monitor.py` | 统一编排：检测、恢复、流/HITL 生命周期 |
| `detectors/` | `RepeatToolCallDetector`、`LlmThinkingLoopDetector`（含 streaming tool-call args 扫描） |
| `recovery/` | Recovery Engine、原子操作（steer / notice / suppress / terminate）、HITL 状态与文案 |
| `config.py` / `factory.py` | `AgentRASConfig`、按 invoke 创建 Monitor 的 Rail 工厂 |
| `stream_observer.py` | 挂载 `{session_id}write_stream`，转发 `Monitor.on_stream_chunk` |
| `signal_builder.py` / `window.py` / `reporter.py` | Signal 构建、滑动窗口、指标 |

`openjiuwen/harness/rails/agent_ras_rail.py`：会话级 Rail，接入 invoke / model / tool 生命周期；`before_invoke` 挂载 StreamObserver，`after_invoke` 清理 Monitor。

### 2. 接入路径

- **`create_deep_agent`**（`openjiuwen/harness/factory.py`）：新增 `agent_ras: AgentRASConfig | dict | bool | None`；`None`/`True` 启用默认配置，`False` 关闭；未显式传入时自动挂载 `AgentRASRail`。
- **DeepAgent 单轮 steering**：`_steering_queue` 经 kwargs 传给 ReActAgent（不污染 inputs dict），供 RAS recovery `push_steering` 使用。
- **HITL**：优先使用宿主 `ask_user_question`；流中 ask 确认异常后通过 core abort 协作打断 `llm.stream`。

### 3. Core 最小改动（供 RAS 协作）

`openjiuwen/core/single_agent/rail/base.py`：

- `AgentCallbackContext.request_abort_stream()` / `consume_abort_stream()` / `has_abort_stream_request` — HITL 确认后请求打断进行中的 `llm.stream`。

`openjiuwen/core/single_agent/agents/react_agent.py`：

- 流式循环在 chunk 边界检查 abort 标志并 `aclose` provider stream。
- `_steering_queue` 从 kwargs 绑定到 callback context；`stream()` 转发 kwargs 到内部 `invoke`。
- 保留 tool interrupt 路径下补写 `UserMessage`（仅 system 消息时 LLM 请求合法）。

详见 [`../agent-core-rail-base修改说明.md`](../agent-core-rail-base修改说明.md)、[`../implementation_status.md`](../implementation_status.md)。

### 4. 检测与恢复能力（稳定范围）

- **repeat_tool**：重复 / 乒乓 / 未知工具调用检测，steering 或 notice 恢复。
- **llm_thinking_loop**：文本重复、plan-exec 语义停滞、超时等；可选语义 skill（`semantic_content_enabled=true`）。
- **流式**：对 `llm_output` / `llm_reasoning` 做窗口检测；`tool_calls.delta` 不参与 Rail 转发（仅 ReAct 内部消费）。
- **恢复**：本地 Recovery Engine 限流 + steering 注入；HITL yes/no 后 reopen 检测；空 HITL 回答默认按正常继续处理。

### 5. 测试与文档

- 系统 / 单元测试覆盖 RAS rail、stream observer、recovery HITL、deep_agent 单轮与 outer loop（steering 仍走 task_loop inputs，不在本分支改动范围）。
- `docs/agent_ras/`：实现状态、core 改动说明、llm_thinking_loop 方案等。

---

## 依赖 / 配套说明

- **企业侧配置键**：使用 `agent_ras`（替代旧 `execution_guard` / `reliability`）；jiuwenswarm `agent_reliability_dev` 需同步 YAML → `AgentRASConfig` 透传。
- **实验能力**：out-of-process / Messager 等位于 `agent_ras.experimental`，稳定 `AgentRASConfig` 会拒绝 process/transport 字段。
- **非 RAS 范围**：本分支可能合入 `enterprise-dev` 其他修复（如 tool interrupt UserMessage、evolution trajectory 等），与 Agent RAS 无直接耦合。

---

## 全量 UT（参考）

最近一次全量跑测（排除本地缺依赖的 4 个 collection 模块）：**8340 passed / 402 skipped / 3 failed**。

失败项均为环境 flaky，与 Agent RAS 无关：

- `test_backend_proxy_e2e.py` × 2 — proxy health check 超时
- `test_coding_memory.py::test_coding_memory_edit_updates_index_when_frontmatter_changes` — 目录残留污染

agent-ras / deep_agent / steering 相关用例全部通过。
