# xiaoO 平台适配（入口无关 / 协议 inproc）

版本：v0.4  
状态：已落地（协议 inproc；HTTP/SSE 已移除；xiaoO shared 注入 + inproc/CLI E2E）  
关联：[`architecture.md`](../architecture.md)、[`platform-adapter.md`](../modules/platform-adapter.md)、[`guides/platform-xiaoo.md`](../../guides/platform-xiaoo.md)

## 1. 目标与原则

为 xiaoO（CLI / TUI / daemon 任一入口）接入 agent-ras，能力同档。

| # | 原则 |
|---|------|
| P1 | 检测/恢复只在 `core` + `ras_embed`；L3 禁止复制策略 |
| P2 | **入口无关**：差异只在 Host callable 接线，不在 Detector |
| P3 | 对齐协议 inproc：hooks → `RasClient` → `SessionHub` → wire → `apply_wire_actions` → `CallableHostControl` |
| P4 | 多平台复用进 `common` / `ras_embed`；`xiaoo/` 仅 hook 映射 + Host 三函数 |
| P5 | **不**使用 daemon HTTP / SSE 作为观测或恢复路径 |

## 2. 架构

```mermaid
flowchart LR
  Entry[CLI_TUI_Daemon] --> GW[xiaoO_shared_gateway]
  GW -->|hooks_plus_FanoutSink| Embed[ras_embed_SessionHub]
  Embed -->|wire| Apply[apply_wire_actions]
  Apply --> Host[CallableHostControl]
  Host -->|cancel_pending| GW
  Embed -->|insight_push| Insight[AgentInsight]
```

- 装配：[`build_protocol_ras_client`](../../../agent_ras/platform_adapter/common/protocol_client.py)
- 子进程 hook 共享 SessionHub：[`ras_embed` IPC worker](../../../agent_ras/ras_embed/ipc_worker.py)（平台中性，非 xiaoo 私有 sidecar）
- 流式：gateway `LoopEventSink` fan-out → 同一 embed `observe`

## 3. L3 边界（薄）

| 保留 | 职责 |
|------|------|
| `hooker/` | Chat / Tool / lifecycle → hello / observe / reset |
| `hooks.py` | `build_xiaoo_ras_client` → common 工厂 + Host callables |
| `host_control.py` | `CallableHostControl` 薄别名 |

不设：HttpHost、SSE 泵、平台私有 Host 族、xiaoo/sidecar。

## 4. 采点映射

| 来源 | Signal |
|------|--------|
| `*.Session.lifecycle.created` / Chat received | `hello` |
| `*.Tool.*.post` | `kind=tool`, `phase=after` |
| LoopEventSink reasoning / message | `assistant_text` / `llm_reasoning` \| `llm_output` |
| Session closed-like | `reset` |

Session id：`xiaoo:{gateway_session_id}`。

## 5. HostControl

| wire | 投递 |
|------|------|
| `abort_stream` | gateway `cancel_token` / `CancelActiveTurn` |
| `emit_notice` / `push_steering` | `pending_user_messages`（可见 `[RAS]` 前缀可选） |

## 6. 门禁

| # | 通过条件 |
|---|----------|
| A | setup 可选 xiaoo；不强制 daemon |
| B | 进程内 Sink / hook → `llm_*` / tool observe |
| C | 真实重复 tool / thinking-loop |
| D | abort / notice / steer 生效 |
| E | Insight `platform=xiaoo` |
| F | CLI 与其它入口同档（无 HTTP/SSE） |
| G | 单测 / harness 通过 |
