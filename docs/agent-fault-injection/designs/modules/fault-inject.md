# 故障注入方式

| method | 机制 | 示例 |
|--------|------|------|
| `skill_inject` | 装 Skill + prompt | step-omission 等 |
| `file_tamper` | `injection_tools` file ops（`apply_plan`） | memory-file-loss |
| `prompt_modify` | runtime `system.append`（`rewrite_engine`） | prompt-system-override |
| `tool_result_tamper` | runtime tool output 改写 | tool-result-corruption |
| `intercept_rewrite` | messages/assistant 改写 | interception-* |
| `route_manipulate` | 预留 | — |

分层：`injection_tools` 只做副作用（返回结构化结果 / 平台事件）；catalog `fault.json` 定义 plan；`apply_plan` / `runtime_env` 为薄胶水。

可选 `injectionEvidence`（structural + runtime）随 `collect-result` 上传；服务端 Judge **以轨迹为主**，证据缺省非必要。详见 [runtime-middleware-fault-injection.md](../runtime-middleware-fault-injection.md)。
