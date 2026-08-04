# Hermes adapter — INSTALL

## Status

L3 thin adapter scaffold: [`host_control.py`](host_control.py) + [`hooks.py`](hooks.py).
Wire native abort / notice / steer callables, then:

```python
from platform_adapter.hermes.hooks import build_hermes_ras_client

client, host = build_hermes_ras_client(
    abort_fn=...,
    notice_fn=...,
    steer_fn=...,
)
client.ensure()
client.hello("hermes:<session>", "hermes")
client.observe("hermes:<session>", {
    "platform": "hermes",
    "kind": "assistant_text",
    "text": "...",
    "mode": "snapshot",
})
```

Do **not** reimplement LoopDetector or runtime lifecycle. Insight ingest URL is
`/api/ingest/ras-events` (flat JSON + required `deliveryId`).

## Prerequisites

Python 3.10+ and `pip install -e .`. Agent Insight setup may run
`install-ras` when Hermes is selected so `~/.agent-insight/ras` is ready.

## Capability

See [docs/agent-ras/designs/modules/platform-adapter.md](../../../docs/agent-ras/designs/modules/platform-adapter.md).
