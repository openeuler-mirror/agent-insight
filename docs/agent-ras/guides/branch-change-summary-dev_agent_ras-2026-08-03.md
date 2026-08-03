# 分支改动说明：`dev_agent_ras`

本文说明分支 `dev_agent_ras` 上、相对提交 `c048a80`（与本地 `master` 同点）的**未提交工作树**改了什么、为什么必须改、具体怎么做，以及每项对应的**设计/架构文档引用**与**涉及文件或目录**。fork remote 为 gitcode `ICEORY/agent-insight`；制品版本标到 **0.7.2**。

文档总入口：[`docs/agent-ras/README.md`](../README.md)。本文是面向评审与合入的变更说明，不替代各专题设计原文。

每个改动点结构固定为：必要性 → 原因 → 方案 → **相关文档** → **涉及路径**。

功能顺序：

- A. RAS 运行时迁入
- B. RAS 事件 ingest 与落库
- C. 客户端安装与一键接入
- D. 启动与客户端身份保护
- E. 可靠性独立 UI
- F. 共享链路视图上的 RAS 能力
- G. OpenCode 上报路径与内容完整性
- H. Setup 下载 URL 归一
- I. 文档与协作约定
- J. 自动化测试

文末有：全量路径索引、工作树规模、验证记录、后续建议。

---

## 全局相关文档地图

写/评本分支前建议先读：

- 文档布局与索引：[`docs/agent-ras/README.md`](../README.md)
- 运行时架构：[`architecture/ras_architecture.md`](../architecture/ras_architecture.md)、[`capability_matrix.md`](../architecture/capability_matrix.md)、[`multi_platform_mount_analysis.md`](../architecture/multi_platform_mount_analysis.md)、[`message_path_modularity.md`](../architecture/message_path_modularity.md)
- 包级基线：[`design/package-baseline/`](../design/package-baseline/)
- 同进程迁入：[`design/inproc-package-migration/`](../design/inproc-package-migration/)（phase1～3 + [`agent_insight_migration.md`](../design/inproc-package-migration/agent_insight_migration.md)）
- 可靠性独立 UI：[`design/reliability-standalone-ui/`](../design/reliability-standalone-ui/)
- ingest 契约收紧：[`design/ras-ingest-contract-purge/`](../design/ras-ingest-contract-purge/)
- 宿主契约：[`contracts/`](../contracts/)（[`host_delivery_anchors.md`](../contracts/host_delivery_anchors.md)、[`host_mount_snippets.md`](../contracts/host_mount_snippets.md)、[`rail_base_abort_contract.md`](../contracts/rail_base_abort_contract.md)）
- 实现状态与主流程：[`guides/implementation_status.md`](implementation_status.md)、[`guides/main_flow_sequence.md`](main_flow_sequence.md)
- 全仓需求清单中的 RAS 行：[`docs/design/README.md`](../../design/README.md)
- 源码旁安装说明：[`agent_ras/README.md`](../../../agent_ras/README.md)、[`agent_ras/config/README.md`](../../../agent_ras/config/README.md)、各平台 `agent_ras/platform_adapter/*/INSTALL.md`

检测器类后续需求（本分支以文档/调研为主、算法未全落地）见 [`design/detector-*`](../design/) 与 [`guides/llm_thinking_loop_方案说明.md`](llm_thinking_loop_方案说明.md) 等。

---

## A. RAS 运行时迁入（`agent_ras/`）

### A1. 整树迁入仓根

**必要性。** Agent RAS 的核心价值是「环内」检测与恢复：在 Agent 进程里观察思考/工具循环，必要时注入 steering、通知用户或中断。算法与平台适配必须有一个可版本化的真源，并且要能跟 Agent Insight 看板**同仓、同版本**发布。否则服务端 ingest 契约升级了，客户端仍跑旧 runtime，会出现漏报、字段对不齐、甚至静默丢事件。

**原因。** 产品决策已收束到同进程 inproc：不再维护独立 `ras_service`、本地 HTTP/WS 控制面或「拉起另一进程再挂 UI」的路径。检测器与 recovery 禁止在 TypeScript 侧再抄一份，避免双实现漂移。若不把原仓库整树迁入 `agent_ras/`，Insight 的安装器就没有可打包的 runtime，也无法保证「安装指导生成的命令」装到的组件与当前看板一致。

**方案。** 在仓根新增 `agent_ras/`，保留 Python 包布局：`core`（detectors、recovery、reporter、monitor、agents）、`ras_embed`（facade、session hub、向 Insight 旁路推送）、`platform_adapter`（OpenCode 插件与 host control、Hermes / OpenClaw / OpenJiuwen 适配）。附带 `pyproject.toml`、config 示例、smoke 与部分 e2e 脚本。算法逻辑仍以该目录为真源；看板只负责配置下发、事件落库与人机 UI。

**相关文档。**

- [`architecture/ras_architecture.md`](../architecture/ras_architecture.md)（四层同进程）
- [`architecture/capability_matrix.md`](../architecture/capability_matrix.md)、[`multi_platform_mount_analysis.md`](../architecture/multi_platform_mount_analysis.md)、[`message_path_modularity.md`](../architecture/message_path_modularity.md)
- [`design/package-baseline/requirements_analysis.md`](../design/package-baseline/requirements_analysis.md)、[`development_plan.md`](../design/package-baseline/development_plan.md)
- [`design/inproc-package-migration/phase1-requirements-analysis.md`](../design/inproc-package-migration/phase1-requirements-analysis.md)、[`phase2-requirements-design.md`](../design/inproc-package-migration/phase2-requirements-design.md)（尤其 D-001～D-004、D-008）
- [`contracts/host_mount_snippets.md`](../contracts/host_mount_snippets.md)、[`rail_base_abort_contract.md`](../contracts/rail_base_abort_contract.md)
- [`guides/main_flow_sequence.md`](main_flow_sequence.md)、[`implementation_status.md`](implementation_status.md)
- [`agent_ras/README.md`](../../../agent_ras/README.md) 及各 `platform_adapter/*/INSTALL.md`

**涉及路径。**

- 新增目录（整树，untracked）：`agent_ras/`
  - `agent_ras/core/`（`agents/`、`detectors/`、`recovery/` 等）
  - `agent_ras/ras_embed/`
  - `agent_ras/platform_adapter/`（`common/`、`opencode/`、`hermes/`、`openclaw/`、`openjiuwen/`）
  - `agent_ras/config/`、`agent_ras/scripts/`、`agent_ras/tests/`
  - `agent_ras/pyproject.toml`、`agent_ras/README.md`、`.npmignore` / `.gitignore` 等

### A2. npm 制品范围与清理

**必要性。** 现场安装 RAS 的主流路径是：用与服务端匹配的 `agent-insight@<version>`（或可访问的 `.tgz`）做 `npm pack`，从包里取出 runtime 落到 `~/.agent-insight/ras/runtime/`。因此发布物里**必须包含**可运行的 `agent_ras` 子集，同时**不能**把开发垃圾、密钥、本地数据库打进包。

**原因。** 以前 `package.json` 的 `files` 未纳入 `agent_ras/`，安装器无源可装。若反向把整个源码树（含 `agent_ras/tests`、pycache、pytest 缓存）或 standalone 目录里残留的 `.env`、sqlite、日志一并打进制品，会增大体积、泄露环境，并让 `prepare-npm-package` 产出的 standalone 误带源码依赖。

**方案。** 将版本升到 `0.7.2`；在 `files` 中加入 `agent_ras/`，并对 `.next/standalone` 增加 `.env*`、日志、db、pyc、jsonl 等否定模式。`.npmignore` 排除 `agent_ras/tests`、开发用 scripts、`__pycache__`、pytest 缓存等。`prepare-npm-package.js` 把 `agent_ras` 等目录从 standalone 剪掉，并删除已知垃圾文件。这样「看板服务包」与「客户端可 pack 的 RAS 源」共用同一版本号，又不互相污染。

**相关文档。**

- [`design/inproc-package-migration/phase2-requirements-design.md`](../design/inproc-package-migration/phase2-requirements-design.md)（D-016 安装生命周期与版本钉死）
- [`design/inproc-package-migration/phase3-development-plan.md`](../design/inproc-package-migration/phase3-development-plan.md)
- [`design/package-baseline/development_plan.md`](../design/package-baseline/development_plan.md)
- 根 [`README.md`](../../../README.md) 中 OpenCode / Docker / `AGENT_INSIGHT_CLIENT_PACKAGE_SPEC` 说明（本分支同步修改）

**涉及路径。**

- 修改：`package.json`、`package-lock.json`、`.npmignore`
- 修改：`scripts/prepare-npm-package.js`
- 发布时带走、开发期需 ignore 的内容：见 A1 的 `agent_ras/`（由 `.npmignore` 裁剪 tests/scripts/pycache 等）

---

## B. RAS 事件 ingest 与落库

### B1. Prisma 模型 `RasAnomalyEvent`

**必要性。** 看板侧的可靠性观测是**事后读库**模型：不连 Agent 进程、不订阅实时总线。没有独立落库表，就无法做严重度汇总、按会话列表、详情页异常卡，也无法在用户维度做权限隔离。

**原因。** RAS 事件是环内旁路，明确禁止进入 OTLP spool / 普通 upload 热路径，以免拖慢 Trace ingest、混淆观测语义。关联键必须与现网 Trace 一致：`taskId` = OTel `witty.session.id` = `Execution.taskId` / `Session.taskId`。事件身份不能靠内容哈希（同内容复发无法区分，短哈希还有碰撞），因此需要每次真实异常/处置生成的 `deliveryId`，重试发送时复用同一值做幂等。

**方案。** 在 `prisma/schema.prisma` 增加 `RasAnomalyEvent`：必填 `deliveryId`、`type`、`taskId`、`payloadJson`、`ts`；可选平台、framework、anomalyKind、severity、summary、actionTypes、executionId、user 等。唯一约束 `(taskId, deliveryId)`，并按 task/user/kind/severity/type/execution 建查询索引。业务上「无对应 Trace 的孤儿事件」本期列表不展示，但库中仍可保留。

**相关文档。**

- [`design/inproc-package-migration/phase2-requirements-design.md`](../design/inproc-package-migration/phase2-requirements-design.md)（D-006 / D-012 / D-013 / D-014 / D-015）
- [`design/ras-ingest-contract-purge/phase1-requirements-analysis.md`](../design/ras-ingest-contract-purge/phase1-requirements-analysis.md)
- [`contracts/host_delivery_anchors.md`](../contracts/host_delivery_anchors.md)
- [`docs/developer-guide/04-api-and-contracts.md`](../../developer-guide/04-api-and-contracts.md)、[`09-otlp-attribute-contract.md`](../../developer-guide/09-otlp-attribute-contract.md)（旁路与 OTLP 边界说明，本分支有改）

**涉及路径。**

- 修改：`prisma/schema.prisma`

### B2. Ingest API 与 `src/lib/ingest/ras`

**必要性。** Agent 主机上的 runtime 在检出异常或完成处置后，需要一条稳定的 HTTP 入口把 flat JSON 写进库；看板前端与详情组装则需要按 task 批量读事件、算汇总、生成可叠到链路上的 marker。

**原因。** 历史上曾存在 rewrite、`rasEventId`、正文兜底等多条兼容路径，导致同一语义多种形状、测试与文档难以对齐。契约收紧后要求：flat 结构、必填 `deliveryId`、浅路径唯一入口，去掉暧昧兜底，避免「看起来写入成功、详情却关联不上」。

**方案。** 新增路由 `src/app/api/ingest/ras-events/`：鉴权与普通 ingest 对齐（有效 API Key 解析用户；本地 demo 可用 `AGENT_INSIGHT_DEFAULT_INGEST_USER`）。`POST` 走 `normalizeRasIngestBody` → `upsertRasIngestRecords`，返回 `written` 与 id 列表；同文件也承载可靠性列表/汇总/删除等读删能力（与 store 协作）。

库层拆在 `src/lib/ingest/ras/`：

- `normalize.ts`：校验与规范化、kind/severity 文案、从 body 构造入库记录。
- `store.ts`：upsert、按 task 列表、汇总、生命周期派生、可靠性 Trace 列表与删除、事件去重辅助。
- `delivery-link.ts` / `trace-markers.ts`：把处置动作与链路中的 message 对齐，生成详情用 marker。
- `fault-mode-catalog.ts` / `fault-mode-label-store.ts`：故障模式目录与浏览器本地标签覆盖。
- `sort-traces.ts`：列表时间排序。

**相关文档。**

- [`design/ras-ingest-contract-purge/phase1-requirements-analysis.md`](../design/ras-ingest-contract-purge/phase1-requirements-analysis.md)
- [`design/inproc-package-migration/phase2-requirements-design.md`](../design/inproc-package-migration/phase2-requirements-design.md)（§5 数据模型 / §6 API）
- [`contracts/host_delivery_anchors.md`](../contracts/host_delivery_anchors.md)
- [`guides/implementation_status.md`](implementation_status.md)
- [`docs/developer-guide/04-api-and-contracts.md`](../../developer-guide/04-api-and-contracts.md)

**涉及路径。**

- 新增：`src/app/api/ingest/ras-events/route.ts`
- 新增目录：`src/lib/ingest/ras/`
  - `normalize.ts`、`store.ts`、`delivery-link.ts`、`trace-markers.ts`
  - `fault-mode-catalog.ts`、`fault-mode-label-store.ts`、`sort-traces.ts`
- 关联测试见 J（`test/ras-events-ingest.test.ts`、`ras-delivery-link.test.ts` 等）

### B3. SQLite schema 预检

**必要性。** 本地默认库是 SQLite。从「无 deliveryId / 无唯一约束」迁到「`(taskId, deliveryId)` 唯一」时，若库里已有重复行，直接 `prisma db push` 会失败或留下半迁移状态；更糟的是重复事件在应用层被错误合并，可靠性统计失真且难回溯。

**原因。** SQLite 对复杂迁移支持弱；开发者频繁 `develop_start` / `postinstall`，需要在 push 前有一道显式门禁，把「数据不适合升唯一约束」变成清晰错误，而不是启动后偶发错数。

**方案。** 新增 `scripts/prepare-ras-sqlite-schema.js`：仅对 `file:` 库生效；表不存在则跳过；缺 `deliveryId` 列则 `ALTER` 补上；若已存在重复 `(taskId, deliveryId)` 则抛错并要求备份去重。`postinstall`、`start.js`、`develop_start.sh`（db push 之前）都会调用；预检失败时开发启动直接退出，避免带着坏 schema 继续跑。

**相关文档。**

- [`design/ras-ingest-contract-purge/phase1-requirements-analysis.md`](../design/ras-ingest-contract-purge/phase1-requirements-analysis.md)（旧数据可清 / 唯一约束）
- [`design/inproc-package-migration/phase3-development-plan.md`](../design/inproc-package-migration/phase3-development-plan.md)

**涉及路径。**

- 新增：`scripts/prepare-ras-sqlite-schema.js`
- 修改（接入调用）：`scripts/postinstall.js`、`scripts/start.js`、`scripts/develop_start.sh`（启动段详见 D2）

---

## C. 客户端安装与一键接入

### C1. `install-ras` CLI

**必要性。** 生产常见拓扑是：Insight 跑在一台机器（或容器），OpenCode 等 Agent 跑在另一台。平台进程**不应**在启动时去改 Agent 主机配置；Agent 侧需要可单独执行的「安装或更新 RAS / 只检查状态」命令。

**原因。** 若只能通过整包 `npx agent-insight install` 间接装 RAS，分离部署与 Docker（容器内服务端碰不到宿主机 OpenCode）都会卡死。若安装跟 npm `latest` 走，服务端已发 0.7.2 契约、客户端却装到更新或更旧的包，旁路事件字段会对不齐。

**方案。** `bin/cli.js` 增加子命令 `install-ras`，实现于 `scripts/install-ras.js`：检查 Python 版本、把 runtime 条目同步到 `~/.agent-insight/ras/runtime/`、更新 OpenCode 相关配置；支持 `--check` 只读检查；`AGENT_INSIGHT_RAS=0` 可禁用自动安装路径。README 写明：Docker 只跑服务端时，必须在 Agent 真实所在环境执行安装指导命令或 `install-ras`；源码联调可用 `AGENT_INSIGHT_CLIENT_PACKAGE_SPEC` 指向可访问的 `.tgz`。

**相关文档。**

- [`design/inproc-package-migration/phase2-requirements-design.md`](../design/inproc-package-migration/phase2-requirements-design.md)（D-007 配置根、D-016 安装生命周期）
- [`contracts/host_mount_snippets.md`](../contracts/host_mount_snippets.md)
- [`agent_ras/platform_adapter/opencode/INSTALL.md`](../../../agent_ras/platform_adapter/opencode/INSTALL.md)（及其它平台 INSTALL）
- 根 [`README.md`](../../../README.md)

**涉及路径。**

- 新增：`scripts/install-ras.js`
- 修改：`bin/cli.js`
- 运行时安装目标（机器本地，非仓内）：`~/.agent-insight/ras/`（由安装器写入）

### C2. 安装指导脚本内嵌 RAS 安装器

**必要性。** 多数用户不会记 CLI 参数，而是在看板「安装指导」复制一键 shell/PowerShell。选择 OpenCode 时，同一条命令应装上**普通观测插件**和**同版本 RAS**，并写入当前登录账号的 API Key，而不是 admin。

**原因。** 观测与 RAS 分两次安装、或 RAS 另跟 `latest`，会出现「Trace 有了但可靠性页永远无故障」「事件 400 契约不符」等难排查组合。平台启动时装 RAS 也会在错误主机上改配置（D-016）。

**方案。** 抽出 `src/lib/ingest/setup-package.ts`：用当前 `package.json` 的 `name@version`（或 env 覆盖）生成 `install_agent_insight_ras` 函数——`npm pack`（带重试与独立 cache）、解压安装、只读预检 RAS 事件端点；`AGENT_INSIGHT_RAS=0` 时跳过并提示。setup / setup-auto 生成的接入脚本在 OpenCode 分支调用该函数，与插件、uploader、TUI 等下载步骤并列。

**相关文档。**

- [`design/inproc-package-migration/phase2-requirements-design.md`](../design/inproc-package-migration/phase2-requirements-design.md)（D-016）
- [`docs/user-guide/settings/access-control.md`](../../user-guide/settings/access-control.md)、[`docs/user-guide/quickstart.md`](../../user-guide/quickstart.md)
- 与 H 节 Setup URL 归一同一批交付

**涉及路径。**

- 新增：`src/lib/ingest/setup-package.ts`
- 修改：`src/app/api/ingest/setup/route.ts`、`src/app/api/ingest/setup/auto/route.ts`（嵌入 RAS 安装片段；URL 归一见 H）

### C3. 通用安装文案与启动链挂钩

**必要性。** CLI help、README、一键 install 步骤文案若仍写「只装 telemetry」，用户会漏装 RAS；npm 安装后与正式 start 若不跑 schema 预检，新环境会踩 B3 的坑。

**原因。** 安装语义已经从「插件组件」扩展为「Agent 接入（含可选 RAS）」；身份同步结果也要区分「保留了客户端 Key」与「首次写入 Key」。

**方案。** 调整 `install.js` 步骤文案；`postinstall` / `start.js` / `start.sh` / `docker-entrypoint` 接入预检或同步结果日志；README 补充 OpenCode+RAS、分离部署与 Docker 边界。这些改动不引入新业务逻辑，但保证「文档 / CLI / 启动」三处说法一致。

**相关文档。**

- 根 [`README.md`](../../../README.md)
- [`docs/user-guide/quickstart.md`](../../user-guide/quickstart.md)
- [`design/inproc-package-migration/phase3-development-plan.md`](../design/inproc-package-migration/phase3-development-plan.md)

**涉及路径。**

- 修改：`scripts/install.js`、`scripts/postinstall.js`、`scripts/start.js`、`scripts/start.sh`、`scripts/docker-entrypoint.sh`
- 修改：`scripts/utils.js`（若有路径/数据根辅助调整）
- 修改：`README.md`

---

## D. 启动与客户端身份保护

### D1. 保留已有客户端 API Key

**必要性。** 安装指导绑定的是当前登录用户（邮箱账号）的 Key。客户端 `.env` 里的 `AGENT_INSIGHT_API_KEY` 决定 Trace 与 RAS 事件的归属。若每次 `develop_start` / `start` 都用内部 `admin` Key 覆盖，表面上服务正常，数据却全部进 admin，可靠性页按用户过滤后像「没上报」。

**原因。** 旧 `sync_admin_api_key.js` 每次成功拉到 admin key 就写回 `AGENT_INSIGHT_API_KEY`。这在早期「本机 admin 自测」可接受，与「安装指导注册用户 + 平台/Agent 分离」产品路径冲突。keyless 共享账号模式（配置了 `AGENT_INSIGHT_DEFAULT_INGEST_USER`）仍需要清空客户端 key，让无 key 上报归到默认账号——这条要保留。

**方案。** 同步前读取已有 `AGENT_INSIGHT_API_KEY`：若存在，则只更新 `AGENT_INSIGHT_HOST`，并标记 `preservedClientApiKey`；若不存在，才写入 admin key 做初始化。admin key 文件仍可更新，供需要 admin 身份的工具使用。HTTP 拉 key 增加超时，避免启动卡死。用户指南 access-control 同步为：「重启只同步 HOST，不覆盖已写入的客户端 Key」。

**相关文档。**

- [`design/inproc-package-migration/phase2-requirements-design.md`](../design/inproc-package-migration/phase2-requirements-design.md)（D-016）
- [`docs/user-guide/settings/access-control.md`](../../user-guide/settings/access-control.md)

**涉及路径。**

- 修改：`scripts/sync_admin_api_key.js`
- 修改：`scripts/start.js`（日志区分 preserved / initialized）
- 修改：`test/sync-admin-api-key.test.ts`
- 修改：`docs/user-guide/settings/access-control.md`

### D2. 开发启动改为「就绪才算成功」

**必要性。** Next dev 冷启动时路由按需编译，端口虽监听、API 往往尚未可服务。若脚本打印「Server started successfully」后立刻结束，后续接入/同步失败会被当成环境偶发，而不是启动脚本的责任。

**原因。** 旧逻辑固定重试约 20 次且中途丢弃 stderr，常见「先刷一串失败再成功」或超时后仍像半成功。RAS 预检与 Key 同步都依赖 API 真的可打通，假成功成本更高。

**方案。** `develop_start.sh` 在 spawn `npm run dev` 后进入截止等待（默认 600 秒，可用 `AGENT_INSIGHT_STARTUP_TIMEOUT_SECONDS` 调整）：进程已死则立刻失败并 dump 日志；`sync_admin_api_key` 成功才打印 ready；超时则 `exit 1`。SQLite 场景下预检失败同样中止。环境文件头注释改为与 D1 一致的 Key 语义。

**相关文档。**

- [`AGENTS.md`](../../../AGENTS.md)（验证流程约定使用 `scripts/develop_start.sh`）
- 与 B3 schema 预检、D1 Key 语义同一启动闭环

**涉及路径。**

- 修改：`scripts/develop_start.sh`
- 调用：`scripts/prepare-ras-sqlite-schema.js`、`scripts/sync_admin_api_key.js`

---

## E. 可靠性独立 UI

### E1. 侧栏「AgentRAS 可靠性」分组

**必要性。** RAS 关注的是故障等级、处置结果与环内行为，和「把所有会话当普通 Trace 浏览」不是同一任务。若入口继续塞在运行观测/链路追踪里，用户找不到能力，也会在普通 Trace 页堆过多 RAS 徽章造成噪音。

**原因。** 信息架构决策是新建与「运行观测」同级的分组（reliability-standalone-ui），而不是在 `/trace` 上加开关。需要默认可见、可国际化。

**方案。** 在 `AppSidebar.tsx` 增加 `RAS_TREE`：可靠性观测、故障模式、故障注入与评测三条子链；默认加入 expanded trees。`zh.ts` / `en.ts` 增加分组与子页文案。

**相关文档。**

- [`design/reliability-standalone-ui/phase1-requirements-analysis.md`](../design/reliability-standalone-ui/phase1-requirements-analysis.md)
- [`design/reliability-standalone-ui/phase2-requirements-design.md`](../design/reliability-standalone-ui/phase2-requirements-design.md)（§3 导航、D-001 / D-006）
- [`design/reliability-standalone-ui/phase3-development-plan.md`](../design/reliability-standalone-ui/phase3-development-plan.md)

**涉及路径。**

- 修改：`src/components/shell/AppSidebar.tsx`
- 修改：`src/locales/zh.ts`、`src/locales/en.ts`

### E2. 可靠性观测列表与详情

**必要性。** 需要一眼看到「多少条 Trace、各严重度多少、哪条有故障」，并能点进某条看异常事件时间线与完整 Agent 行为链。没有列表层，ingest 成功也无法产品化验收。

**原因。** 数据已在 `RasAnomalyEvent`；不应再为 UI 建第二套业务表。详情必须能 join 到同一 `taskId` 的 Execution/Session。列表排序与「有故障 / 无故障 / 执行失败」等生命周期要在服务端语义稳定，避免前端各算各的。

**方案。** 页面 `src/app/(main)/agent-ras/trace/`：统计区（`FaultStatsPanel`）+ 列表（`RasTraceList`，含批量删除等）。详情 `trace/[taskId]`：上方 RAS 异常事件卡（kind、severity、summary、恢复动作如 `emit_notice`），下方复用 `AgentTraceView` 拉 structure/interactions。读路径走 ras store 的 list/summarize；无 RAS 事件的 Trace 可显示为「无故障」，明确不等于业务评测通过（glossary 已写清）。

**相关文档。**

- [`design/reliability-standalone-ui/phase2-requirements-design.md`](../design/reliability-standalone-ui/phase2-requirements-design.md)（§4 可靠性追踪 UI、D-002 / D-003）
- [`design/inproc-package-migration/phase2-requirements-design.md`](../design/inproc-package-migration/phase2-requirements-design.md)（D-003 / D-005 / D-013）
- [`docs/user-guide/observability/view-traces.md`](../../user-guide/observability/view-traces.md)
- glossary 术语：本分支对 `src/lib/glossary.ts` 的 RAS 条目

**涉及路径。**

- 新增：`src/app/(main)/agent-ras/trace/page.tsx`
- 新增：`src/app/(main)/agent-ras/trace/[taskId]/page.tsx`
- 新增：`src/components/agent-ras/FaultStatsPanel.tsx`、`RasTraceList.tsx`
- 依赖库层：`src/lib/ingest/ras/store.ts`、`sort-traces.ts`、`normalize.ts`（标签）等
- 修改：`src/lib/glossary.ts`
- 详情复用与扩展见 F：`src/components/observe/AgentTraceView.tsx`

### E3. 故障模式页

**必要性。** 用户与现场支持需要回答：「现在 runtime 能检什么？默认怎么恢复？某条 prompt 全文是什么？」仅靠仓库外文档或翻 Python 源码不可接受。

**原因。** 故障模式说明属于产品可发现性；子模式显示名可能要本地改中文习惯叫法，但**不能**改算法包里的 id。prompt 类恢复措施需要可点开阅读，而不是只显示按钮文案。

**方案。** `/agent-ras/fault-modes` 使用 `RasFaultModeTable`，数据来自 `fault-mode-catalog`（与 runtime 能力对齐的静态目录）。标签覆盖存在浏览器 localStorage（`fault-mode-label-store`）。glossary 增加「RAS 严重等级」「无故障」等术语解释。

**相关文档。**

- [`architecture/capability_matrix.md`](../architecture/capability_matrix.md)
- [`guides/llm_thinking_loop_方案说明.md`](llm_thinking_loop_方案说明.md)（思考循环类能力说明）
- [`design/reliability-standalone-ui/phase2-requirements-design.md`](../design/reliability-standalone-ui/phase2-requirements-design.md)（故障目录相关 UI 决策；故障模式页为同分组扩展）

**涉及路径。**

- 新增：`src/app/(main)/agent-ras/fault-modes/page.tsx`
- 新增：`src/components/agent-ras/RasFaultModeTable.tsx`
- 新增：`src/lib/ingest/ras/fault-mode-catalog.ts`、`fault-mode-label-store.ts`
- 修改：`src/lib/glossary.ts`
- 测试：`test/fault-mode-catalog.test.ts`

### E4. 故障注入与评测页（本期 mock）

**必要性。** 产品规划里「故障注入与评测」是 RAS 闭环的另一半：主动注入已知故障模式并观察检测/恢复。需要先有稳定的导航与页面骨架，后续才能接真实 API。

**原因。** 真注入涉及安全边界与多平台能力矩阵，本期若强行接后端会拖垮主路径。决策是 UI + mock 数据结构预留接口形状。

**方案。** `/agent-ras/fault-injection` 与 `FaultCatalog`、`InjectionConfig`、`InjectionHistory`、`PlatformSelector`、`mockData` 等组件。不写入生产库；交互用于演示与后续对接。

**相关文档。**

- [`design/reliability-standalone-ui/phase2-requirements-design.md`](../design/reliability-standalone-ui/phase2-requirements-design.md)（§5、D-004）
- [`design/detector-analysis-paralysis/phase1-fault-injection-survey.md`](../design/detector-analysis-paralysis/phase1-fault-injection-survey.md)（注入调研，后续对接参考）

**涉及路径。**

- 新增：`src/app/(main)/agent-ras/fault-injection/page.tsx`
- 新增：`src/components/agent-ras/FaultCatalog.tsx`、`InjectionConfig.tsx`、`InjectionHistory.tsx`、`PlatformSelector.tsx`、`mockData.ts`

---

## F. 共享链路视图上的 RAS 能力

### F1. 事件类型 `ras` 与评测摘要隔离

**必要性。** 详情树、时间线、筛选器需要把 RAS 节点当成明确的一类事件，而不是伪装成 tool/llm。自动评测用的 trace summarizer 若把 RAS 旁路事件算进 LLM/Tool 计数，会污染评测特征。

**原因。** 原 `CallKind` 只有 llm/tool/skill/task/chain/user。RAS 合成事件进入同一棵树后，必须有独立 kind。关联 delivery 时还需要 interaction 上的 `messageID`。

**方案。** `agent-trace.ts` 扩展 `CallKind` 与可选 `messageID`。`trace-summarizer.ts` 在遍历 events 时对 `kind === 'ras'` 直接跳过。这样观测 UI 能看见 RAS，评测摘要仍只描述「真实 Agent 行为」。

**相关文档。**

- [`design/reliability-standalone-ui/phase2-requirements-design.md`](../design/reliability-standalone-ui/phase2-requirements-design.md)（D-003 组件复用）
- [`design/inproc-package-migration/phase2-requirements-design.md`](../design/inproc-package-migration/phase2-requirements-design.md)（详情复用完整行为链）
- [`contracts/host_delivery_anchors.md`](../contracts/host_delivery_anchors.md)

**涉及路径。**

- 修改：`src/lib/engine/observability/agent-trace.ts`
- 修改：`src/lib/engine/evaluation/trace-summarizer.ts`

### F2. `AgentTraceView` 承接可靠性标记

**必要性。** 独立详情页若再写一套树组件，会与 `/trace` 详情长期分叉（交互、筛选、导出、子 Agent 跳转全部要复制）。正确做法是复用 `AgentTraceView`，在其上叠加 RAS。

**原因。** 用户要回答的问题是：「这个工具重复调用，落在哪一段 LLM/Tool 时间上？恢复动作对应哪条 message？」这要求 marker 与事件时间、`messageID` 可对齐，并支持「仅异常」过滤。切换不同 `taskId` 时若复用旧 interactions Promise，会出现串会话的严重 bug。

**方案。** 为 `AgentTraceView` 增加可靠性相关 props（markers / reliability events）。将库中事件转成 `kind: 'ras'` 的 `AgentEvent` 并入树；提供 `RasNodeBadge`、`RasReliabilityDetails`（含动作与 actionResults 交错展示）；用 messageId 映射 delivery 动作类型（如 `emit_notice`）；节点/事件行/时间线/详情面板查询命中异常；增加 `anomalyOnly` 与 kind 过滤中的 `ras`；用稳定 `traceKey` 在会话切换时重置加载与选中态。`AgentTraceView` 改动面较大，但这是「一处扩展、两处页面受益」（普通 trace 详情亦可按需传入 markers）的取舍。

**相关文档。**

- [`design/reliability-standalone-ui/phase2-requirements-design.md`](../design/reliability-standalone-ui/phase2-requirements-design.md)（D-003）
- [`contracts/host_delivery_anchors.md`](../contracts/host_delivery_anchors.md)
- [`docs/developer-guide/03-file-map.md`](../../developer-guide/03-file-map.md)（观测组件地图，本分支有补）

**涉及路径。**

- 修改：`src/components/observe/AgentTraceView.tsx`（主要增量）
- 依赖：`src/lib/ingest/ras/trace-markers.ts`、`delivery-link.ts`
- 调用方：`src/app/(main)/agent-ras/trace/[taskId]/page.tsx`

---

## G. OpenCode 上报路径与内容完整性

### G1. 上传 URL：保留 basePath，落点统一 ingest

**必要性。** 不少部署把 Insight 挂在反向代理子路径下，`AGENT_INSIGHT_HOST` 的 pathname 不是 `/`。Uploader 必须把会话打到现网统一入口 `/api/ingest/upload`，否则 OpenCode 真跑了也进不了库，后续 RAS join 无从谈起。

**原因。** 旧逻辑偏向 `/api/upload`（OpenClaw 遗留桥）或拼接时丢掉 basePath。硬编码绝对 `/api/ingest/upload` 又会在子路径部署下打到错误 host 路径。

**方案。** 在 `opencode_uploader_client.js` 的请求选项里：解析 HOST，保留非根 pathname，若 pathname 以 `/api` 结尾则剥掉后再拼 `/api/ingest/upload`。导出 `getRequestOptions` 便于单测。注意：若环境变量挂了指向本机的 HTTP 代理，Node 可能把 path 变成绝对 URL——这是原有代理行为，联调时需 `noproxy` 或清代理（验证阶段已踩过）。

**相关文档。**

- [`docs/developer-guide/04-api-and-contracts.md`](../../developer-guide/04-api-and-contracts.md)（ingest upload 契约）
- [`docs/user-guide/observability/view-traces.md`](../../user-guide/observability/view-traces.md)
- OpenCode 插件安装说明：[`agent_ras/platform_adapter/opencode/INSTALL.md`](../../../agent_ras/platform_adapter/opencode/INSTALL.md)（与观测插件并列安装语境）

**涉及路径。**

- 修改：`scripts/opencode_uploader_client.js`（`getRequestOptions` 等）
- 修改：`test/opencode-uploader-grouping.test.ts`

### G2. 流式 delta 合并与事件去重

**必要性。** OpenCode 会话日志里，助手文本经常以 `message.part.delta` 流式出现；最终 part 快照可能晚到或为空。若 uploader 只读快照，入库 interactions 会缺正文，链路详情看起来像「空 LLM」，回归会误判「上报失败」。

**原因。** 同一 spool 重放或重复 kick uploader 时，相同 `event.id` 可能再次进入分组逻辑，造成重复 part 或统计膨胀。

**方案。** 分组状态增加 `partDeltas` 与 `seenEventIds`：按 event id 跳过已见事件；对 delta 按 `messageID:partID:field` 累加；`resolvePartField` 在 completed 文本、part 快照与 streamed 之间按包含关系与长度择优。相关单测写在 `opencode-uploader-grouping.test.ts`。

**相关文档。**

- OpenCode 观测上报与 spool 行为：结合 [`guides/implementation_status.md`](implementation_status.md) 与 developer-guide ingest 说明；本项为宿主观测链路修复，服务于 RAS join 的前置 Trace 完整性。

**涉及路径。**

- 修改：`scripts/opencode_uploader_client.js`（分组 / `resolvePartField` / delta 处理）
- 修改：`test/opencode-uploader-grouping.test.ts`

---

## H. Setup 下载 URL 归一到 `/api/ingest/setup/...`

**必要性。** 一键接入脚本要下载 OpenCode 插件、uploader、TUI、Hermes 插件、OpenClaw watcher、Jiuwen extension 等。下载基址必须指向当前 Next App Router 真实存在的路由，否则接入第一步就失败。

**原因。** 组件路由已归到 `src/app/api/ingest/setup/**`，旧文档/脚本中的 `/api/setup/...` 不再是真源。交互式 `setup/route.ts` 与全自动 `setup/auto/route.ts` 覆盖的平台集合也不完全相同（例如 Hermes/Jiuwen 主要在 auto 脚本里），测试若对两个文件做同样的严格字符串断言，会产生假失败或假通过。

**方案。** 重写两处 setup 路由生成脚本中的下载 URL，统一为 `$AGENT_INSIGHT_BASE_URL/api/ingest/setup/<component>`（PowerShell 同步）。测试侧：Hermes/Claude 等相关用例把「必须包含 / 不得包含 legacy」的断言收窄到 `auto/route.ts`（或明确区分交互脚本能力）。与 C2 的 RAS 安装器嵌入同一批 setup 改动，保证「观测组件 URL」与「RAS 包版本」一次接入对齐。

**相关文档。**

- [`docs/user-guide/settings/access-control.md`](../../user-guide/settings/access-control.md)、[`quickstart.md`](../../user-guide/quickstart.md)
- [`docs/developer-guide/04-api-and-contracts.md`](../../developer-guide/04-api-and-contracts.md)、[`07-conventions-and-extension.md`](../../developer-guide/07-conventions-and-extension.md)
- [`design/inproc-package-migration/phase2-requirements-design.md`](../design/inproc-package-migration/phase2-requirements-design.md)（安装与组件下发）

**涉及路径。**

- 修改：`src/app/api/ingest/setup/route.ts`
- 修改：`src/app/api/ingest/setup/auto/route.ts`
- 修改：`test/hermes-plugin-distribution.test.ts`、`test/claude-otel-setup-env.test.ts`
- 关联：`src/lib/ingest/setup-package.ts`（C2）

---

## I. 文档与协作约定

**必要性。** 本分支同时动了数据模型、API、安装语义、侧栏与 Key 行为。若只改代码不改指南，用户会按旧步骤操作（例如以为重启会刷新 Key、仍去 `/trace` 找 RAS 徽章）；协作者会把 RAS 设计文档写错目录。

**原因。** 仓库约定：涉及 Prisma / 新 API 必须有设计文档；用户可感知行为进 user-guide；架构与契约进 developer-guide。RAS 专题体量够大，不宜继续全部塞进 `docs/design/<topic>`，应有独立树并在全仓清单留索引行。

**方案。**

- `AGENTS.md`：写明 Agent RAS 需求落到 `docs/agent-ras/design/`，并与 `docs/design/README.md` 同步登记；非标准目录说明增加 `docs/agent-ras/` 与仓根 `agent_ras/`。
- `docs/design/README.md`：登记迁入、独立 UI、检测器调研、ingest 契约等行（实现状态以清单为准，若与代码短暂不一致，以代码+本文为准并应回写清单）。
- 新增整棵 `docs/agent-ras/`（架构、contracts、design、guides、examples）。
- user-guide：quickstart、access-control、view-traces 等同步 OpenCode+RAS、Key 保留、可靠性入口。
- developer-guide：INDEX、文件地图、API 与契约、扩展约定、OTLP 旁注中补充 RAS 旁路说明。

这些文档是功能交付的一部分，不是附录装饰。

**相关文档（本节即文档交付本身；权威入口）。**

- [`docs/agent-ras/README.md`](../README.md)
- [`docs/agent-ras/design/README.md`](../design/README.md)
- [`docs/design/README.md`](../../design/README.md)
- [`AGENTS.md`](../../../AGENTS.md)

**涉及路径。**

- 新增目录（整树，untracked）：`docs/agent-ras/`
  - `architecture/`、`design/`、`contracts/`、`guides/`（含本文）、`examples/`
- 修改：`AGENTS.md`、`docs/design/README.md`
- 修改：`docs/user-guide/quickstart.md`、`docs/user-guide/settings/access-control.md`、`docs/user-guide/observability/view-traces.md`
- 修改：`docs/developer-guide/INDEX.md`、`03-file-map.md`、`04-api-and-contracts.md`、`07-conventions-and-extension.md`、`09-otlp-attribute-contract.md`

---

## J. 自动化测试

**必要性。** RAS 路径跨 Python runtime、安装脚本、Prisma、Next API 与大型 React 树，靠手工点检无法锁契约。合入前至少要用单测钉住「错误输入被拒、正确输入幂等、Key 保留、uploader 路径/delta、故障目录形状」。

**原因。** 没有测试时，setup URL 改漏一条、normalize 放宽字段、sync key 回归覆盖，都会在真实 OpenCode 联调才暴露，成本高。

**方案。** 新增（工作树未跟踪）包括：`ras-events-ingest`、`ras-delivery-link`、`ras-installer`、`ras-reliability-status`、`ras-sort-traces`、`fault-mode-catalog`。扩展既有：`opencode-uploader-grouping`（path/delta/去重）、`sync-admin-api-key`（preserve）、Hermes/Claude setup 断言范围调整。本轮定向回归曾跑到约 76 pass / 0 fail；全量 `npm run test` 建议在 commit 前再跑。

**相关文档。**

- 各功能对应设计见 A～H；测试对齐契约时以 [`ras-ingest-contract-purge`](../design/ras-ingest-contract-purge/phase1-requirements-analysis.md) 与 [`implementation_status.md`](implementation_status.md) 为准。
- [`AGENTS.md`](../../../AGENTS.md) 验证约定：`npm run test`

**涉及路径。**

- 新增：`test/ras-events-ingest.test.ts`、`test/ras-delivery-link.test.ts`、`test/ras-installer.test.ts`
- 新增：`test/ras-reliability-status.test.ts`、`test/ras-sort-traces.test.ts`、`test/fault-mode-catalog.test.ts`
- 修改：`test/opencode-uploader-grouping.test.ts`、`test/sync-admin-api-key.test.ts`
- 修改：`test/hermes-plugin-distribution.test.ts`、`test/claude-otel-setup-env.test.ts`
- 运行时单测（在包内，非 Node `test/`）：`agent_ras/tests/`（随 A1 迁入）

---

## 附录：全量路径索引（相对 `c048a80` 工作树）

下列汇总便于 diff / review 对照；细节以各节「涉及路径」为准。

**已跟踪修改。** `.npmignore`；`AGENTS.md`；`README.md`；`bin/cli.js`；`package.json`；`package-lock.json`；`prisma/schema.prisma`；`scripts/develop_start.sh`、`docker-entrypoint.sh`、`install.js`、`opencode_uploader_client.js`、`postinstall.js`、`prepare-npm-package.js`、`start.js`、`start.sh`、`sync_admin_api_key.js`、`utils.js`；`src/app/api/ingest/setup/route.ts`、`setup/auto/route.ts`；`src/components/observe/AgentTraceView.tsx`；`src/components/shell/AppSidebar.tsx`；`src/lib/engine/evaluation/trace-summarizer.ts`；`src/lib/engine/observability/agent-trace.ts`；`src/lib/glossary.ts`；`src/locales/en.ts`、`zh.ts`；`docs/design/README.md`；`docs/developer-guide/INDEX.md`、`03-file-map.md`、`04-api-and-contracts.md`、`07-conventions-and-extension.md`、`09-otlp-attribute-contract.md`；`docs/user-guide/quickstart.md`、`observability/view-traces.md`、`settings/access-control.md`；`test/claude-otel-setup-env.test.ts`、`hermes-plugin-distribution.test.ts`、`opencode-uploader-grouping.test.ts`、`sync-admin-api-key.test.ts`。

**未跟踪新增。** `agent_ras/`；`docs/agent-ras/`；`scripts/install-ras.js`；`scripts/prepare-ras-sqlite-schema.js`；`src/lib/ingest/setup-package.ts`；`src/lib/ingest/ras/`；`src/app/api/ingest/ras-events/`；`src/app/(main)/agent-ras/`；`src/components/agent-ras/`；`test/fault-mode-catalog.test.ts`、`ras-delivery-link.test.ts`、`ras-events-ingest.test.ts`、`ras-installer.test.ts`、`ras-reliability-status.test.ts`、`ras-sort-traces.test.ts`。

---

## 附录：工作树规模

相对 `c048a80`，已跟踪文件约 39 个修改（约 +1179 / −155 行），另有上述未跟踪树。合计脏路径约五十余条。**尚未 git commit，也未 push。**

评审阶段已从工作树剥离的噪声包括：与 RAS 无关的 `trace/page` StatusBadge 包装、`RUN_LIVE_E2E` 测试开关、`AGENTS.md` 中大段 GitNexus 脚注、未跟踪 `CLAUDE.md`、以及 lockfile 上无关的 protobuf 抖动等。这些不应当成「本功能必需改动」。

---

## 附录：验证记录

定向自动化（uploader、setup、sync-key、RAS 相关）在修复后约 76 通过、0 失败。

开发服务用持久方式监听 `:3000` 后，本机（注意绕过指向本机的 HTTP 代理）可访问；`sync_admin_api_key` 表现为保留已有客户端 Key。

真实 OpenCode：`opencode run` 产生会话 `ses_03a7a5726ffeBbo3Jy0DJMxapR`，uploader 日志 `postJson` status 200 且 `session.uploaded`。另一次手工 ingest + RAS POST 写入 `ses_reg_1785725269`，库中 `anomalyKind=repeat_tool_call`、`severity=medium`。

浏览器登录后：`/trace` 按 `REGRESSION_OK` 能看到上述会话；OpenCode 详情树可见 LLM 轮次；`/agent-ras/trace` 汇总含中危 1 条；详情页展示「工具重复调用」异常卡与完整链路；`/agent-ras/fault-modes` 可打开。

已知非阻塞：未配置 LLM 时异步评测会跳过分析；用 Cursor 内置浏览器自动化时，DOM 上注入的 `data-cursor-ref` 可能触发 React hydration 告警，属自动化副作用，不是应用逻辑缺陷。

---

## 附录：后续建议

按功能或 Conventional Commits 拆分提交（例如 runtime+ingest、startup/key、uploader/setup、UI、docs、test），避免单笔巨型 commit。推到 fork 后提 MR 时，target 应为团队仓的 **`new_src`**，不要用个人 fork 默认的 `master`。提交前跑 `npm run test`；需要时再请人确认是否启动 dev 做 UI golden path。若要打通「上传后自动评测」，需在看板配置可用 LLM。合入后建议回写 [`design/README.md`](../design/README.md) / 全仓清单里「可靠性独立 UI」等行的实现状态，使之与代码一致。

---

## 修订记录

- 2026-08-03：初版（总览 + 表格）。
- 2026-08-03：按功能分节，每项写必要性/原因/方案。
- 2026-08-03：去掉表格，改为正文展开。
- 2026-08-03：为每项补充相关文档引用与涉及文件/目录；增加全局文档地图与全量路径索引。
