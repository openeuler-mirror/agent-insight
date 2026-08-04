# openclaw adapter — INSTALL

## Status

L3 thin adapter scaffold: [`host_control.py`](host_control.py) + [`hooks.py`](hooks.py).
Reuse shared client — **do not** copy detection algorithms.

```python
from platform_adapter.openclaw.hooks import build_openclaw_ras_client

client, host = build_openclaw_ras_client(
    abort_fn=...,
    notice_fn=...,
    steer_fn=...,
)
client.ensure()
client.hello("openclaw:<session>", "openclaw")
client.observe("openclaw:<session>", {
    "platform": "openclaw",
    "kind": "assistant_text",
    "text": "...",
    "mode": "snapshot",
})
```

For JS hosts, import `platform_adapter/common/ras_client.js` the same way OpenCode does,
and implement a Host with `requestAbortStream` / `emitUserNotice` / `pushSteering`
returning optional `delivery_anchor`.

Insight ingest: `POST /api/ingest/ras-events` (flat + required `deliveryId`).

## Prerequisites

Python 3.10+:

```bash
pip install -e .
```

Agent Insight setup may run `install-ras` when OpenClaw is selected.

## Capability

See [docs/agent-ras/designs/modules/platform-adapter.md](../../../docs/agent-ras/designs/modules/platform-adapter.md).
