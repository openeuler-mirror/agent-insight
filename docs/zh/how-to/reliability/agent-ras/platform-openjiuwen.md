---
title: "openjiuwen / jiuwenclaw 接入"
description: "说明在 openjiuwen 和 jiuwenclaw 中启用 Agent RAS 深度挂载与检测恢复配置的方法。"
keywords: ["Agent RAS", "openjiuwen", "jiuwenclaw", "异常恢复"]
changefreq: monthly
---

<a id="openjiuwen-/-jiuwenclaw-接入"></a>
<a id="openjiuwen--jiuwenclaw-接入"></a>
深挂载：L3 Rail 直连 L0，流内 abort / steer / notice；thinking-loop 含 L3 自动 Reviewer。

## 架构

```mermaid
flowchart LR
  YAML[config_yaml] --> Factory[create_deep_agent]
  Factory --> Rail[AgentRASRail]
  Rail --> Mon[Monitor]
```

## 启用

1. 依赖已安装的 openjiuwen / agent-core（含 abort 流契约）。
2. 代码路径：`create_deep_agent(agent_ras=AgentRASConfig(...))` 或等价工厂。
3. jiuwenclaw：在资源 `config.yaml` 增加 `agent_ras` 段，由 adapter 透传，不访问 Rail 私有字段。

## 配置片段示例

```yaml
agent_ras:
  enabled: true
  detectors:
    repeat_tool:
      enabled: true
      warning_threshold: 5
      critical_threshold: 10
      global_breaker_threshold: 10
      unknown_tool_threshold: 10
    llm_thinking_loop:
      enabled: true
      semantic_content_enabled: true
      detection_start_chars: 30000
      window_max_chars: 2000
      loop_repeat_threshold: 5
      similar_clause_sim_threshold: 0.95
      semantic_eval_chars: 10000
  recovery:
    notify_user_on_warning: true
```
