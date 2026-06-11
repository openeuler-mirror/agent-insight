# Modules

> 该代码库共有 12 个顶层模块。下文的分级来自跨模块 fan-in（`moduleRanking`）：跨模块入度越高 = 越核心。请先阅读核心模块。

## Core vs peripheral
| Module | Dir | Tier | Functions | Fan-in | Depends on | Depended on by |
|---|---|---|---|---|---|---|
| `lib` | `src/lib/` | **core** | 992 | 1882 | prompts, server | app, components, providers, scripts, server |
| `server` | `src/server/` | **core** | 50 | 122 | lib | app, lib, scripts |
| `prompts` | `src/prompts/` | **core** | 14 | 14 | — | app, lib |
| `components` | `src/components/` | shared | 697 | 375 | hooks, lib, providers | app |
| `providers` | `src/providers/` | shared | 9 | 13 | lib | components |
| `hooks` | `src/hooks/` | shared | 2 | 3 | — | components |
| `app` | `src/app/` | edge | 688 | 491 | components, lib, prompts, server | — |
| `scripts` | `scripts/` | edge | 82 | 84 | lib, server | — |
| `public` | `public/` | edge | 5 | 5 | — | — |
| `tools` | `tools/` | edge | 5 | 3 | — | — |
| `test` | `test/` | edge | 5 | 1 | — | — |
| `(root)` | generated `.next` types | edge | 2 | 0 | — | — |

> 注意：`app` 拥有最大的 fan-in（491），但来自其他模块的入度为 0 —— 它是最顶层的消费者（路由/页面），而非被依赖项。真正的领域核心是 `lib`（+ `server`），其余一切都依赖于它。

## `lib` (`src/lib/`) — core domain engine + shared infrastructure
系统的枢纽。大部分业务逻辑都在这里。主要子区域：
- **`engine/`** —— 领域引擎，按能力组织：
  - `agent-debug/` —— 失败根因分析（`AgentDebugReportPayload`，step/issue/triage 模型）。驱动故障诊断。
  - `evaluation/` —— 评测核心：`judge.ts`（LLM 评判）、`trajectory-evaluator.ts`、`custom-llm-evaluator.ts`、`semantic-dataset-match.ts`、`task-completion-scoring.ts`、`trace-summarizer.ts`、`config-target.ts` / `config-dataset.ts`、`derive-skill-opt-points.ts`，以及大型契约文件 `evaluation-types.ts`。
  - `general-agent/` —— 内部的 LangGraph/deepagents 运行时：`runner.ts`（`runGeneralAgent`）、`concurrency-limiter.ts`、`pending-requests.ts`、`skill-resolver.ts`、`skill-workspace-deployer.ts`、`skill-opt-prompt.ts`。
  - `observability/` —— trace 解析/归一化：`agent-trace.ts`（`buildAgentCallTree`、`AgentNode`）、`claude-parser.ts`、`openclaw-parser.ts`、`flow-parser.ts`（Skill 流程对齐）、`fault-path.ts`、`trace-bundle.ts`、`agent-registration.ts`。
  - `skill-generation/` —— 通过 Agent 进行 Skill 创作：`index.ts`（`generateSkill` / `generateSkillStream`）、`types.ts`（`SkillSpec`）、`opencode-agent-cli/`（OpenCode 客户端 + 事件类型）、`evaluator/runners/`，以及一个 `legacy/` 的 skill-sync/registry 层。
  - `skill-issues/` —— Skill 问题聚合 + `static-evaluator/`（用于静态合规检查的 linter + LLM 评测器）。
- **`storage/`** —— 持久化：`data-service.ts`（`Execution` 记录、路由/结果快照、配置）、`db-interface.ts`（`DatabaseAdapter`、`OpenGaussAdapter`、`getDatabaseAdapter`）、`prisma.ts`、`server-config.ts`（`ModelConfig` / `UserSettings`）。
- **`ingest/`** —— 框架无关的接入：`adapters/`（`FrameworkAdapter` 注册表、skill 抽取与存储归一化入口）、`claude-otel/`、`otel-consumer/`、`openclaw-watcher.ts`、`opencode-deleted-sessions.ts`、`proxy-config.ts` / `proxy-store.ts`、`routing-signature.ts`、`upload-throttle.ts` / `upload-analysis-debouncer.ts`。
- **`auth/`** —— `auth.ts`（`resolveUser`、`canAccessSkill`）和 `auth-context.tsx`。
- **`skill-analysis/`** —— `ab-scoring.ts`、`ab-significance.ts`、`diagnosis.ts`、`grayscale-utils.ts`。
- **`evaluators/`** —— 预设 + 自定义评测器模型。
- **`client/`** —— React 上下文（`api.ts` 的 `apiFetch`、区域设置/主题/侧边栏/认证、用户引导）。
- **`shared/`** —— 模型定价/配置、交互工具、默认模型配置。
- 此外还有顶层辅助函数：`agent-adapter.ts`、`agent-dataset-model.ts`、`llm-providers.ts`、`system-agents.ts`、`glossary.ts`、`safe-uuid.ts`、`utils.ts`（`cn` —— 被调用次数最多的单个函数）等。

## `server` (`src/server/`) — core, Prisma-backed repositories
供 API 路由和引擎调用的轻量持久化仓储：
- `agent_datasets_storage.ts` —— `AgentDataset` / `DatasetCase` CRUD + 校验 + 根因准备。
- `skill_trigger_eval_storage.ts` —— 触发评测集/运行（`requirePrisma`、`SkillTriggerEvalSetRecord`）。
- `user_evaluators_storage.ts` —— 用户自定义评测器的持久化。

## `prompts` (`src/prompts/`) — core, LLM prompt builders
返回 prompt 字符串的纯函数，由 `lib/engine/evaluation` 和 Skill 生成消费：`judge-prompt.ts`、`extraction-prompt.ts`、`failure-analysis-prompt.ts`、`attribution-prompt.ts` / `item-attribution-prompt.ts`、`benchmark-generation-prompt.ts`、`config-extraction-prompt.ts`、`flow-parse-prompt.ts`、`skills-prompt.ts`。无内部依赖（叶子模块）。

## `components` (`src/components/`) — shared React UI
全部仪表盘 UI。按功能组织（`eval/`、`evaluation/`、`observe/`、`skills/`、`skill-generator/`、`config/`、`chat/`、`thread/`）以及基础组件（`ui/`、`feedback/`、`text/`、`shell/`、`ai-elements/`、`SmartViewer/`）。重量级组件：`eval/Dashboard.tsx`、`eval/TrajectoryEvalCenter.tsx`、`observe/AgentTraceView.tsx`、`AgentDatasetCenter.tsx`。

## `providers` (`src/providers/`) — shared
assistant-ui 集成：`client.ts`、`Stream.tsx`、`Thread.tsx` —— 串联起 Skill 生成器/优化器 UI 所用的 chat/agent 流式运行时。

## `hooks` (`src/hooks/`) — shared
通用 React hooks：`use-file-upload.tsx`、`useMediaQuery.tsx`。（功能特定的 hooks 与其组件放在一起，例如 `components/eval/useBatchEvalResults.ts`。）

## `app` (`src/app/`) — edge, Next.js delivery
`(main)/` 下的页面（每个功能一个路由组：dashboard、agents、dataset、eval、fault、metrics、modelconfig、quality、security、skill-eval、skill-generator、skill-opt、skill-release、skills、trace），以及 `api/` 下的 API 路由处理器。这里是 HTTP 请求的入口；处理器将工作委派给 `lib`/`server`。参见 [01-architecture.md](01-architecture.md#entry-surface) 和 [06-frontend.md](06-frontend.md)。

## `scripts` (`scripts/`) — edge, operational + client agents
安装器/生命周期（`install.js`、`start.js`、`stop.js`、`status.js`、`restart*.{js,sh}`）、客户端接入 watcher/插件（`openclaw_watcher_client.ts`、`opencode_plugin*.ts`、`opencode_uploader_client.js`、`opencode_tui_plugin.tsx`）、Claude Code 官方 OTel 配置脚本、数据回填/种子，以及一个 Python OTel 接收器（`otel_receiver.py`）。

## `public`, `tools`, `test` — edge / peripheral
- `public/` —— 静态资源 + `sync_skills.ts`（客户端 Skill 同步脚本）。
- `tools/` —— `mcp-web-search/`（独立的 MCP 服务器）和 `otel-local-collector.mjs`。
- `test/` —— 针对引擎逻辑的 node test-runner 套件（`*.test.ts`）（ab-scoring、trajectory、parsers、attribution 等）。
