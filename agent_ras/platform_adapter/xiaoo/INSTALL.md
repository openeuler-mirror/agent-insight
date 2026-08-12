# xiaoO adapter — INSTALL

## Status

Protocol inproc L3 + **Daemon SSE control plane**（stock master）：

- Shared factory: [`../common/protocol_client.py`](../common/protocol_client.py)
- Observe helpers: [`../common/observe.py`](../common/observe.py)
- Daemon client/session: [`daemon_client.py`](daemon_client.py) / [`daemon_session.py`](daemon_session.py)
- Shared SessionHub across subprocess hooks: [`../common/transport/subprocess_ipc/`](../common/transport/subprocess_ipc/)
- Hooks: [`hooks.py`](hooks.py) — sock Host（遗留）+ `build_xiaoo_daemon_host_fns`
- Plugin hooker: [`hooker/`](hooker/) — `tool_post` **不得** hello

**FI 库零改动；FI Worker 不启动 RAS**（见 [`UPSTREAM.md`](UPSTREAM.md)）。

## Prerequisites

- `xiaoo` / `xiaoo-daemon` on PATH（Daemon 闭环验收需要 daemon）
- Agent RAS via Insight setup / `install-ras`（select **xiaoO**）
- LLM key when跑真实 agent turn

## Daemon 闭环

```bash
xiaoo-daemon --host 127.0.0.1 --port 18080
cd agent_ras
PYTHONPATH=. python scripts/e2e_xiaoo_daemon_harness.py
XIAOO_DAEMON_URL=http://127.0.0.1:18080 PYTHONPATH=. python scripts/e2e_xiaoo_daemon_harness.py
```

SSE→Signal 覆盖：`text_delta` / `thinking_delta` → thinking loop；`tool_result`（`is_error`）→ `unknown_tool_repeat`。恢复：`cancel` + 再 `input`。

## Subprocess IPC worker

```bash
export AGENT_INSIGHT_RAS_HOME=$HOME/.agent-insight/ras
RUNTIME=$(python3 -c "import json;print(json.load(open('$HOME/.agent-insight/ras/install.json'))['runtimeRoot'])")
export PYTHONPATH="$RUNTIME:$RUNTIME/.python-packages"
python -m platform_adapter.common.transport.subprocess_ipc
```

## Inproc harness

```bash
cd agent_ras
PYTHONPATH=. python scripts/e2e_xiaoo_inproc_harness.py
```

## Hooker install

`install-ras` copies `hooker/` → `~/.agent-insight/ras/xiaoo/hooker/` and merges
`~/.config/xiaoo/config.toml` `[hooker].plugins`.

## Capability

See [docs/agent-ras/designs/features/xiaoo-adapter.md](../../../docs/agent-ras/designs/features/xiaoo-adapter.md).
