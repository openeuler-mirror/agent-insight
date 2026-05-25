# `src/app/api/` — 按 Agent Insight 分层组织

按 [Agent Insight 设计文档](../../../docs/Agent_Insight_Design_Document.md) §3.1 的 4 层架构组织 API 路由。

| 子目录 | 对应层 | 包含端点 |
|---|---|---|
| `auth/` | 认证 | `apikey`、`organization` |
| `guide/` | UI helper | 用户引导状态读写 |
| `ingest/` | **数据采集层 (Layer 1)** | OTel 接收 (`otel/v1/{traces,logs,metrics}`)、proxy 中转、upload、setup 安装脚本、sync、document 解析、SDK v1 透传 |
| `observe/` | **观测引擎 (Layer 3)** | execution 查询 (`data`)、session 详情、execution 流程匹配、task-stats |
| `eval/` | **评测引擎 (Layer 3)** | 模型配置 (`settings`)、连接测试 (`settings/test`)、重新评测 (`rejudge`)、评测引擎调用 (`evaluation`)、Dataset 配置 (`config*`) |
| `skills/` | **Skills 服务 (Layer 3)** | 注册、版本管理、benchmark 生成、企业同步 |

## 向后兼容

`next.config.ts` 配置了 rewrites，把旧的扁平路径自动映射到新路径：

| 旧路径 | 新路径 |
|---|---|
| `/api/otel/v1/*` | `/api/ingest/otel/v1/*` |
| `/api/proxy/*` | `/api/ingest/proxy/*` |
| `/api/upload`, `/api/setup`, `/api/sync/*`, `/api/parse-document`, `/api/v1/*` | `/api/ingest/*` |
| `/api/data`, `/api/session`, `/api/executions/*`, `/api/task-stats` | `/api/observe/*` |
| `/api/settings*`, `/api/rejudge`, `/api/evaluation`, `/api/config*` | `/api/eval/*` |

外部客户端（OpenCode 插件、watchers、OTel collectors、SDK）继续使用旧路径不会报错。前端 `apiFetch()` 已统一改用新路径。

## 添加新端点

把文件放到对应层的子目录里：
- 任何**接收外部数据**的入口 → `ingest/`
- 任何**查询执行轨迹 / 会话**的端点 → `observe/`
- 任何**评测、评分、配置**相关 → `eval/`
- Skills CRUD → `skills/`

不要在 `src/app/api/` 顶层新增端点（除非是认证或 UI helper）。
