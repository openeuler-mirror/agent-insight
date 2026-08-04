# xiaoO 平台接入

**原则**：CLI / TUI / daemon 任一入口，检测与恢复同档。走协议 inproc（`ras_embed`），**不**使用 daemon HTTP / SSE。

设计真源：[xiaoo-adapter.md](../designs/features/xiaoo-adapter.md)。  
细节：[INSTALL.md](../../../agent_ras/platform_adapter/xiaoo/INSTALL.md)。

## 最短路径

1. Insight setup curl 勾选 **xiaoO**，或 `node scripts/install-ras.js`  
   → runtime + hooker + `~/.config/xiaoo/config.toml` `[hooker].plugins`
2. 确保 `ras_embed` 长驻 worker（install 后或首次 hook 拉起）：  
   `python -m ras_embed.ipc_worker`（socket 默认 `$AGENT_INSIGHT_RAS_HOME/ras_embed.sock`）
3. 按平时方式跑 xiaoO（`xiaoo --cli run` / TUI / daemon 均可）
4. Insight：`/agent-ras` 或 `GET /api/ingest/ras-events?platform=xiaoo`

## 本地 harness / CLI E2E（无需 daemon HTTP）

```bash
cd agent_ras && PYTHONPATH=. python scripts/e2e_xiaoo_inproc_harness.py
cd agent_ras && PYTHONPATH=. python scripts/e2e_xiaoo_cli.py
```
