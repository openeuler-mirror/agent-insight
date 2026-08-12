# 快速开始

在宿主中启用 Agent RAS（环内检测 + 恢复）的最短路径。

```mermaid
flowchart LR
  Pick[Choose_platform] --> Install[Install_or_dependency]
  Install --> Config[Enable_config]
  Config --> Run[Run_agent]
  Run --> Observe[Optional_Insight_UI]
```

| 平台 | 下一步 |
|------|--------|
| openjiuwen / jiuwenclaw | [platform-openjiuwen.md](platform-openjiuwen.md) |
| OpenCode | [platform-opencode.md](platform-opencode.md) |
| xiaoO | [platform-xiaoo.md](platform-xiaoo.md) |
| 配置项说明 | [configuration.md](configuration.md) |
| **安装命令本机过程**（curl / `install-ras` 逐步） | [local-install-process.md](local-install-process.md) |

架构与模块：[../designs/architecture.md](../designs/architecture.md)。  
源码包说明：[`agent_ras/README.md`](../../../agent_ras/README.md)。
