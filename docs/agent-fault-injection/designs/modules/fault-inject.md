# 故障注入方式

| method | 机制 | 示例 |
|--------|------|------|
| `skill_inject` | 装 Skill + prompt | step-omission 等 |
| `file_tamper` | `injection_tools` steps | memory-file-loss |
| `prompt_modify` | runtime `system.append` | prompt-system-override |
| `tool_result_tamper` | runtime tool output 改写 | tool-result-corruption |
| `intercept_rewrite` | messages/assistant 改写 | interception-* |
| `route_manipulate` | 预留 | — |

证据打包为 `injectionEvidence`（structural + runtime）供服务端 Judge。
