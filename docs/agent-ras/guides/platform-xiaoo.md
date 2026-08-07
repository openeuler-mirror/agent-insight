# xiaoO 平台接入

**原则**：CLI / TUI / daemon 任一入口，检测与恢复同档。走协议 inproc（`ras_embed`），**不**使用 daemon HTTP / SSE。

设计真源：[xiaoo-adapter.md](../designs/features/xiaoo-adapter.md)。  
细节：[INSTALL.md](../../../agent_ras/platform_adapter/xiaoo/INSTALL.md)。

## 最短路径

1. Insight setup curl 勾选 **xiaoO**，或 `node scripts/install-ras.js`  
   → runtime + hooker + `~/.config/xiaoo/config.toml` `[hooker].plugins`
2. 确保 subprocess IPC worker（install 后或首次 hook 拉起）：  
   `python -m platform_adapter.common.transport.subprocess_ipc`（socket 默认 `$AGENT_INSIGHT_RAS_HOME/ras_embed.sock`）  
   这是 **xiaoo 子进程 hook 嵌入方式**；OpenCode 走 inproc，不需要该 worker。
3. 按平时方式跑 xiaoO（`xiaoo --cli run` / TUI / daemon 均可）
4. Insight：`/agent-ras` 或 `GET /api/ingest/ras-events?platform=xiaoo`
5. 观测（OTel）：hooker 在会话 `idle`+完成 outcome 时向 `{Insight}/api/ingest/otel/v1/traces` 上报（与 RAS 共用 `config.json` 的 api_key；`session.id` = 裸 gateway session id，与 RAS `taskId` 对齐）。详情页即可出现完整链路。设计：[xiaoo-observe-ingest.md](../designs/features/xiaoo-observe-ingest.md)。

## 本地 harness / CLI E2E（无需 daemon HTTP）

```bash
cd agent_ras && PYTHONPATH=. python scripts/e2e_xiaoo_inproc_harness.py
cd agent_ras && PYTHONPATH=. python scripts/e2e_xiaoo_cli.py
cd agent_ras && PYTHONPATH=. python scripts/e2e_xiaoo_otel_upload.py
```
