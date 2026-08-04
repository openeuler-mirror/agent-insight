# xiaoO upstream notes

Against **current** xiaoO (`/home/iceory/work/agent-reliability/xiaoO`):

| Capability | RAS 用法 |
|------------|----------|
| Shared gateway + `run_agent_loop` | 三端共用；RAS 挂此处 |
| `SessionRuntimeBindings` cancel / pending | Host：`abort_stream` / steer / notice |
| `LoopEventSink` + `FanoutLoopEventSink` | 流式 → `ras_embed` observe（非 SSE HTTP） |
| Plugin hooker (Chat / Tool / Session) | Signal 采点 |
| `HookAction` | 可扩展 `cancel_active_turn`；本地立即执行 |
| `POST /api/v1/runtimes/*` | **RAS 不依赖**（非观测/恢复路径） |

SessionHub 跨 hooker 子进程：agent-ras `ras_embed.ipc_worker`（unix socket）。
