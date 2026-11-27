# `src/lib/` — 分层代码组织

按 [Agent Insight 设计文档](../../docs/Agent_Insight_Design_Document.md) §3.1 的四层架构组织。

| 目录 | 对应层 | 职责 |
|---|---|---|
| `ingest/` | 数据采集层 (Layer 1) | OTel 接收、watcher、proxy 中转、上传节流、签名路由 |
| `storage/` | 数据存储层 (Layer 2) | Prisma 客户端、DB 适配器、Execution 写入/读取、服务端配置持久化 |
| `engine/observability/` | 核心引擎层 · 观测引擎 (模块一) | Trace 解析、流程对比、Agent 调用树构建、衍生指标 |
| `engine/evaluation/` | 核心引擎层 · 评测引擎 (模块二) | LLM-as-Judge、评分项解析、Dataset/Target 配置语义 |
| `engine/skills/` | 核心引擎层 · Skills 服务 (模块四) | Skill 注册、版本同步、benchmark 生成 |
| `auth/` | 跨层 · 鉴权 | 服务端 (`auth.ts`) + 客户端 React Context (`auth-context.tsx`) |
| `client/` | 用户界面层 (Layer 4) 辅助 | fetch 封装、locale/theme/Auth context、新手引导 hook |
| `shared/` | 跨层共享 | 模型默认配置、纯 util（`interaction-utils`） |

## 边界规则

- **下层不依赖上层**：`storage/` 不允许 import `engine/`；`engine/` 不允许 import 任何 `client/` 文件。
- **`shared/` 必须是 pure**：不依赖任何其他子目录，不引用 React/Next.js 运行时。
- **`auth/auth-context.tsx` 是唯一可以同时供前端 React 树与服务端组件 import 的文件**（凭借 `'use client'`）。
- **`client/` 一律 `'use client'`**：放任何使用 React hooks / window / document 的代码。
- **`ingest/` 内部不依赖 `engine/`**：采集只做"接住数据并持久化"，业务计算交给 engine 层异步触发。

## 路径别名

`@/lib/<layer>/<file>` —— 比如 `@/lib/storage/prisma`、`@/lib/engine/evaluation/judge`。所有跨子目录引用都使用绝对路径，避免 `../../` 形式。
