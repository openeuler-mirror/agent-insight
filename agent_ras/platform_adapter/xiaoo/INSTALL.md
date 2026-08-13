# xiaoO adapter — INSTALL

Protocol inproc L3 + Daemon SSE（stock master）。`tool_post` 不得 hello；plugin hooker Host unwired。

约束见 [opencode-xiaoo-integration.md](../../../docs/agent-ras/designs/features/opencode-xiaoo-integration.md) §4；操作见 [`platform-xiaoo.md`](../../../docs/agent-ras/guides/platform-xiaoo.md)。

## 文件地图

- Shared factory: [`../common/protocol_client.py`](../common/protocol_client.py)
- Observe helpers: [`../common/observe.py`](../common/observe.py)
- Daemon client/session: [`daemon_client.py`](daemon_client.py) / [`daemon_session.py`](daemon_session.py)
- Shared SessionHub across subprocess hooks: [`../common/transport/subprocess_ipc/`](../common/transport/subprocess_ipc/)
- Hooks: [`hooks.py`](hooks.py) — `build_xiaoo_daemon_host_fns`
- Plugin hooker: [`hooker/`](hooker/)

## Daemon 闭环

```bash
xiaoo-daemon --host 127.0.0.1 --port 18080
cd agent_ras
PYTHONPATH=. python scripts/e2e_xiaoo_daemon_harness.py
XIAOO_DAEMON_URL=http://127.0.0.1:18080 PYTHONPATH=. python scripts/e2e_xiaoo_daemon_harness.py
```

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

## Hooker

`install-ras` 复制 `hooker/` → `~/.agent-insight/ras/xiaoo/hooker/`，并合并 `~/.config/xiaoo/config.toml` `[hooker].plugins`。
