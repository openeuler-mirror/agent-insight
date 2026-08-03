# agent_ras

Agent RAS（Reliability / Anomaly / Stewardship）：环内异常检测 + 恢复。

## 目录结构

```
core/                         # L0 平台无关核 + HostControl
ras_embed/                    # L1 同进程门面
platform_adapter/
  common/                     # L2 ras_client (js/py)
  openjiuwen/                 # L3 深适配
  opencode/                   # L3 薄插件
  openclaw/ hermes/           # L3 骨架
tests/
pyproject.toml
```

## 文档

统一入口：**[`docs/agent-ras/`](../docs/agent-ras/README.md)**（架构、需求设计、专题、参考与示例）。

| 文档 | 说明 |
|------|------|
| [docs/agent-ras/architecture/ras_architecture.md](../docs/agent-ras/architecture/ras_architecture.md) | **整体架构（四层）** |
| [docs/agent-ras/architecture/capability_matrix.md](../docs/agent-ras/architecture/capability_matrix.md) | 多平台能力矩阵 |
| [docs/agent-ras/design/package-baseline/](../docs/agent-ras/design/package-baseline/) | 包级需求分析与开发计划 |
| [docs/agent-ras/design/inproc-package-migration/](../docs/agent-ras/design/inproc-package-migration/) | 迁入 AgentInsight 设计与清单 |
| [docs/agent-ras/design/](../docs/agent-ras/design/README.md) | 全部需求设计索引 |
| [docs/agent-ras/guides/implementation_status.md](../docs/agent-ras/guides/implementation_status.md) | 实现状态（权威） |

## 使用

### openjiuwen（全量）

在已安装 openjiuwen / agent-core 的环境中：

```python
from platform_adapter.openjiuwen.factory import build_agent_ras_rail
```

### OpenCode

在 Agent Insight 仓库根目录执行以下命令安装 OpenCode 插件（bun:ffi inproc 模式）：

```bash
node scripts/install-ras.js
```

npm 用户使用 `npx agent-insight install-ras`。安装器会把运行时复制到
`~/.agent-insight/ras/runtime/`，不会让 OpenCode 引用源码仓或临时 npx 缓存。
RAS 只以同进程方式运行；不会启动本地服务、监听端口或创建独立守护进程。
详见 [platform_adapter/opencode/INSTALL.md](platform_adapter/opencode/INSTALL.md)。

## 测试

```bash
pip install -e ".[dev]"
python3 -m pytest tests/unit_tests/ -q
```
