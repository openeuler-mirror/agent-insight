# `base.py` / `react_agent.py` 修改说明（Agent RAS Stream）

## 1. 报告目的与范围

说明相对 `enterprise-dev`，Agent RAS 为「打断进行中的 `llm.stream`」在 core 侧的**最小**改动，涉及：

- [`openjiuwen/core/single_agent/rail/base.py`](../../openjiuwen/core/single_agent/rail/base.py)
- [`openjiuwen/core/single_agent/agents/react_agent.py`](../../openjiuwen/core/single_agent/agents/react_agent.py)

流式监测、截断与自动恢复 **不**扩展 core Rail 事件，由 harness 侧完成（见第 5 节）。本文只描述上述两个文件的契约与调用改动。

### 1.1 为何必须打断 `llm.stream`

多数 Agent 异常（工具死循环、策略失败、轮次级纠偏）发生在 **一次 model_call 已经结束之后**：下一轮工具 / 下一轮 `llm.stream` 之前，可用 `force_finish`、steering、`abort` 会话等手段收束。**LLM 思考死循环不同**——故障就嵌在**当前这一次尚未结束的** `llm.stream` 里：

| 对比 | 典型工具/轮次异常 | LLM 思考死循环（Case A/B/C） |
|------|-------------------|------------------------------|
| 故障落点 | model_call **之间** 或 tool 之后 | **单次** `llm.stream` **内部**持续吐字 |
| 自然终点 | 有 tool_calls / finish_reason，流会结束 | 往往**没有**可收敛的 finish；provider 会一直推 chunk |
| 仅靠「等流结束再处理」 | 通常可接受 | 前端一直刷字、reasoning 无限加长，token 持续空转 |
| 仅靠 `force_finish` / 会话 `abort` / `close_stream` | 常够用 | **挡不住**已在飞行中的 provider 流 |

因此：检测与自动恢复可以在 harness 完成，但一旦确认「异常」，必须有一条 core 契约能在 **chunk 边界**协作式退出并尽量 `aclose` 当前 `llm.stream`——否则「已判定死循环」与「provider 仍在烧 token」会长期并存。这就是本文对 `base.py` / `react_agent.py` 做最小改动的直接原因；场景细节见 [`llm_thinking_loop_方案说明.md`](./llm_thinking_loop_方案说明.md)。

## 2. 对比基准与改动概览

修改必要性：无限 / 异常输出场景下，自动恢复确认「异常」后必须尽快停住 provider 的 `llm.stream`；现有 `force_finish` / `abort` / `close_stream` 做不到这一点，因此需要在 callback 上下文上增加协作式 abort 信号，并由 ReAct 流循环在 chunk 边界消费。

| 文件 | 相对 `enterprise-dev` 的改动 |
|------|------------------------------|
| `base.py` | 在 `AgentCallbackContext` 上增加「请求打断当前 `llm.stream`」的标志与读写 API（`request_abort_stream` / `consume_abort_stream` / `has_abort_stream_request`） |
| `react_agent.py` | 流式调用 LLM 时，每个 chunk 前后检查上述 abort 标志；一旦置位则跳出循环并尽量 `aclose` 关闭 provider 流（写出方式仍是原来的 `session.write_stream`） |

## 3. `base.py`：abort 流三件套

在 `AgentCallbackContext` 中新增：

- `_abort_stream` 内部标志
- `request_abort_stream()`：请求在当前 / 下一 chunk 边界打断进行中的 `llm.stream`
- `consume_abort_stream()`：读取并清除 pending 标志
- `has_abort_stream_request`：是否仍有 pending abort

**必要性：** `force_finish`、`DeepAgent.abort`、`close_stream` 均无法打断已在进行的 `llm.stream`。自动恢复确认异常后，Monitor 调用 `request_abort_stream()`；ReActAgent 在 chunk 边界感知并退出循环。

不新增 Rail 事件或 `AgentRail` 钩子；steering 相关 API（`bind_steering_queue` / `push_steering` 等）沿用 `enterprise-dev` 已有实现。

## 4. `react_agent.py`：流循环响应 abort

在 `_railed_model_call` 的 streaming 路径中：

1. 将 `llm.stream(...)` 赋给 `stream_iter`，再 `async for chunk in stream_iter`
2. **每个 chunk 处理前**：若 `ctx.has_abort_stream_request`，则 `consume_abort_stream()`、标记 aborted、`break`
3. chunk 内容仍通过 `session.write_stream(OutputSchema(...))` 写出（与 `enterprise-dev` 一致）
4. **每个 chunk 处理后**：再次检查 abort（覆盖「本 chunk 写出期间」由恢复逻辑置位的情况）
5. `finally`：若已 abort 且 iterator 支持 `aclose`，则调用以尽量关闭 provider 流

**归属区分（勿混）：**

| 层级 | 内容 | 归属 |
|------|------|------|
| 语言标准 | `stream_iter.aclose()` | **Python 异步生成器标准方法**，非本仓库/本分支造的 API |
| 仓库既有 | `llm.stream` async generator；写出仍走 `session.write_stream`；客户端 `finally` 关 HTTP | **相对 `enterprise-dev` 已有** |
| 本分支新增 | abort 三件套 + 流循环检查标志并在 abort 后主动 `aclose` | **相对 `enterprise-dev` 的最小停流改动** |

**必要性：** 仅有 `base.py` 上的 abort 标志不够，必须在真正消费 `llm.stream` 的循环里读取并退出，否则恢复置位后 provider 仍会无限吐 token；写出路径保持 `session.write_stream`，以便 harness `StreamObserver` 继续做监测/截断。

**行为边界：** abort 是协作式的，仅在 chunk 边界生效；置位后可能再吐出少量 token，属预期。

## 5. 与 harness 的衔接（不改本文两个文件的职责）

```
# 监测 / 截断
react_agent.py
  → session/agent.py::Session.write_stream(output)
      → runner callback: trigger("{session_id}write_stream")   # writer.write 之前
          → harness/agent_ras/stream_observer.py::StreamObserver
              → harness/agent_ras/monitor.py::Monitor.on_stream_chunk
      → stream writer 真正写出 stream_data

# 停流（自动恢复确认异常：L1/L2 直恢复或 L3 Reviewer 确认）
harness/agent_ras/monitor.py
  → rail/base.py::AgentCallbackContext.request_abort_stream()
  → react_agent.py 在 chunk 边界 break + aclose
```

监测挂载、steering queue 绑定由 `harness/rails/agent_ras_rail.py`（`AgentRASRail`）与 `stream_observer.py` 负责，不要求 `deep_agent` 或 `react_agent` 为 RAS 额外传 queue。

## 6. 结论

相对 `enterprise-dev`，core 仅为 Agent RAS 提供「停流」契约：`base.py` 提供信号，`react_agent.py` 在流循环中消费信号。监测与自动恢复留在 harness，避免扩展通用 Rail 事件面。`request_abort_stream` 的 core 契约无需为本改造再扩展。
