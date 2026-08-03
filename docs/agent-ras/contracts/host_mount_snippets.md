# 宿主挂载点索引

摘录自 jiuwenswarm_enterprise 源树（路径相对该 monorepo）。本仓 代码树（`agent_ras/` + `rails/`） 为镜像拷贝，**当前仍按 openjiuwen import 路径设计**；独立安装尚未落地。

## 1. Factory 自动挂载（一等入口）

文件：`agent-core/openjiuwen/harness/factory.py`

```python
def _normalize_agent_ras_config(
    agent_ras: AgentRASConfig | dict[str, Any] | bool | None,
) -> AgentRASConfig | None:
    # None / True  → 默认 enabled
    # False        → 不挂载
    # dict / AgentRASConfig → model_validate；enabled=false 则不挂载
    ...

# create_deep_agent(...) 末尾 default_rails：
# (AgentRASRail, normalized_agent_ras is not None, _make_agent_ras_rail)
# → build_agent_ras_rail(...) → agent.add_rail(...)
```

手动挂载等价写法：

```python
from openjiuwen.harness.agent_ras.factory import build_agent_ras_rail

rail = build_agent_ras_rail(config, agent_name, model=model)
agent.add_rail(rail)
```

## 2. jiuwenclaw YAML 透传

文件：`jiuwenswarm_enterprise/jiuwenclaw/agentserver/deep_agent/interface_deep.py`

- `_agent_ras_kwargs_from_config(config_base)`：读取 `config_base["agent_ras"]`，`AgentRASConfig.model_validate` 后返回 `{"agent_ras": validated.model_dump(...)}`。
- 模块缺失时降级为空 dict（带 warning），不阻塞 adapter 启动。
- 调用点：构造 `create_deep_agent` / `create_code_agent` 的 `common_kwargs.update(...)`。

YAML 示例：[`examples/jiuwenclaw_agent_ras.yaml`](../examples/jiuwenclaw_agent_ras.yaml)。

## 3. Rail 生命周期钩子

文件：`rails/agent_ras_rail.py`（源：`harness/rails/agent_ras_rail.py`）

| 钩子 | 行为 |
|------|------|
| `before_invoke` | `Monitor.start`；`StreamObserver.attach` |
| tool / model / exception 钩子 | `signal_builder` → `Monitor.handle` |
| `before_model_call` | bind steering queue；deferred notice |
| `after_model_call` | finalize stream recovery（L3 fail-open） |
| `after_invoke` | detach observer；`Monitor.stop`；清 cache |

## 4. 流观测挂载

文件：`agent_ras/stream_observer.py`

- `Runner.callback_framework.register("{session_id}write_stream", ...)`
- priority ≈ 100；在真正写入前端前转发 `Monitor.on_stream_chunk`
- 可 suppress 截断可见 chunk；确认异常后走 abort 契约

## 5. 稳定公共 API

包：`openjiuwen.harness.agent_ras`（本仓镜像：`agent_ras/__init__.py`）

- 立即导出：`AgentRASConfig`、`Signal` / `Anomaly` / 相关枚举、`Detector`、`RecoveryAction`
- 懒加载：`AgentRASRail`、`build_agent_ras_rail`

权威状态：[`guides/implementation_status.md`](../guides/implementation_status.md)。
