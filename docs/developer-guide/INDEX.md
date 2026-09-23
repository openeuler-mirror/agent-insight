# Agent-Insight — 开发者指南

> Agent-Insight（`@witty-ai/skill-insight`）是一个框架无关、自托管的平台，用于**观测**、**评测**和**优化** AI Agent 及其 Skill。
> 技术栈：Next.js 16（App Router）+ React 19 + TypeScript + Prisma + Tailwind，内部 Agent 使用 LangChain/LangGraph + deepagents，trace 接入使用 OpenTelemetry。受众：开发者与 LLM 编码 Agent。
> 于 2026-06-04 通过静态分析生成（515 个 TS 文件、2551 个函数、890 个类型、16004 条调用边）。请先阅读本 INDEX，再按需加载所需文件。

## Source commit (provenance)
本指南反映**截至下方 commit 的**仓库状态。更新文档时，请与此 commit 做 diff，仅查看自那之后发生的变更，并重新生成受影响的页面。

| Field | Value |
|---|---|
| Commit | `e78a74e0817ff699daa4e836f9e52ae4ffbc2cd4` (`e78a74e0`) |
| Branch | `bench-9-16` |
| Date | 2026-09-23 |
| Author | mintuyang |
| Subject | `修复实验列表状态及时更新` |
| Documentation overlay | 本次更新 Benchmark 服务部署指南的 SWE-bench Git 来源策略与执行端配置；保留既有 overlay，其他指南未重新全量审计。 |

### 旧快照至当前提交的变更摘要

> 2026-09-23 working-tree overlay：执行器新增 `GitSourcePolicy` 抽象与 SWE-bench 实例策略。`SWE_BENCH_GIT_SOURCE` 在执行机配置：空值走 Gitee → GitHub；本地目录优先 Bare 缓存并按需补存；HTTP(S) 根地址优先指定 Git 源。按 baseCommit 校验完整性、仓库级锁更新缓存、独立 shallow 工作区隔离；其他 Benchmark 保留原行为。不新增预热、数据库字段或 API。

> 2026-09-22 working-tree overlay：同步 830 已验收的安装与 Trace 通用修复：安装页保留 Linux curl、移除相关文档卡；所有未结束 Trace 采用十分钟无上报超时并自动刷新，AcTrail 明确根进程退出保留终态；修复列表、子 Agent 筛选与导航、完整内容及弹窗复制。保留 master 多框架、Goal Plus、RAS、标签和评测入口。同步安装、Trace 用户指南及 API/前端契约；未重新审计其他指南。

> 2026-09-22 working-tree overlay：采集器安装增加共享依赖预检、已知旧版本摘要白名单升级和备份；源码生产启动通过 `scripts/verify-standalone.cjs` 校验页面产物，HTTP readiness 拒绝 500。运行中的 standalone 与手动 `npm run build` 仍共用 `.next`，必须先停止旧进程再构建。

> 2026-09-22 working-tree overlay（补充复查）：手动/自动客户端安装器及生成的 shell 包装脚本跟随 `AGENT_INSIGHT_HOME`；补齐 Qwen、Hermes、Trae、Codex IDE、OpenClaw、Qoder 和 LlamaIndex 的配置/缓存默认路径。npm postinstall 与启动共用数据库选择逻辑，自定义路径时不迁移旧默认库。IDE 进程须继承运行根，显式组件路径仍优先；已有安装不自动搬迁。

> 2026-09-22 working-tree overlay：移除 `AGENT_INSIGHT_DATA_DIR` 根目录兼容，非空旧变量明确报错；只使用 `AGENT_INSIGHT_HOME`，默认路径和 Docker 挂载不变。统一服务端 Trace spool、常驻客户端与 Pi Collector 查找路径，npm 启动保留数据库覆盖优先级，更新测试隔离和迁移说明。此条取代下方旧变量兼容说明。

> 2026-09-22 working-tree overlay：SWE-bench 自动准备统一使用 `SWE_BENCH_DATASET_SOURCE` 和 `SWE_BENCH_SOURCE_ARCHIVE_SOURCE`，均接受 HTTP(S) 地址或本机文件路径，显式留空使用官方来源。本机来源只读校验，缺失或哈希错误直接失败；远程来源继续复用缓存并校验 SHA-256。旧 PATH / URL 变量仅在新变量未设置时兼容，更新配置模板及安装指南。

> 2026-09-21 working-tree overlay：运行目录主变量统一为 `AGENT_INSIGHT_HOME`，实际数据子目录由内部 `AGENT_INSIGHT_STORAGE_DIR` 表示，并兼容旧 `AGENT_INSIGHT_DATA_DIR` 根目录语义。`DATABASE_URL` 支持启动命令、用户环境文件和默认值三级覆盖；SWE-bench 自动准备可通过 `AGENT_INSIGHT_BENCHMARK` 常驻启用，同时支持内网数据集与源码归档 URL，继续执行固定 SHA-256 校验。

> 2026-09-21 working-tree overlay：常驻客户端的 Agent、模型与 FI 能力刷新会同步原子替换 Benchmark 执行器的 Agent Runtime 注册表，并在本地同步完成后才向服务端发布能力。运行期间新增、恢复或失效的 Runtime 无需重启即可作用于新任务，已开始的任务不受注册表刷新影响。

> 2026-09-21 working-tree overlay：SWE-bench x86-64 官方模式默认使用两个公开 SWR Verified 镜像仓库，并支持通过 `SWE_BENCH_VERIFIED_MIRROR_REPOS` 覆盖或以空值禁用；按列表依次尝试，未命中再走既有代理和 Docker Hub 官方源，并冻结实际 registry digest。ARM64、Epoch、数据集镜像字段和官方 Harness 不变。

> 2026-09-21 working-tree overlay：Goal Plus 不再作为用户可选 framework 或独立安装步骤；Pi bundle 内置 Agent Insight 自有的休眠观察器，仅在结构化 `/goal-plus` start 证据与 `.gp` 中当前 Pi native session invocation 一致时自动 attach、scan 并确保 watcher。普通 Pi 与增强失败继续采集主 Trace；旧 `frameworks=goal-plus` 映射为 Pi。更新 Goal Plus 用户、开发与三阶段设计文档，未修改 Goal Plus 仓库。

> 2026-09-21 working-tree overlay：Goal Plus 主 binding 在结构化 ID 到达后立即异步 flush，并在任务结束时兜底重试；reported 端点通过 session binding 映射真实 Trace，并在 binding/Execution 晚到时重算。默认主列表将“已声明 worker”与“可合并 links”分离，worker 先到时立即隐藏，主从两端完整后才进入主 Trace 子树，避免运行中独立展示、结束后再合并的跳变。

> 2026-09-21 working-tree overlay：Goal Plus reported Trace 投影改为逐 worker 就绪；已有非空 Session 正文并唯一解析的 worker 在主任务运行期间即可进入主 Trace，其他 pending worker 不再沿连通组件阻塞已就绪成员。单个 worker 查询竞态只跳过该成员，worker 缺少明确终态时继续标记为 running。通用非 Goal Plus collaboration 的整组安全策略保持不变。

> 2026-09-18 working-tree overlay：实验向导将 xiaoo Collector 上报的 `xiaoo` Trace 身份与 CLI 原生 `defaultagent` 执行 ID 归并为单个 `xiaoo` 候选；执行 target 独立保留原生 ID，普通生成 Trace 与 Benchmark 下发继续传递 `defaultagent`。

> 2026-09-18 working-tree overlay：Agent Insight 与 Evaluator 删除应用层通信鉴权及相关参数，Evaluator 默认监听宿主机 `0.0.0.0:3001`，受控网络的 `allow-insecure-http` 默认值为 `true`。Agent Insight 配置入口删除重复的 `--public-base-url`，公开回调地址由实验请求的 `Host` / `X-Forwarded-*` 自动推导，Evaluator 的实际访问地址只由评测机 `--platform-base-url` 决定。部署必须依赖白名单、安全组或防火墙限制双向访问；可把 `allow-insecure-http` 设为 `false` 强制非回环 Evaluator 使用 HTTPS。本条取代下方历史快照中的 Token 鉴权说明。

> 2026-09-18 working-tree overlay：Evaluator 部署入口移除 `--benchmark`，始终启动不含实例 Harness 的通用 Controller。`benchmarks/<key>/evaluator/evaluator.yaml` 通过构建期 Catalog 声明 OCI Runtime 镜像、容器 Entrypoint、Dockerfile 与资源边界；首个任务按 `evaluator.key + benchmark.key` 自动准备并校验内容摘要，后续复用 Docker 缓存。SWE-bench 仅作为接入包实例，公共 Controller、调度和前端不增加 SWE 专用分支。

> 2026-09-17 working-tree overlay：实验终态新增 `partial`。全部结果成功为 `done`，成功与失败并存为 `partial`，全部失败为 `failed`；列表与详情会按结果行纠正旧版“有成功即完成”的历史状态，部分完成仍发布成功结果的有效均分。

> 2026-09-17 working-tree overlay：Benchmark 整体服务安装指南补充 Agent Insight 与 Evaluator 同机部署命令，明确 `localhost`、`host.docker.internal` 与分机可达地址的边界，并分别给出同机、分机通信配置。SWE-bench 未配置 `SWE_BENCH_IMAGE_PROXY_PREFIX` 时不再内置第三方代理，直接保留官方镜像名并复用宿主 Docker daemon 的 registry mirror；显式代理行为保持不变。

> 2026-09-17 working-tree overlay：xiaoo 空最终回复改为进程退出后判定，仅正常退出且无明确错误时使用本次运行、同一 Session 的 Collector 活动记录兜底；活动记录不包含正文，独立于 Trace 上传缓冲并随运行清理。更新 `05-data-and-control-flow.md` 与实验用户指南，其他指南未重新审计。

> 2026-09-16 working-tree overlay：生产启动脚本新增 `--benchmark swe-bench`，在数据库缺少 SWE-bench Verified 时自动下载并校验固定官方源码与 Parquet、创建隔离 Python 环境并导入 500 条共享只读 Case；重复启动先查库并跳过本地准备，已有数据版本不会被静默替换。同步更新 Benchmark 服务安装指南与数据集用户指南。

> 2026-09-16 working-tree overlay：修复 xiaoo Collector 被旧 FI 上传密钥覆盖的问题，改为完整来源选择、当前 RAS 安装配置优先。无 Session ID 的 Hook 按 xiaoo PID + 启动时间隔离，仅在唯一活动会话时归属，终态释放；安装器使用 exec 保持父进程身份。最终根 span 携带显式完成标记，聚合后写入 Session 结束时间，避免退出后仍显示执行中。其他 Agent、公共 OTLP API 与官方评测逻辑不变。

> 2026-09-16 working-tree overlay：xiaoo 模型发现改用标准 TOML 解析，避免行尾注释进入 provider/model。后台实验执行通过用户登录交互 shell 继承现有终端环境，复用 xiaoo 原生密钥读取；shell 启动输出与 CLI 证据分离，沿用进程组超时，无需额外密钥文件或二次输入。

> 2026-09-14 Issue #298/#299 overlay：修复评估器配置跳转与局部刷新、评测数据集弹窗下拉交互、空数据项校验和本地导入，并让普通实验保留数据集 Case 绑定；任务完成度评测可复用有效关键观点缓存，在缓存缺失、失效或异常为空时实时提取并懒写回，模型返回空观点时使用完整预期输出兜底。

> 2026-09-04 working-tree overlay：新增 Benchmark Agent 步骤 01～13。统一实验入口按 `scope=benchmark` 分流；真实 SWE-bench Verified Parquet 由官方 loader 导入，Adapter 隔离 Harness 数据、构造 Agent Task、校验 Agent Patch、冻结不含 gold patch 的 EvaluationJob，并归一化原生结果。执行器在独立 Git 工作区产出 Patch；常驻 Evaluator Controller 容器通过 Docker Socket 启动官方 Case 镜像，直接调用固定官方源码的 `make_test_spec()` 与 `run_instance()`，再上传证据并回调原生终态。结果处理先冻结 Raw Result，以 `primaryMetric` 做固定分母聚合，仅投影安全 `nativeMetrics`；确定性归一化失败收敛为非重试终态。新增 Benchmark 实验分页结果 API 和带用户/实验归属校验的证据下载 API。01～13 已复用真实数据库和真实 Case 通过 API 级串联；ARM64 Docker Desktop 上的 09～13 双层容器验收和 `deepseek/deepseek-v4-flash` + `pallets__flask-5014` 全真实 01～13 开发冒烟均通过，后者 Harness 判定为 pass；正式计分仍需 x86_64 Linux 验收。仍不包含前端、部署脚本、服务注册与 Verified 500 批量调度。

> 2026-09-05 working-tree overlay：Benchmark 扩展契约对齐高保真开发者模型。`benchmark.yaml` 成为 Manifest 唯一真源，构建期 Generator 生成平台 Adapter、Manifest 与 Evaluator Catalog；`AbstractBenchmarkAdapter` 收敛为五个业务 hook 并统一执行 Case/Result Schema 与 public/private 边界校验。执行器删除 SWE-bench Profile，改用 Workspace、Agent Runtime 和 Artifact Collector 三类通用能力注册表并支持多 Artifact；评测 Worker 删除 SWE-bench 直接依赖，改用 `doctor`、`evaluate --request ... --output ...` 文件 Entrypoint。SWE-bench 仅作为 `benchmarks/swe-bench/` 接入实例；新增 Benchmark 通常不改公共 API、调度器、执行器 Runner、评测 Worker 或 Prisma Schema。

当前工作树新增跨 Session 协作关系后端：不可变事件与可重算端点关联分离，外部关系接口和只读查询按用户隔离；支持显式 Session 到 Trace 绑定、原始调用步骤定位、迟到 Trace 自动重算，以及 Goal Plus 逻辑主节点到 worker 成员的服务端投影。Goal Plus 仅在唯一主 Trace 时关联具体 Execution，active native Session 唯一对应的 passive canonical main 优先于历史 main，多候选仍保持歧义，且不修改原生树或完整性口径；独立协作入口暂不开放，通用 Trace 的仅主列表隐藏已投影 worker，详情直接从既有 Goal Plus 精确关联只读生成带来源标识的 TASK / 子 Agent 树。当前 passive canonical main 与 Pi 的 `<nativeSessionId>__taskN` 主任务仅在明确 `/goal-plus` 且唯一命中时允许只读显示兜底，通用 reported collaboration 行为不变。

本轮工作树补充 Goal Plus 重关联事务化、同 source 并发合并、当前 Search run 归属收敛，以及列表/详情共用成员查询和懒加载正文版本校验。历史采集数据、原生父子关系和 reported 跨 Session 协议不变；对应更新 `12-goal-plus-observability.md`、`13-cross-session-collaboration.md`，其他历史指南未重新生成。

> 2026-09-20 working-tree overlay：Goal Plus 适配重构后的统一 session 格式，仅接受 `agent_harness`、`runtime_provider`、`execution_scope` 和 `session_handle`，不兼容旧 `host` / `host_handle`。Pi collector 通过既有 collaboration sessions API 上报实际 `/goal-plus` task 的主绑定；Goal Plus collector 被动导入 direct/ThinkThread Pi worker Trace，并通过既有 sessions/events API 上报 worker 绑定和主从事件。查询层以 reported collaboration 将 worker 投影到 Pi 主 Trace 下。新版 collector 不再上传或分发 semantic snapshot spool；服务端历史语义数据路径保持可读，但不是本次适配的兼容目标。

> 2026-09-08 working-tree overlay：Benchmark 执行目标复用普通实验的客户端动态能力发现，按 `clientId + platform + agent` 返回并二次校验候选；SWE-bench Manifest 不再固定 OpenCode，所选平台动态要求 `agent-runtime/{platform}/v1`。Benchmark Agent 任务改由现有客户端 `RUN_BENCHMARK_CASE` 白名单指令经 WSS/HTTPS 长轮询下发，常驻客户端直接调用本地 Runner，不再保存或配置 `executorBaseUrl`/监听地址；Git 工作区、Patch、Outbox、独立 Evaluator 和 Official Harness 链路不变。

> 2026-09-08 working-tree overlay：Benchmark 前端最小接入复用数据集、四步实验向导、实验列表与详情路由；`SWE-bench Verified` 通过只读公共投影进入普通数据集入口，Official Harness 自动绑定，已有 Trace/监听及依赖参考答案的评估器在 Benchmark 下禁用。通用实验列表新增同配置立即运行与复用配置预填；Benchmark Case 详情只展示官方契约说明、Patch/证据元数据和归一化测试计数。Case 重跑复用通用入口，Official 重评复用最新 Patch 且默认单任务串行。

> 2026-09-08 working-tree overlay：独立 Evaluator Controller 增加 Linux/macOS 源码一键部署、Docker restart policy、当前 context Socket 解析、持久化数据卷、容器内外 Doctor 和显式 SWE-bench Gold Smoke；普通启动不预拉 Case 镜像。每次部署在新镜像就绪后重建 Controller 容器，Doctor 成功后只清理旧 Controller 镜像，保留命名 volume 和 Case 镜像。Agent Insight 增加 `data/config/benchmark-evaluator.env` 原子热加载与进程环境变量兜底，目标 URL 从运行时快照冻结，切换评测机地址不再要求重启主进程。Controller 基础健康与各 Evaluator 的 `ready/formalEligible` 分离，并输出宿主、Docker、源码 revision、`sourceDirty` 和镜像事实。版本化的构建期 Catalog 迁移到可见目录 `generated/benchmark-catalog/`，并用 `adapters.ts` 与 `catalog-lock.json` 明确 Adapter 注册表和内容指纹语义。Controller 构建默认使用带官方回退的国内 Debian/PyPI 镜像，SWE-bench Harness 改为下载固定 commit 的官方 GitHub codeload archive 并校验固定 SHA-256；Node 和 Case 镜像默认保留官方名称并复用宿主 registry mirror，仅在显式配置 `SWE_BENCH_IMAGE_PROXY_PREFIX` 时先经指定代理拉取。

> 2026-09-08 历史 overlay（已被 2026-09-18 方案取代）：当时 Benchmark Evaluator 曾支持应用层双向认证；当前实现已删除该能力及全部相关参数。

> 2026-09-09 working-tree overlay：Benchmark Catalog 新增 Dataset Loader、Dataset Profile 与声明式 Presentation；管理员可从任意服务端可读路径一次导入系统共享数据集，并选择在成功后删除源文件。共享数据集对所有用户只读，实验仍按用户隔离；管理员删除未引用数据，已引用数据改为归档。实验向导、执行目标和 Benchmark 结果卡按当前 Adapter/Manifest 动态渲染，不再依赖 SWE-bench 字段或固定 Evaluator ID。

> 2026-09-10 working-tree overlay：Benchmark 平台新增运行失活 watchdog，按 Git 准备、冻结 Agent 上限加宽限期及后处理阶段分别设置阈值，以 CAS 将无进度 Case 收敛为失败并防止迟到回调复活。客户端执行器将 Artifact/完成回调重试拆为不占 Agent 槽的持久化投递 lane，增加指数退避与单次请求超时；Git shallow fetch 增加进程组级超时、瞬时错误白名单三次重试、工作区重建与命令级 HTTP/1.1 兜底，避免一次模型、回调或 GitHub 链路故障阻塞后续实验。Agent 执行第一阶段新增 `AGENT_TIMEOUT`、高置信 `MODEL_UNAVAILABLE`、`AGENT_EXIT_NONZERO` 与 `AGENT_NO_OUTPUT` 失败码，确定性失败立即终止且不自动重试，并在 Case 详情中明确展示；`0 LLM Turn` 因依赖异步 Trace 入库留待后续追踪阶段。

> 2026-09-10 working-tree overlay：Benchmark 官方评测可靠性进一步收敛。SWE-bench Raw Result 使用严格 boolean 和官方报告结构；归一化同时绑定冻结实例/测试名单、正式资格以及重读并校验摘要的三类证据，字符串 `"false"`、错误实例、空/重复/未知测试或证据漂移均不能产生成绩。Evaluator 的 abort 成为不可逆 `EVALUATION_TIMEOUT`，callback 只接受结构与状态匹配的 ACK。平台增加 Evaluation 分阶段 watchdog、下发 attempt owner CAS、normalizing 恢复和带 owner lease 的持久化 continuation，终态 ACK 前先落续跑意图，服务重启可恢复且补充评估器不重复执行；旧 Run 无法覆盖 Case 重跑后的投影。聚合只取重试图叶子并稳定排序，防止历史尝试重复计分。官方 Harness 判定代码保持不变。

> 2026-09-10 working-tree overlay：Benchmark Case 详情新增 Artifact 查看与下载入口。`model.patch`、`report.json`、`test_output.txt` 和 `run_instance.log` 均按需通过受控内容接口读取，在右侧抽屉展示；下载菜单复用原始 Artifact，不额外生成 ZIP。通用实验详情只投影 Artifact ID 派生的 `contentUrl`，不返回存储路径或文件正文；Patch 的浏览器下载保留用户/实验归属校验，Evaluator 下载则校验 Evaluation 与 Artifact 所有权并依赖受控网络边界。

> 2026-09-11 working-tree overlay：Linux 常驻客户端安装器按实际 systemd 层级运行：root 新装和历史 `/etc/systemd/system/agent-insight-client.service` 沿用系统级服务，普通用户新装保持用户级服务；systemd manager 预检提前到设备凭证轮换之前，避免旧系统进程继续持有已撤销凭证。

> 2026-09-11 working-tree overlay：普通单组与 Benchmark 实验详情共用“同评测基线趋势”。服务端以冻结数据集、Case 集/契约和评分契约生成基线指纹，最多返回当前及之前 50 次已完成实验；前端默认显示最近 10 次，并可拖动或缩放时间窗口。普通实验展示生效综合分，SWE-bench 展示固定 Case 分母的 Resolve Rate。Agent、模型和执行客户端可变，监听和 A/B 实验暂不纳入。

> 2026-09-11 working-tree overlay：Benchmark 跨机器回调改为按组件各自可达地址发送。执行客户端不新增配置，Artifact、进度和完成回调统一复用安装 `curl` 已写入的 `insightBaseUrl`；Evaluator 新增可选 `--platform-base-url` / `EVALUATOR_AGENT_INSIGHT_BASE_URL`，未配置时兼容任务地址。Benchmark 详情以 Run 状态为真源，Patch 已上传时不再被通用 Trace pending 覆盖，并区分等待执行器终态与官方评测中。

> 2026-09-11 working-tree overlay：OpenCode 实验执行不再只等总超时。客户端直接消费 `opencode run --format json` 的结构化事件：`session.error`/错误事件立即失败，`session.idle` 或进程正常退出且没有任何模型活动时收敛为 `MODEL_NO_RESPONSE`，首个模型输出/工具事件默认 90 秒仍未出现时收敛为 `MODEL_START_TIMEOUT`；收到首模型活动后仍沿用实验冻结的 Agent 总超时。这一检测在执行客户端本地完成，不依赖 Trace 先上传，同时适用普通生成 Trace 实验和 Benchmark。

> 2026-09-11 working-tree overlay：常驻客户端保留每 30 秒完整刷新 Agent、模型与 FI 能力的节拍；每轮 inventory 将 `TMPDIR`/`TMP`/`TEMP` 指向 `~/.agent-insight/client/tmp/inventory-*` 并在成功、失败或超时后清理，避免 OpenCode/OpenTUI 原生 `.so` 堆积系统 `/tmp`。统一安装脚本的客户端 bundle 与 npm 兜底也改在 `~/.agent-insight/client/tmp/install-*` 暂存，系统 `/tmp` 已满时仍可完成客户端更新；临时 `scripts/package.json` 明确 CommonJS 包边界，避免继承 `.agent-insight/package.json` 的 ESM 类型。

> 2026-09-13 upstream overlay：新增步骤效率与执行过程质量两个通用评估器及配套设计、验收和使用说明；原轨迹质量评估器保持不变。

> 2026-09-13 upstream overlay：普通实验的平台生成 Trace、Skill 用例分析与 Skill A/B 测试的单次 Agent 执行默认上限统一为 600 秒；当前分支继续通过共享常量提供该默认值，并保留实验向导中的可配置入口。评估器超时与触发分析的独立 30 秒上限保持不变。

> 2026-09-13 upstream overlay：合入 Goal Plus 双通道 collector、语义 ingest、领域查询、完整度展示及跨 Session 调用关系上报能力；Goal Plus 历史 spool 修复、持久化去重和有界上传策略保持独立。

> 2026-09-14 upstream overlay：IDaaS userinfo 返回的 `w3Account` 作为可选外部账号唯一绑定到 UUID 用户，用于界面展示和数据库反查；权限与数据归属仍以 UUID 为准。

> 2026-09-14 PR #294 merge overlay：ROUGE、完全精确匹配与实体 F1 作为预置评估器接入；Exact Match/Entity F1 的运行配置经共享 `ExperimentWizard` 提交并在实验、Case 详情展示。“同配置实验”和“复用评测配置”保留文本评估器参数，Benchmark 向导继续按 Manifest 渲染。

> 2026-09-14 working-tree overlay：实验列表与详情的综合分只在实验 `done` 后发布，运行中不再显示部分均分；单 Case 综合分等待该 Case 的全部已选评估器进入 `done|failed` 终态，结果分和轨迹分也分别等待本类全部已选评估器进入终态，未选择的评估器不阻塞。

> 2026-09-15 working-tree overlay：Benchmark 后端扩展契约完成去 SWE-bench 专用化。Adapter 与 Evaluator 身份独立，数据集字段按 Manifest Presentation 导入并冻结，结果 API 直接返回完整 `submissions[]` / `evidenceArtifacts[]`，不保留 `patchArtifactId` 或单个 `submission`；Controller 基础镜像与 SWE-bench Harness 依赖拆分，Evaluator runtime、网络和资源声明进入实际运行。该改造用于形成“公共框架 + 接入包实例代码”的统一开发规范，不承诺零代码、纯配置接入。

> 2026-09-15 working-tree overlay：Benchmark 前端完成通用 Presentation 渲染。数据集详情、创建实验和实验详情共用字段路径与格式化模块；自动绑定使用独立 `evaluatorKey`，Evaluator 文案来自接入包；Case 详情展示完整 Submission/Evidence 列表和归一化评分点，趋势名称使用 `aggregateLabel`，公共组件不再包含 SWE-bench 字段、单 Patch、固定证据文件或 Adapter 特判。

> 2026-09-15 working-tree overlay：Trace 回流按 `traceSource.taskId` 在目标数据集和当前批次内去重；接口分别返回新增数与重复跳过数，全部重复时不修改数据集，前端提示对应结果。

> 2026-09-16 working-tree overlay：本轮仅更新安装 bundle 契约。源码启动导出完整项目根目录，RAS/client bundle 复用该目录并在白名单文件缺失时返回 503；构建恢复 npm 的 prebuild 生命周期。其他指南未重新审计。

> 2026-09-16 working-tree overlay：xiaoo 实验执行复用客户端通用运行主流程，新增 JSON CLI 适配、模型参数拆分、能力探测和明确失败回写。执行器回报原生 Session ID，与既有 Collector `session.id` / `Execution.taskId` 对齐；OTLP span 哈希仅保留在采集链路。Collector 生产代码不变；更新 `05-data-and-control-flow.md` 与实验用户指南。

> 2026-09-16 working-tree overlay：新增 Pi 实验 Runtime Adapter，复用通用执行、登录 shell、workspace/patch 和现有 Collector/OTLP 链路。独立发现 Pi 执行能力，stdin 传参，随机 Session 隔离，绑定 `<base>__task0`，等待重试收敛与 `agent_settled`；同步 `05-data-and-control-flow.md` 和实验用户指南，其他指南未重新审计。

> 2026-09-16 working-tree overlay：Pi 模型发现与执行共用 shell 启动环境及私有输出管道，兼容 bash 登录时的描述符关闭行为；完整展示 Pi 候选模型，不另设白名单或调用验证。实验向导各平台共用支持名称/ID 大小写不敏感字面包含搜索的 `RuntimeModelSelect`，同步数据流与实验用户指南。

> 2026-09-16 working-tree overlay：Pi 模型目录改为异步子进程探测，超时从 3 秒扩至 20 秒，与 FI inventory 并行刷新；新增并发去重、失败短周期重试、保留成功缓存及固定错误码日志，避免慢目录导致只剩“平台默认”或阻塞主进程心跳。

**如何更新：** `git diff 61cefb3a HEAD -- src/ scripts/ packages/ benchmarks/` 可显示自此快照以来的代码变更；重新生成受影响的文档，然后将本区块更新到新的 `HEAD` commit。

## Documents
- [00-positioning.md](00-positioning.md)：项目为何存在、面向谁、所属领域、成熟度。
- [01-architecture.md](01-architecture.md)：系统形态、技术栈、分层、模块依赖图、入口面。
- [02-modules.md](02-modules.md)：每个模块的职责；哪些是核心模块、哪些是外围模块。
- [03-file-map.md](03-file-map.md)：文件 → 模块 → 符号的查找表，用于定位代码。
- [04-api-and-contracts.md](04-api-and-contracts.md)：导出的函数签名及其调用关系、数据模型/类型、扩展点。
- [05-data-and-control-flow.md](05-data-and-control-flow.md)：核心流程（接入、评测、生成、优化、诊断）的入口与执行轨迹。
- [06-frontend.md](06-frontend.md)：前端框架、路由、组件关系。
- [07-conventions-and-extension.md](07-conventions-and-extension.md)：约定以及如何新增代码；关键实现入口。
- [08-design-system.md](08-design-system.md)：视觉设计语言、设计令牌、排版、控件尺寸、UI/UX 审计与漂移检测。机器可读的令牌：[design-tokens.json](design-tokens.json)。
- [09-otlp-attribute-contract.md](09-otlp-attribute-contract.md)：OTLP 属性契约（FR-011），定义 OpenClaw 及其他 OTLP 客户端上报 trace/log 时必须遵守的属性规范；含 RAS 旁路 ingest（非 OTLP）说明。
- [10-evaluator-development.md](10-evaluator-development.md)：新增/改造评测中心评估器。含打分方法论（禁止自由打分、分解+确定性汇总、三档锚定、精确率/召回率/有据性三轴）与工程接入（契约、注册元数据、canonical 影响面、坑位）。
- [11-usage-analytics.md](11-usage-analytics.md)：平台用量统计（管理员专用）。有效使用口径注册表、有界队列与故障隔离约束、双数据库存储契约、新增统计事件的方法。
- [12-goal-plus-observability.md](12-goal-plus-observability.md)：重构后 Goal Plus 的 Pi 主绑定、worker OTLP、关系 outbox 与主从 Trace 展示契约。
- [13-cross-session-collaboration.md](13-cross-session-collaboration.md)：跨 Session 绑定/关系事件、端点解析、查询 API 与 reported Goal Plus 投影。
- [benchmark/README.md](benchmark/README.md)：自定义 Benchmark 的客户入口、需求发现、统一接入开发规范和[整体服务安装指南](benchmark/service-deployment-guide.md)。
- [qoder-cn-acceptance-validation.md](../design/qoder-cn-trace-validation/qoder-cn-acceptance-validation.md)：Qoder CN 产品家族 Trace 采集器 AC1–AC37 的完整验收、真实客户端演示、性能、卸载和数据正确性测试。
- [qoder-cn-cross-machine-validation.md](../design/qoder-cn-trace-validation/qoder-cn-cross-machine-validation.md)：Qoder CN 采集器与 Agent Insight 服务端分布在不同机器时的安装、上传、排查和卸载验证。
- [docker-image-release.md](docker-image-release.md)：维护者发布 Docker Hub 多架构镜像、验证 manifest、导出离线 `.tar` 镜像包的流程。
- 仓根 [`agent_ras/`](../../agent_ras/)：环内可靠性同进程真源（OpenCode L3 inproc）；统一安装入口见 [`scripts/install-ras.js`](../../scripts/install-ras.js)。
- 仓根 [`agent_fault_injection/`](../../agent_fault_injection/)：故障注入引擎（注入+采集）；文档 [`docs/agent-fault-injection/`](../agent-fault-injection/README.md)；UI `/agent-ras/fault-injection/tasks`（目录 `/faults`），BFF `/api/fault-injection`。
- Agent RAS 文档统一入口：[`docs/agent-ras/`](../agent-ras/README.md)（[designs](../agent-ras/designs/) / [guides](../agent-ras/guides/)）。

## Quick lookup
| 我想要... | 前往 |
|---|---|
| 了解整体全貌 | [01-architecture.md](01-architecture.md) |
| 了解每个目录的作用 | [02-modules.md](02-modules.md) |
| 查找哪个文件实现了 X | [03-file-map.md](03-file-map.md) |
| 调用或扩展某个引擎 API / 类型 | [04-api-and-contracts.md](04-api-and-contracts.md) |
| 端到端跟踪接入 / 评测流程 | [05-data-and-control-flow.md](05-data-and-control-flow.md) |
| 接入新的 Benchmark | [Benchmark 文档关系与开发指南](benchmark/README.md) · [07-conventions-and-extension.md](07-conventions-and-extension.md) |
| 部署 Benchmark 整体服务 | [Benchmark 整体服务安装指南](benchmark/service-deployment-guide.md) |
| 新增 API 路由或页面 | [01-architecture.md](01-architecture.md) · [07-conventions-and-extension.md](07-conventions-and-extension.md) |
| 为页面设置样式 / 使用正确的颜色、间距或组件 | [08-design-system.md](08-design-system.md) |
| 遵循项目的模式 | [07-conventions-and-extension.md](07-conventions-and-extension.md) |
| 新增或改造评估器 / 设计打分口径 | [10-evaluator-development.md](10-evaluator-development.md) |
| 验收 Qoder CN Trace 采集器 | [qoder-cn-acceptance-validation.md](../design/qoder-cn-trace-validation/qoder-cn-acceptance-validation.md) |
| 验证 Qoder CN 跨机器上报 | [qoder-cn-cross-machine-validation.md](../design/qoder-cn-trace-validation/qoder-cn-cross-machine-validation.md) |
| 发布 Docker Hub 镜像 / 导出离线镜像包 | [docker-image-release.md](docker-image-release.md) |

## Glossary
- **Skill**：一个带版本、自包含的 Agent 能力（即一个包含 `SKILL.md` 的文件夹）。在这里是一等实体——可被生成、评测、A/B 测试和优化。对应数据库模型 `Skill` + `SkillVersion`。
- **Execution / trace**：接入平台的一次 Agent 运行（Prisma `Execution`）。一次主运行被拆分为一个根执行 + N 个子 Agent 执行，通过 `parentExecutionId` / `rootExecutionId` 关联。
- **Trajectory evaluation**：针对某次执行的工具/Skill 路径，对照预期流程逐步打分（`evaluateTrajectory`、`TrajectoryEvalResult`）。
- **Outcome vs Routing evaluation**：结果评测 = 最终答案是否与标准答案匹配；路由评测 = Agent 是否调用了预期的 Skill。参见 `ConfigDatasetType`、`RoutingEvaluationSnapshot`、`OutcomeEvaluationSnapshot`。
- **Preset result evaluators**：评测中心提供准确性、答案质量、忠实度和指令遵循四个结果类预置评估器，只在用户主动运行实验时执行；质量监控不再包含结果维评测。
- **Grayscale (A/B)**：在一个数据集上对两个 Skill 版本进行对比（`GrayscaleTask`、`ab-scoring.ts`）。
- **Config (dataset config)**：某个查询的标准答案记录——预期 Skill、标准答案、根因、关键动作（Prisma `Config`、`ConfigItem`）。
- **General agent / deepagents**：内部的 LangGraph/deepagents 运行时（`runGeneralAgent`），为 Skill 生成、优化和 LLM 评测器提供支撑。
- **Ingest**：通过 OpenTelemetry 端点或框架 watcher/插件（包括 OpenCode、Claude、OpenClaw、AcTrail）接收 Agent 运行数据，并将其规范化为 `Execution` 记录。
- **Collaboration trace**：独立于原生 Execution 树的跨 Session 关系覆盖层；事件正文不可变，端点到 Execution 的关联可随 Trace 到达重算。
- **Skill issue / optimization point**：由静态或动态评测产生的、已发现的改进点（`SkillIssue`）；供 skill-opt 流程消费。

本次合并保留本地跨 Session 协作后端、Goal Plus worker 投影及其事务一致性修复，并保留远程 Benchmark、文本评估器、Pi RAS 和 IDaaS 账号别名实现。具体契约分别见对应指南。

本次基于 `8ce387aa` 合并跨 Session Trace 展示修复，保留 Goal Plus worker 投影、折叠与正文版本校验；显式上报关系使用独立投影，无定位时按顺序并列展示。
