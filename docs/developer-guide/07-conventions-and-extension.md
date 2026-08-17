# Conventions & Extension

> 本代码库实际遵循的模式——包括一些不那么显而易见、Agent 容易搞错的项目规则。遵循它们，新代码才能保持一致。最权威的协作约定是仓库根目录的 `AGENTS.md`；最权威的架构文档是 `docs/PROJECT.md`。本文件总结了编写代码时最需要关注的内容。

## Core frameworks & roles
- **Next.js App Router** —— 页面与 API 同处一棵树（`src/app`）。新增后端行为是一个 route handler（`route.ts` 导出 `GET`/`POST`/…）；新增界面是 `page.tsx`。参照已有的同级文件。
- **Prisma (SQLite default)** —— 所有持久化都经由 `src/lib/storage` + `src/server` 仓库层，绝不在路由中写裸 SQL。`DatabaseAdapter`（`db-interface.ts`）对后端（SQLite / OpenGauss）进行抽象。
- **LangChain / LangGraph / deepagents** —— 所有 LLM agent 工作都经由 `runGeneralAgent`（`engine/general-agent/runner.ts`）以及 skill 生成/优化的桥接层；不要随意直接调用各 provider 的 SDK。
- **assistant-ui** —— 聊天/流式 UI 使用 `src/providers/{Stream,Thread}.tsx` + `src/lib/agent-adapter.ts`。
- **OpenTelemetry** —— 框架无关的接入；新增框架的采集入口放在 `src/lib/ingest/*` 下，而不是路由里。

## Coding conventions
- **TypeScript**：`strict: true`、`moduleResolution: bundler`、`noEmit`（由 Next 编译）。通过路径别名 **`@/* → src/*`** 导入（`tsconfig.json`）。CLI 使用单独的 `tsconfig.cli.json`。
- **Lint**：ESLint 9 扁平配置（`eslint.config.mjs`、`eslint-config-next`）。运行 `npm run lint`。
- **Comments**：项目约定是*默认不加注释*——只有当 WHY 不显而易见时（隐藏的约束或反直觉的变通）才写一行注释。不要写"它做了什么"这类注释。
- **Don't create docs/README files**，除非被明确要求。
- **以 markdown 链接的形式沟通文件路径** `[name](path:line)`。

## UI rules (hard constraints — from `AGENTS.md` §6, enforced in review)
对页面/组件/交互/视觉的任何改动，都必须先与 `docs/design/`（`README.md`、`foundations.md`、`components.md`、`patterns.md`）对齐。红线：
- ❌ 不要手搓 Button / 状态徽章 / `EmptyState` / `ErrorState` / `MetricValue`——使用 `src/components/{ui,feedback,text}` 中的封装。
- ❌ 组件中不要出现裸颜色（`#xxxxxx`、`rgba(...)`、`bg-[#...]`、`dark:` Tailwind 前缀）——通过 CSS 变量使用设计令牌（`src/app/globals.css` 中的 `:root` / `[data-theme='dark']`）。
- ❌ 不要自行用 `mx-auto + max-w-*` 做页面居中——使用 `<PageContainer>`。
- ❌ 不要用 `window.alert` / `window.confirm`——使用 `sonner` toast 或 `<ConfirmDialog>`。
- 任何 UI PR 都必须包含**亮色和暗色两种截图**。

## Project-specific conventions
- **对外的一切都以 `name`（而非 `id`）作为 Skill 的键**（`AGENTS.md` §7）：UI 路由（`/skill-opt/[name]/[version]`）和新增的 API 路径（`/api/skills/:name/...`）都用 `name`；`id` 保持内部使用。要接受重命名 Skill 会导致其 URL 失效这一点。
- **多 Agent 执行树**：一次主运行会变成 1 个根 `Execution` + N 个子 agent 的 `Execution`，通过 `parentExecutionId`/`rootExecutionId` 关联，并共享 `agentSessionId`。列表/聚合视图会过滤 `isSubagent = false`；详情视图则下钻到子 agent。查询执行记录时要遵循这一点。
- **评测分为两张表**：`Evaluation`（事件）+ `SkillIssue`（优化点），带有 `source`/`category`/`resolvedAt` 以及 `Evaluation.runId`。旧的单表 `SkillOptimizationPoint` 已废弃——不要重新引入它。流行度（prevalence）在读取时派生（懒删除的重新评测模型）。
- **列中存 JSON**：许多 Prisma 字段以 JSON 字符串存储（`invokedSkills`、`casesJson`、`configJson`、`itemsJson`、…）。在存储边界处解析/序列化，在 TS 中保持类型化的结构（`ExecutionRecord`、`ConfigItem` 等）。
- **框架名判断走注册表**：对存量 `Execution.framework` 做框架判断时优先走 `resolveFrameworkId` / `getAdapter`。Claude 的标准 adapter id 是 `claude`，但存量数据仍可能是 `claudecode`；不要新增裸 `framework === 'claude'` 来判断存量值。

## How to extend
- **新增 API 端点**：创建 `src/app/api/<group>/<name>/route.ts`，导出对应 HTTP 动词的函数，先调用 `resolveUser(request)` 做鉴权，再委派给 `src/lib/*` / `src/server/*`。参照同一 group 下已有的 handler（例如 `api/skills/[id]/runs/route.ts`）。
- **新增页面**：创建 `src/app/(main)/<feature>/page.tsx`，在 `<PageContainer>`/`<PageHeader>` 内渲染，通过 `apiFetch` 取数据，通过 `useAuth`/`useLocale` 获取上下文。参照已有的功能页面。
- **新增引擎能力**：放在 `src/lib/engine/<area>/` 下，导出一个类型化的入口函数 + 一份 `types.ts` 契约；将其接入某个 route handler。提示词保留在 `src/prompts/` 中。
- **新增存储后端**：与 `OpenGaussAdapter` 并列实现 `DatabaseAdapter`（`db-interface.ts`）。
- **新增 LLM provider**：扩展 `src/lib/llm-providers.ts` 中的 `LlmProvider` 注册表。
- **新增自定义评测器**：用 `LlmEvaluatorConfig` / `CodeEvaluatorConfig`（`src/lib/evaluators/custom-evaluator-model.ts`）建模；通过 `src/server/user_evaluators_storage.ts` 持久化。
- **新增预置评估器**：实现放 `src/lib/engine/experiment/<族>-preset-evaluators.ts`（一族一文件），另需在卡片/元数据/分发/守卫测试四处登记。落点、命名与打分方法论见 [10-evaluator-development.md](./10-evaluator-development.md)——**动手前必读**，这条路径上的坑基本都记在那里了。
- **新增框架接入路径**：在 `src/lib/ingest/*` 下加 parser/watcher 或 OTel 聚合器，并在 `src/lib/ingest/adapters/` 注册 `FrameworkAdapter`（descriptor、skill 抽取、必要的 `normalizeForStorage`）。路由层不要再手写框架分支；通过 `saveExecutionRecord` 归一化为 `Execution`。安装脚本框架清单仍是后续治理范围。
- **流程闸门**（`AGENTS.md` §4）：对 **Prisma schema** 的任何改动，或任何**新增 API 路由**，都需要先在 `docs/plans/YYYY-MM-DD-<topic>-design.md` 下产出一份 Plan 文档，对齐后再编码。

### 新增专项诊断器

在 `skills/agent-debug-diagnosis/detectors/<name>/` 新增 `detector.json`、入口脚本和说明文件。清单声明唯一名称、版本、支持的 `one_click` / `targeted` 模式、症状关键词和入口文件。运行 `python3 skills/agent-debug-diagnosis/scripts/detector_validate.py` 校验；Skill-local runner 会自动发现，不修改服务端 TS 注册表、追问路由或前端组件。输出必须符合通用 detector finding 契约：用户可读的确定性事实放入 `facts`，原始计数、区间、比例等机器字段放入 `details`，证据节点放入 `anchors`。执行统一 Skill 的同一个 Agent 负责富化、查重和关联，并直接生成最终报告；`agentdebug_validate.py --core --detectors` 保证冻结 core 字段和专项结构化事实不丢失。新增诊断器不得依赖服务端包装文件、独立富化模型、前端来源标签或专属组件。

## Boundaries — change with care
- **生成物**：`node_modules/.prisma`、`.next/`、`next-env.d.ts`——绝不手工编辑。
- **高扇入核心**（改动它们会大范围波及）：`src/lib/utils.ts`（`cn`，入边 103）、`src/lib/client/api.ts`（`apiFetch`，58）、`src/lib/client/locale-context.tsx`（`useLocale`，48）、`src/lib/auth/auth.ts`（`resolveUser`，24）、`src/lib/storage/db-interface.ts`（`OpenGaussAdapter.query`，32）、`src/lib/storage/server-config.ts`（`getActiveConfig`，21）、`src/lib/engine/evaluation/config-target.ts`（`normalizeConfigSkillName`，24）。
- **Prisma schema**：改动需要 migration + Plan 文档；许多列是有意设计为 JSON 字符串的（未经讨论不要"规范化"它们）。
- **非标准目录**（`AGENTS.md` §8）：`skills/`（打包的 `SKILL.md` 定义）、`features/`（轻量设计草稿）、`scripts/restart_dev.sh`（唯一认可的开发启动方式）、`docs/PROJECT.md`（重大改动后保持其更新）。

## Key decisions (ADR-style, from schema/docs)
- **SQLite + 适配器，自托管** —— 本地优先的数据所有权；通过 `DatabaseAdapter` 支持 OpenGauss/PostgreSQL 以扩展规模。
- **Skill 作为一等的、带版本的实体** —— `Skill`/`SkillVersion`，版本不可变；`name` 是外部键。
- **统一的评测模型** —— 静态/动态/触发三类收敛为 `Evaluation` + `SkillIssue`；懒删除的重新评测，流行度在读取时派生。
- **框架无关的接入** —— OTel + 各框架的 watcher/插件将一切归一化为统一的 `Execution` 树；框架名解析、skill 抽取与部分存储归一化由 `FrameworkAdapter` 注册表承接。
- **内部工作委派给 agent** —— 生成/优化/评测经由 `runGeneralAgent` 在 deepagents/LangGraph 上运行，隔离在桥接层之后。

## Build / test / run
- **Install**：`npm install`（会运行 `scripts/postinstall.js`）。
- **Agent RAS install**：`node scripts/install-ras.js`（对外命令
  `npx agent-insight install-ras`）。发布包携带 `agent_ras/` 的功能源码和全部平台适配器，
  排除测试、缓存、日志与内部设计资料；安装器将运行所需文件复制到
  `~/.agent-insight/ras/runtime/<fingerprint>/`，再幂等配置 OpenCode。生产安装只装
  Python 基础包；RAS 开发测试使用 `pip install -e "agent_ras[dev]"`。平台 `start`
  与源码启动脚本不检查、不安装 Agent 主机 RAS；OpenCode 安装指导是唯一自动安装入口。
  setup 脚本默认绑定 `${package.name}@${package.version}`。取制品三级回退：本地
  checkout（`./scripts/install-ras.js` + `agent_ras/pyproject.toml`）→
  `GET /api/ingest/setup/bundle?name=ras`（服务端白名单 tar）→ 隔离 cache 的
  `npm pack --ignore-scripts`。源码/私有包联调仍可通过
  `AGENT_INSIGHT_CLIENT_PACKAGE_SPEC` 覆盖 npm 兜底。校验安装器后直接运行，避免
  `npx` 解析整套应用依赖和共享 `_npx` 锁竞争；安装成功后以当前用户 Key 对 RAS GET
  端点做只读预检。常驻客户端同样三级回退（`bundle?name=client`），运行时固化到
  `~/.agent-insight/client/runtime/`。
- **Client identity**：平台启动仍生成内部 admin key 并保存到 `.admin_api_key`，但只在
  `~/.agent-insight/.env` 缺少客户端 Key 时初始化它。安装指导已经注册的邮箱用户 Key
  必须保留，普通 OpenCode telemetry 与 RAS config 使用同一个身份。
- **RAS SQLite schema preflight**：源码、npm 与 Docker 启动入口在 `prisma db push`
  前统一执行 `scripts/prepare-ras-sqlite-schema.js`。旧数据库缺少
  `RasAnomalyEvent.deliveryId` 时，仅补充 nullable 列，并在确认
  `(taskId, deliveryId)` 无重复数据后创建唯一索引；发现冲突会明确失败，不使用
  `--accept-data-loss` 绕过迁移警告。
- **Dev**：`bash scripts/develop_start.sh`——端口 3000。脚本启动 Next 进程后会继续等待
  `/api/auth/apikey` 真正可用并完成客户端身份同步，默认最长等待 600 秒；冷启动较慢时
  不会提前把“进程存在”误报成“服务已就绪”。可用
  `AGENT_INSIGHT_STARTUP_TIMEOUT_SECONDS` 和
  `AGENT_INSIGHT_STARTUP_REQUEST_TIMEOUT_MS` 调整总等待时间与单次探测超时。
- **Build**：`npm run build` · **Start (prod)**：`bash scripts/restart.sh` 或 `npm run start`。
- **Test**：`npm run test`（`node --import tsx --test "test/**/*.test.ts"`）。Skill 生成测试：`npm run test:skill`。真实模型 E2E 默认跳过；仅在隔离环境中同时设置 `RUN_LIVE_E2E=1` 与对应 API Key 后显式执行，避免默认测试产生外部调用、费用或工作区写入。
- **Note (environment)**：测试/构建需要 Node ≥ 20（本环境通过 nvm 锁定到 Node 22.17.1；Windows 侧的 Node 会在 esbuild 上失败——请在 WSL 内运行）。

## SQLite data archive CLI

`scripts/db_archive.sh` 是 SQLite-only 的逻辑归档入口，支持 `create`、`inspect`、`import`
三个命令。它不经过 `DatabaseAdapter`，也不支持设置了 `DB_HOST` 的 OpenGauss 部署。
脚本是可脱离仓库复制运行的单文件工具，不读取 `package.json` 或其他项目文件，运行时
只依赖 `bash`、`sqlite3`、`gzip` 和可用的 SHA-256 命令。
未显式传 `--database` 时，数据库解析规则与应用默认值保持一致：
`~/.agent-insight/data/witty_insight.db`；其他相对 `file:` URL 从脚本运行目录解析。

归档格式为 gzip 压缩的裁剪 SQLite 数据库，内部通过 `_ai_archive_manifest`、
`_ai_archive_counts` 和 `_ai_selected_*` 表记录格式版本、schema hash、时间窗口、逐表数量
及聚合根。归档生成先使用 `VACUUM INTO` 创建一致性源库快照，再复制被选中的业务聚合；
因此导出不会读到跨事务的半成品。

- `traces` 提供 `--user` 时，以 `Execution.user` 完全匹配指定账号且非子 Agent 的记录为
  时间选择根；省略时选择时间窗口内全部账号，manifest 的 user 记为 `<all-users>`。账号
  范围内不区分用户 Agent 与系统 Agent。选根后沿 `rootExecutionId` 和 `parentExecutionId`
  收集整棵执行树。Execution、Session、评测、Issue、标签绑定、诊断、infra 关联和被引用
  的实验 case/result/comment 是 owned rows；Skill/SkillVersion、Tag、InfraSource、
  Experiment 是只随包携带、不从源库删除的 reference rows。导入时保留原始 user 字段。
- `infra-metrics` 以 `InfraMetricSample.tsMs` 使用 `[from, to)` 窗口选择数据，
  `InfraSource` 作为 reference rows 保留；该模型没有 user 字段，因此不接受 `--user`。
- 时间参数接受带时区的完整 ISO-8601，或只精确到日的 `YYYY-MM-DD`；日期值通过 SQLite
  `utc` modifier 按运行机器本地时区的当天零点转换，避免依赖 GNU/BSD `date` 的不同参数。
- `create` 默认归档并清理源数据：它会在新事务里将 live DB 的 owned rows 与归档逐行比对，
  期间发生新增或更新就通过 CHECK guard 失败并回滚，验证通过后才按子表到父表顺序删除。
  `--keep-source` 显式切换为只导出；旧 `--purge-source` 仍作为兼容参数接受，但已是默认行为。
- `import` 要求 canonical schema hash 一致；逐表比较同主键行，相同行幂等跳过、内容不同则
  CHECK guard 失败。全部插入和外键差异检查位于同一 `BEGIN IMMEDIATE` 事务。
- `.sqlite.gz.sha256` 用于传输完整性验证；`.sqlite.gz.purged` 是成功清理源库后的收据。
  外部附件不属于数据库归档范围。

端到端契约测试位于 `test/db-archive-script.test.ts`，覆盖仓库外单文件执行、完整执行树、
关联行、冲突回滚、幂等恢复和指标半开时间窗口。新增 archive policy 时，需要同时补齐
复制条件、purge guard、删除顺序、导入顺序和往返测试。

## Key implementation entry points
> 重型逻辑所在之处（被调用最多的函数）。仅作指引——需要看实现时再打开文件。

| Function | File | Inbound calls |
|---|---|---|
| `cn` | `src/lib/utils.ts` | 103 |
| `apiFetch` | `src/lib/client/api.ts` | 58 |
| `useLocale` | `src/lib/client/locale-context.tsx` | 48 |
| `useAuth` | `src/lib/auth/auth-context.tsx` | 33 |
| `OpenGaussAdapter.query` | `src/lib/storage/db-interface.ts` | 32 |
| `resolveUser` | `src/lib/auth/auth.ts` | 24 |
| `normalizeConfigSkillName` | `src/lib/engine/evaluation/config-target.ts` | 24 |
| `getActiveConfig` | `src/lib/storage/server-config.ts` | 21 |
| `saveExecutionRecord` | `src/lib/storage/data-service.ts` | 13 |
| `withBackgroundOpencodeSlot` | `src/lib/engine/general-agent/concurrency-limiter.ts` | 13 |
| `requirePrisma` | `src/server/skill_trigger_eval_storage.ts` | 12 |
| `canAccessSkill` | `src/lib/auth/auth.ts` | 12 |
| `getProxyConfig` | `src/lib/ingest/proxy-config.ts` | 12 |
| `buildAgentCallTree` | `src/lib/engine/observability/agent-trace.ts` | 6 |
| `runGeneralAgent` | `src/lib/engine/general-agent/runner.ts` | 9 |
