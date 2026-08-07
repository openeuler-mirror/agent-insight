# xiaoO adapter — INSTALL

## Status

Protocol inproc L3（入口无关）：

- Shared factory: [`../common/protocol_client.py`](../common/protocol_client.py)
- Observe helpers: [`../common/observe.py`](../common/observe.py)
- Shared SessionHub across subprocess hooks: [`../common/transport/subprocess_ipc/`](../common/transport/subprocess_ipc/)（嵌入运输层；SessionHub 仍在 `ras_embed`）
- Embedding modes: [`../common/transport/`](../common/transport/) — `inproc`（OpenCode）vs `subprocess_ipc`（xiaoo）
- Hooks: [`hooks.py`](hooks.py) → `build_protocol_ras_client` + Host callables（cancel / pending，非 HTTP）
- Plugin hooker: [`hooker/`](hooker/)

## Prerequisites

- `xiaoo` on PATH（任意入口；**不**要求单独装 `xiaoo-daemon` 才能用 RAS）
- Agent RAS via Insight setup / `install-ras`（select **xiaoO**）
- LLM key in env when跑真实 agent

## Subprocess IPC worker

子进程 hooker 需共享同一 `SessionHub`（运输层，不是核心）：

```bash
export AGENT_INSIGHT_RAS_HOME=$HOME/.agent-insight/ras
RUNTIME=$(python3 -c "import json;print(json.load(open('$HOME/.agent-insight/ras/install.json'))['runtimeRoot'])")
export PYTHONPATH="$RUNTIME:$RUNTIME/.python-packages"
python -m platform_adapter.common.transport.subprocess_ipc
```

Hooker / 客户端通过环境变量 `RAS_EMBED_SOCK`（默认 `$AGENT_INSIGHT_RAS_HOME/ras_embed.sock`）连接。首次 hook 也会 `ensure_worker()` 自动拉起。

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
