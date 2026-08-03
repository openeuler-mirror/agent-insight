# Windows Case C 端到端验收清单

在 Windows sidecar 环境验证 L3 语义检测 + HITL 全链路（async recovery 框架修复后）。

## 前置条件

1. 重启 sidecar，确认 editable install 加载最新 `agent-core`。
2. **仅改本机运行时配置**（临时验证用，不要改仓库 `resources/config.yaml` 默认值）：

路径：`C:\Users\<user>\.office-claw\.jiuwenclaw\config\config.yaml`

```yaml
agent_ras:
  enabled: true
  detectors:
    llm_thinking_loop:
      enabled: true
      semantic_content_enabled: true
      # 小阈值便于测试（仓库默认 30000 / 2000 / 10000）
      detection_start_chars: 2000
      window_max_chars: 2000
      semantic_eval_chars: 2000
  recovery:
    notify_user_on_warning: true
```

验收后把上述阈值改回仓库默认语义，或删除该临时 override 段。

注意：键名必须是现行 `agent_ras`（不是旧的 `reliability`）。

## 日志路径

`C:\Users\<user>\.office-claw\.jiuwenclaw\service_default\.logs\openjiuwen\run\jiuwen.log`

## 通过标准（按顺序）

1. `[AgentRASRail] agent_team warmup done roles=...`
2. detection member 最终 `invoke` **output 含 JSON**（`abnormal` + `primary_fault`；对齐 auto_harness 范式，不再依赖 `skill_complete(report=...)`）
3. `[AgentRASRail] after_invoke pending_set=True` 或流式 L1/L2 / L3 命中后 `complete_hitl`
4. HITL：优先走宿主 `ask_user_question`（前端确认框 / `source=ask_tool`），用户答否后有 recovery steering；无该工具时才 AskUser interrupt fallback
5. 主 Agent stop **早于** L3 完成时仍能触发 HITL

## 失败分流

| 日志现象 | 排查方向 |
|----------|----------|
| 无 warmup 日志 | sidecar 是否加载新代码 |
| `skill_complete` 有 JSON 但 `pending_set=False` | 旧契约：verdict 在 tool metadata 未进 invoke output；确认已部署 SKILL 新格式（最终 assistant 只输出 JSON） |
| `pending_set=False` 且无 detection JSON output | adapter 从 `result["output"]` 解析失败；查 detection member 最后一轮是否为纯 JSON |
| `pending_set=False` | async recovery 是否超时；查 `[async_recovery] timed out` |
| `pending_set=True` 无确认框，只有「审批待处理」 | 仍走了 `__interaction__` fallback；查 `ask_user_question` 是否已注册到 resource_mgr；日志是否有 `ask_user_question invoke failed` |
| HITL asked 无 steering | `primary_fault` 文案路径 / 用户选了「正常继续」 |
| ValidationError on `thinking_timeout_minutes=0` | 确认 sidecar 加载了允许 `ge=0` 的 agent-core |

## 超时诊断

若出现 `[AgentRASRail] async recovery timed out` 或 `[async_recovery] timed out waiting for detectors`：

- 内部超时固定为 `ASYNC_RECOVERY_TIMEOUT_SECONDS`（60s）与 `SKILL_TIMEOUT_SECONDS`（30s），均不可配；排查 L3 skill 是否挂死
- 确认 detection member 是否在超时前产出 JSON 终答
