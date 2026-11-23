# xiaoO ras-eval Hooker

Bundled with `agent-fault-injection`. Activated only when `AGENT_FI_RUN_ID`,
`AGENT_FI_FAULT_SKILL`, and `AGENT_FI_RAW_DIR` are set.

Hooks (compatible with installed xiaoO builds that reject Chat.* points):

- `*.Tool.*.pre` — until the fault skill activates, deny every tool except a
  matching `skill` call; after activation, allow all tools
- `*.Tool.*.post` — record tool events; on successful fault-skill load write
  `fault.activation.completed` and `fault-activated.json`

Activation pipeline parity with OpenCode (Web marker nodes):

1. `fault.activation.requested` — written by `XiaoOAdapter` when marking
   plugin-ready / injecting `--system` (xiaoO has no Chat.system.transform)
2. `fault.activation.started` — written by this hooker on first tool.pre gate
3. `fault.activation.completed` — written by this hooker after skill tool post

`plugin.json` command paths are rewritten to absolute paths by
`config_overlay.py` for each run.
