# xiaoO 平台接入

**原则**：检测与恢复走协议 inproc（`ras_runtime`）。stock master 上 mid-stream 思考/工具环与 abort/steer 以 **官方 Daemon SSE 控制面** 为主；插件 hooks 仍负责 Chat/Tool/lifecycle。**不改 FI**。

设计真源：[xiaoo-adapter.md](../designs/features/xiaoo-adapter.md)。  
细节：[INSTALL.md](../../../agent_ras/platform_adapter/xiaoo/INSTALL.md) · [UPSTREAM.md](../../../agent_ras/platform_adapter/xiaoo/UPSTREAM.md)。

## 最短路径

1. Insight setup 勾选 **xiaoO**，或 `node scripts/install-ras.js`（本机过程见 [local-install-process.md](local-install-process.md)）  
2. 确保 subprocess IPC worker：`python -m platform_adapter.common.transport.subprocess_ipc`  
3. **Daemon 闭环（推荐验收）**：启动 stock `xiaoo-daemon`（默认 `0.0.0.0:18080`），用 RAS 自有客户端持有 lease：
   ```bash
   cd agent_ras && PYTHONPATH=. python scripts/e2e_xiaoo_daemon_harness.py
   # 可选 live：
   XIAOO_DAEMON_URL=http://127.0.0.1:18080 PYTHONPATH=. python scripts/e2e_xiaoo_daemon_harness.py
   ```
4. CLI hooks 路径仍可用（tool/chat）；无 mid-stream thinking cancel 时勿宣称与 Daemon 同档  
5. Insight：`/agent-ras` 或 `GET /api/ingest/ras-events?platform=xiaoo`

## 验收故障

| 场景 | 说明 |
|------|------|
| `tool_repeat_dead_loop` submode **2**（unknown） | 连续失败 tool ≥10 → 检出 + cancel/恢复 |
| `thinking-dead-loop` | `text_delta`/`thinking_delta` → `llm_thinking_loop` + 恢复 |

## 本地 harness

```bash
cd agent_ras && PYTHONPATH=. python scripts/e2e_xiaoo_inproc_harness.py
cd agent_ras && PYTHONPATH=. python scripts/e2e_xiaoo_daemon_harness.py
cd agent_ras && PYTHONPATH=. python scripts/e2e_xiaoo_cli.py
```
