# agent_ras

Agent RAS（Reliability / Anomaly / Stewardship）：环内异常检测 + 恢复。

## 目录结构

```
core/                         # L0 平台无关核 + HostControl
ras_runtime/                    # L1 同进程门面
platform_adapter/
  common/                     # L2 ras_client + protocol_client
  openjiuwen/                 # L3 深适配
  opencode/                   # L3 薄插件
  xiaoo/                      # L3 Hooker + Daemon SSE
tests/
pyproject.toml
```

## 文档

统一入口：**[`docs/zh/explanation/reliability/agent-ras/`](../docs/zh/explanation/reliability/agent-ras/README.md)**

| 文档 | 说明 |
|------|------|
| [designs/architecture.md](../docs/zh/explanation/reliability/agent-ras/architecture.md) | 整体架构 |
| [designs/modules/](../docs/zh/explanation/reliability/agent-ras/modules/) | 模块设计 |
| [docs/zh/explanation/reliability/agent-ras/README.md](../docs/zh/explanation/reliability/agent-ras/README.md) | 文档入口与清单 |
| [guides/getting-started.md](../docs/zh/tutorial/reliability/agent-ras/01-getting-started.md) | 使用入门 |

## 使用

### openjiuwen（全量）

在已安装 openjiuwen / agent-core 的环境中：

```python
from platform_adapter.openjiuwen.factory import build_agent_ras_rail
```

详见 [guides/platform-openjiuwen.md](../docs/zh/how-to/reliability/agent-ras/platform-openjiuwen.md)。

### OpenCode

```bash
node scripts/install-ras.js
```

或 `npx agent-insight install-ras`。详见 [guides/platform-opencode.md](../docs/zh/how-to/reliability/agent-ras/platform-opencode.md) 与 [platform_adapter/opencode/INSTALL.md](platform_adapter/opencode/INSTALL.md)。

### xiaoO

```bash
node scripts/install-ras.js   # 同时写入 xiaoo hooker + config.toml
```

详见 [guides/platform-xiaoo.md](../docs/zh/how-to/reliability/agent-ras/platform-xiaoo.md)。

## 测试

```bash
pip install -e ".[dev]"
python3 -m pytest tests/unit_tests/ -q
```
