# Agent Insight · 前后端重构

本分支用于逐步实现前后端分离。先从[主方案](design/platform/frontend-backend-separation/Agent-Insight前后端重构方案.md)了解调用关系，再按[模块接口与评审规则](docs/zh/how-to/platform/refactor-module-boundaries.md)添加代码。

| 目录 | 开发入口 |
| --- | --- |
| `apps/` | web 页面、server REST 接口层、设备侧 client |
| `packages/core/` | 观测、评测、诊断、优化、项目鉴权和 foundation。首批参考接口在[观测服务](packages/core/observation/trace-service.ts)和[设备命令](packages/core/foundation/device-commands/device-command-service.ts)。 |
| `extensions/` | 按所属模块和扩展类型登记实现 |
| `deploy/`、`scripts/` | 镜像、部署配置与开发脚本的目标位置 |
| `test/UT/`、`test/ST/` | 模块单测与端到端场景 |
| `design/`、`docs/` | 设计方案与开发指南 |
| [legacy/](legacy/) | 分支起点的完整旧项目，供查找原逻辑、测试和迁移依据。原项目的路径从此目录起算。 |

本阶段交付目录和 TypeScript 契约。空目录用 `.gitkeep` 纳入版本控制，页面、服务启动和部署文件随对应功能迁入。使用 TypeScript 5.9.3 在仓库根目录执行 `tsc -p tsconfig.contracts.json` 可验证当前接口。
