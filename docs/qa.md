# Q&A

本文档汇总 Agent Insight 平台的常见问答，覆盖平台概念、安装部署、框架接入、Skill 全生命周期、评测中心、运行观测、架构数据模型、开发约定与运维排障等内容，帮助开发者快速理解平台定位并定位使用过程中的常见问题。

## 平台概览与核心概念

### Q1. Agent Insight 是什么？它要解决开发者的哪三大痛点？

Agent Insight 是一个**框架无关、完全自托管**的 Agent 工程平台（AgentOps），让运行在 OpenCode、Claude Code、Hermes、OpenClaw 等任意框架上的 Agent 都能被持续观测、系统评测和自主优化，并把 **Skills（Agent 能力）作为一等公民**，提供从生成、A/B 测试到优化的完整闭环。它针对开发者面临的三大痛点：Agent 运行过程如同黑盒，难以定位问题根因；Skill 质量参差不齐，缺少体系化的评测与迭代手段；Agent 经验无法沉淀复用，每次优化都从零开始。

### Q2. 用一句话概括 Agent Insight 平台的主线是什么？

主线是：在 Workspace 中接入并管理 Agent；Agent 每次真实运行产生一条 Trace；通过链路追踪和智能诊断理解问题发生在哪里；把线上问题沉淀成评测数据集做离线回归；通过评估器和评测批次量化结果差异；最后把稳定经验沉淀为 Skill 继续进入生成、评测和优化闭环。简记成：**Agent 产生 Trace，Trace 暴露问题，评测量化问题，Skill 沉淀解法。**

### Q3. Agent 和 Skill 有什么区别？

Agent 是运行中的执行主体，关注"谁在执行任务"；Skill 是被 Agent 选择和调用的能力资产，关注"用什么能力完成任务"。一个 Agent 可以加载多个 Skill，一个 Skill 也可被多个 Agent 复用。常见页面分别对应 Agent 管理/链路追踪 与 Skills Hub/Skills 评测/Skills 优化。

### Q4. Trace 和 trajectory 有什么区别？

Trace 属于运行观测语境，是一次真实执行的完整链路记录，用于看真实世界发生了什么；trajectory 是评测数据中的过程字段，用于让离线评测也能检查过程是否合理，**它不等同于线上完整 Trace**。

### Q5. 智能诊断和评估器有什么区别？

智能诊断的主要作用是解释"为什么不好"，输入对象是异常或失败 Trace，产出归因结论、证据、建议；评估器的主要作用是量化"到底差了多少"，输入对象是评测结果或评测轨迹，产出分数、规则结果或判定理由。

### Q6. Skill 在 Agent Insight 中的定义是什么？一个完整 Skill 通常包含哪些部分？

Skill 是可被 Agent 加载并按需调用的能力包，是版本化、可复用、可评测的能力单元，而不只是一个提示词。一个完整 Skill 通常由 **SKILL.md**（主文档，定义用途、触发条件、输入约束和执行方式）、**scripts/**（可执行脚本目录）、**references/**（参考资料或上下文文档目录）、**版本信息**和**分析结果**（静态合规、触发分析、A/B 测试、用例分析）组成。

### Q7. 根据开发者指南术语表，Execution/trace 在数据模型中是如何组织的？

Execution/trace 是接入平台的一次 Agent 运行（对应 Prisma `Execution`）。一次主运行被拆分为**一个根执行 + N 个子 Agent 执行**，通过 `parentExecutionId` / `rootExecutionId` 关联。

## 安装与部署

### Q8. 安装 Agent Insight 服务端的环境要求是什么？

Node.js `>= 20.0.0`，且 3000 端口未被占用。

### Q9. 用 npm 快速部署 Agent Insight 的命令是什么？有哪些平台服务管理命令？

一键安装命令是 `npx agent-insight install`。平台服务管理命令包括：`npx agent-insight install`（一键安装平台及所有组件）、`start`（启动服务，默认 3000 端口）、`start --port <端口>`（指定端口启动）、`stop --port <端口>`（停止指定端口的服务）、`restart`（重启服务）、`status`（查看服务运行状态）、`logs`（查看服务日志）。

### Q10. 基于源码构建 Agent Insight 需要哪些步骤？Trae IDE 采集器插件单独要构建什么？

`git clone https://gitcode.com/openeuler/agent-insight.git` 后 `cd agent-insight && npm install`。Trae IDE 采集器插件需要单独构建：`cd scripts/trae-collector && npm install && npm run build`，会生成 `scripts/trae-collector/agent-insight-trae-collector-0.1.0.vsix`。

### Q11. Docker Hub 在线拉取镜像部署 Agent Insight 的完整命令是什么？默认数据库路径在哪？

`docker pull karaggagent/agent-insight:latest`，然后 `mkdir -p ~/.agent-insight/data && chmod -R 777 ~/.agent-insight`，再 `docker run -d --name agent-insight --restart unless-stopped -p 3000:3000 -v ~/.agent-insight:/data/agent-insight karaggagent/agent-insight:latest`。容器内 `/data/agent-insight` 对应宿主机当前用户的 `~/.agent-insight`，默认 SQLite 数据库位于 `~/.agent-insight/data/witty_insight.db`，升级镜像时保留挂载目录即可复用数据。

### Q12. 镜像 `karaggagent/agent-insight` 是多架构的吗？x86_64 和 aarch64 分别拉取什么？生产环境如何锁定版本？

是多架构镜像。`x86_64` 服务器会自动拉取 `linux/amd64`，`aarch64` 服务器会自动拉取 `linux/arm64`。生产环境如需锁定版本号，可把 `latest` 换成固定版本，例如 `karaggagent/agent-insight:0.5.0`。

### Q13. 挂载源码运行容器时 `AGENT_INSIGHT_SOURCE_DIR` 起什么作用？更新代码后怎么做生效？

给容器加 `AGENT_INSIGHT_SOURCE_DIR` 环境变量指向挂载进来的源码目录，容器启动时会把源码复制到容器内 `/app/source`，再依次执行 `prisma db push`、`prisma generate`、`npm run build`，最后跑 `node .next/standalone/server.js`；不配置时容器直接运行镜像里打好的 npm 包。更新代码只需 `git pull` 加一次重启（`docker restart agent-insight`），容器会按最新源码重新构建再启动。**该变量必须通过 `-e` 或 compose `environment` 传入，写进 `~/.agent-insight/.env` 不生效**——entrypoint 在读取该文件之前就要决定跑哪份代码。源码改了 `package.json` 新增依赖时必须重新构建镜像。

### Q14. `agent-insight` CLI 支持哪些子命令？`install` 子命令的 5 个步骤是什么？

CLI 支持 `start`、`stop`、`restart`、`status`、`logs`、`install` 子命令，通用选项有 `--port/-p`、`--frameworks`、`--help/-h`。`install` 子命令会依次：1) 需要时 `npm install agent-insight`；2) 启动服务；3) 创建 admin 用户并获取 API Key；4) 安装遥测插件；5) 给 Agent 添加 skill。

### Q15. `--frameworks` 选项可以预选哪些遥测框架？传错会怎样？

可预选的框架有：`opencode`、`openclaw`、`claude`、`codeagent`、`hermes`、`jiuwen`、`llamaindex`、`qoder`、`trae`、`actrail`、`pi-agent`、`codex`（逗号分隔，大小写不敏感）。若缺省或传入了不在此清单的框架名，CLI 会报 `Invalid framework list: <无效项>` 并以 exit code 1 退出。

## Agent 框架接入

### Q16. Agent Insight 当前已接入哪些 Agent 运行时/框架？各自的采集方式是什么？

已接入 OpenCode（原生插件）、Claude Code（OTLP 上报）、Qwen Code（Hook 采集器）、Hermes（原生插件）、Trae IDE（VS Code 插件）、JiuwenSwarm（OTLP 上报）、Langgraph（OTLP 上报）、LlamaIndex（OTLP 上报）。更多平台持续接入中。

### Q17. 默认接入使用什么协议和端点上报 Logs 和 Traces？旧版 watcher 的兼容性如何？

默认接入使用 OTLP/HTTP JSON：Logs 上报到 `/api/ingest/otel/v1/logs`，Traces 上报到 `/api/ingest/otel/v1/traces`。安装脚本末尾会输出一份可手动复制的纯配置环境变量块。旧版 watcher 仅作为兼容方式保留；**同一 OpenClaw 实例只能选择 OTel 或 watcher 其中一种**，避免重复 Trace。

### Q18. Hermes 接入会把插件装到哪里？插件依赖什么？spool 在哪里？失败如何重试？

setup 脚本从 Agent Insight 服务下载固定版本的轻量插件到 `$HERMES_HOME/plugins/agent_insight_hermes/`（未设 `HERMES_HOME` 时默认为 `~/.hermes`），写入 `plugin.yaml` 与 `config.json` 并启用 `agent_insight_hermes`。该插件**只使用 Python 标准库**，不访问 GitHub、不探测 Hermes venv、不额外安装 OpenTelemetry Python 依赖；上游 `hermes_otel` 可以继续用于 Langfuse 等独立目的。每个已完成 span 的 delta payload 先写入 `~/.agent-insight/data/hermes-otel-spool/`，上传成功后删除；断网、HTTP 408/429/5xx 自动退避重试，进程重启后也会继续发送残留 delta 文件。运行日志位于 `~/.agent-insight/logs/hermes-plugin.log`（滚动文件为同目录下的 `hermes-plugin.log.1`），日志不记录 API key 或对话正文。

### Q19. Qwen Code 接入会修改什么文件？如何排查"页面没有新 Trace"？

脚本启用 Qwen Code 原生 OpenTelemetry，并在 `~/.qwen/.env` 中写入 OTLP/HTTP Trace endpoint、认证 Header 和 `service.name=qwencode`，不改写其他采集器配置；上报地址固定为平台地址加 `/api/ingest/otel/v1/traces`。采集器先把会话、工具、LLM、Skill、子 Agent 和 Hook 数据写入 `~/.agent-insight/otel_data/qwencode/` 下按账号隔离的 spool 再异步上传。如果页面没新 Trace，先确认 `~/.qwen/.env` 中的 endpoint 与当前平台地址一致，再检查该 spool 目录是否持续堆积；上传连续失败时，最新的会话编号和失败原因会写入同账号目录下的 `logs/last-upload-failures.json`（该文件不写 API Key 或服务端响应正文）。

### Q20. LlamaIndex 接入的 Python 模块叫什么？它部署到哪里？业务依赖由谁管理？

模块名为 `agent_insight_llamaindex`，由 Agent Insight 服务端直接分发。安装器先在所选环境中 `pip install llama-index-observability-otel==0.6.4`，再从当前实例下载运行时归档并直接部署到 `~/.agent-insight/collectors/llamaindex/current/`，**模块本身不写入 `site-packages`**，运行时 zip 有意不包含 `pyproject.toml`。LlamaIndex、模型 SDK 与 MCP Tool 等业务依赖仍由项目自己的 Python 环境管理；可通过 `AGENT_INSIGHT_LLAMAINDEX_VENV` 指定虚拟环境根目录，或用 `AGENT_INSIGHT_LLAMAINDEX_PYTHON` 直接指定解释器。

### Q21. Qoder CN 产品家族有哪几种形态？它们的 spool 数据相互隔离吗？默认根 Agent 名称分别是什么？

四种形态：Qoder CN Desktop、Qoder for JetBrains、Qoder CN CLI、Qoder Work CN。它们使用同一套 OTLP Trace 结构，但安装入口和 spool **相互隔离**，数据统一位于 `~/.agent-insight/otel_data/qoder/<product>/<api-key-hash>/`，切换 API Key 后会自动使用新的摘要子目录，不会混用不同产品、不同账号的 pending、retry 或 uploader lock。默认根 Agent 名称：Desktop 与 JetBrains 为 `Qoder`、CLI 为 `Qoder CLI`、Work 为 `Qoder Work`；Quest 模式为 `Quest Agent`、专家团模式为 `Experts Agent`。

### Q22. CodeAgent 接入在 Windows 上如何注入 OTel 配置？cron/systemd 等独立环境怎么办？

Windows 安装 `%USERPROFILE%\.agent-insight\bin\codeagent.cmd` 和 `codeagent-wrapper.ps1`，并把该目录置于用户级 PATH 前面，`codeagent_otel_env.ps1` 负责刷新当前 PowerShell 会话并清理旧 Alias/函数。包装器每次都排除自身目录查找真实 CodeAgent，只为 CodeAgent 子进程注入 OTel 配置。cron、systemd、容器、Windows 服务等**不继承用户 PATH 的独立环境需显式加入对应 `~/.agent-insight/bin` 目录或直接调用包装器**。CodeAgent 当前同时发出 Logs、Traces 和 Metrics，但平台只把 `service.name=CodeAgentOC` 的 Logs 写入 `~/.agent-insight/otel_data/codeagent` 并聚合为 `framework=codeagent`，同来源的 Traces/Metrics 返回成功后直接丢弃。

### Q23. Codex CLI 与 IDE Extension 用什么双通道采集？写入 spool 前会脱敏哪些内容？

Codex 通过公开 Hook 与原生 OTel Logs **双通道采集**，使用 loopback relay 合并为同一条 Trace；安装器接受 `>=0.145.0` 的可解析 Codex CLI 版本。采集器不读取 `transcript_path`，写入 spool 与上报前会递归脱敏 API Key、token、secret、password 等密钥赋值以及本地 Windows、UNC、`/Users/...`、`/home/...` 路径；Token 用量字段保留数值。VS Code、Cursor 与 Windsurf 可安装同一 VSIX，以公开 API 采集 FileEdit 和 Terminal 事件。

## Skill 全生命周期

### Q24. Skills 模块包含哪四个页面？它们的职责分别是什么？

包含 **Skills Hub**（查看 Skill 列表、版本、状态和入口的统一总览页）、**Skills 生成**（根据需求描述自动生成 Skill 初稿）、**Skills 评测**（从静态合规、触发分析、用例分析和 A/B 测试角度评估 Skill 效果）、**Skills 优化**（基于分析结果修订已有版本并发布新版本）。

### Q25. Skill 在平台中通常经历哪 4 个连续环节？

1) **管理**：把 Skill 作为资产纳入平台，查看列表、版本与状态；2) **生成**：根据需求描述自动生成 Skill 初稿；3) **分析**：判断 Skill 是否触发正确、结构是否规范、效果是否真的提升；4) **优化**：基于问题和结果反馈迭代出新的 Skill 版本。推荐顺序是"管理 → 生成 → 分析 → 优化"。

### Q26. 哪些情况适合把能力沉淀成 Skill？哪些不太适合？

适合：某个任务会被反复执行、调用条件可被相对清晰地描述、希望多个 Agent 复用同一套能力、希望对这项能力做独立分析和优化。不太适合：只是一次性临时实验、能力边界非常模糊、还没有稳定场景不知道何时该触发。

### Q27. README 中演示的 Skill 生成需求示例是什么？生成后如何走完闭环？

示例需求是"创建一个 Skill，当用户请求查看系统信息时，自动执行 shell 脚本收集当前系统的关键信息（操作系统、CPU、内存、磁盘、网络等），以 Markdown 报告呈现给用户"。生成后单击"保存并发布"；进入 Skills 评测点"静态合规"再点"重新扫描"查看分析结果；进入 Skills 优化选择 Skill 点"优化"，选择可优化项点"开始优化"或直接输入优化需求点"发送"；优化完成后点"发布为 v1"，系统自动保存为新版本。

### Q28. 什么情况下 Skill 总是误触发或不触发？应去哪里排查？

优先去 Skills 评测总览看：触发分析结果、静态合规是否存在结构性问题、是否有边界样本覆盖不足。

### Q29. 生成出来的 Skill 可以直接长期使用吗？

通常不建议。更推荐：先生成初稿，确认结构与边界，进入分析页看效果，再进入优化形成更稳定版本。

### Q30. 新用户首次登录注册后，平台会自动注入哪些内置示例？

会自动注入一套内置示例：`messages 日志分析` 数据集 + `linux-messages-auth-triage-demo` Skill + 三条示例 Trace；客户端安装后还会生成本地示例日志 `~/.agent-insight/example/messages`，**无需接入真实 Agent**即可照着内置示例端到端走查跑通"智能诊断 → Skill 生成 → 评测 → 优化"全流程。

## 评测中心

### Q31. 评测中心负责做什么？核心页面有哪些？

评测中心负责把线上问题沉淀为离线测试资产，并对 Agent 或 Skill 做可重复、可比较的质量验证。核心页面包括**评测数据集**、**评估器**和**评测执行**。

### Q32. 评测数据集有哪两种类型？分别适用于什么场景？reference_output 是什么？

**理想输出评测集**适用于有标准答案的场景，重点比较最终输出是否与参考结果一致；**轨迹评测集**适用于需要检查执行过程的场景，除输入和预期输出外还会记录轨迹信息。`reference_output` 是评测样本中的标准答案或参考输出字段，是结果比对的重要基线。

### Q33. 评估器是什么？LLM Judge 适合什么场景？

评估器是给一次执行结果或轨迹打分的规则集合，用来定义"什么叫好，什么叫不好"。LLM Judge 是由模型按评价标准打分的评估方式，适合难以用纯规则覆盖的复杂质量判断。

### Q34. 结果评测和轨迹评测的区别是什么？根据开发者指南术语表，Outcome 与 Routing evaluation 各指什么？

结果评测关注最终输出是否正确、完整、符合预期；轨迹评测关注中间过程是否合理，例如有没有按预期调用工具、是否走了正确步骤。开发者指南进一步区分：**Outcome evaluation** = 最终答案是否与标准答案匹配；**Routing evaluation** = Agent 是否调用了预期的 Skill。

### Q35. 第一次评测应该准备多少样本？为什么？

建议从 5 到 20 条高价值样本开始即可。重点是代表核心场景、包含典型失败、能支撑真实决策，不要一开始就追求大规模。

### Q36. 为什么修完问题后仍然不确定是否真的变好了？应该怎么做？

这通常说明还没有稳定的回归集。推荐做法：从真实 Trace 里提炼高价值样本，建立数据集，配好评估器，在修改前后跑同一批样本对比。

### Q37. 评测结果很奇怪，可能的原因有哪些？

结果异常不一定意味着目标对象有问题，也可能是：数据集样本设计不合理、参考答案不清晰、评估器过严过松或不匹配当前任务。建议同时回看评测数据集、评估器和结果分析。

### Q38. 评测中心提供哪四个结果类预置评估器？它们何时执行？

提供准确性、答案质量、忠实度和指令遵循四个结果类预置评估器，**只在用户主动运行实验时执行**；质量监控不再包含结果维评测。

## 运行观测与诊断

### Q39. 运行观测模块的核心作用是什么？包含哪些页面？

运行观测用于还原 Agent 在真实环境中的执行事实，支撑问题定位、样本筛选与后续分析。核心关注：一次执行具体发生了什么、异常更可能出在哪里、哪些样本值得继续沉淀、推理基础设施是否参与了异常。页面包含**链路追踪**、**智能诊断**、**质量监控**（当前暂未开放）和**推理 Infra**。

### Q40. 链路追踪、智能诊断、推理 Infra 各自的职责是什么？质量监控当前状态如何？

链路追踪是主入口，用于查看一次执行从入口到结束的完整 Trace，适合完成样本筛选、过程还原与关键节点定位；智能诊断基于 Trace 上下文对失败、异常或效果偏差样本做归因分析，输出问题类型、证据节点与建议方向，更适合作为 Trace 阅读之后的辅助判断层；推理 Infra 用于登记和观测 vLLM / OpenAI 兼容推理服务的 Prometheus 或 OTLP 指标，在 Trace 详情的 Infra tab 中展示 session 时间窗内的诊断结论、瓶颈类型和指标曲线。质量监控面向趋势观察与持续巡检，但**当前页面暂未开放使用**，现阶段仍以链路追踪和智能诊断为主要路径。

### Q41. 大多数问题应按什么顺序处理？

1) 先在链路追踪里找到异常执行；2) 进入详情看 Trace、Span 和上下文；3) 如果怀疑是推理服务慢或不可用，查看 Trace 详情里的 Infra tab 或进入推理 Infra 页面；4) 对失败或偏差样本使用智能诊断；5) 对重复出现或高价值样本沉淀为评测数据集或优化输入。

### Q42. 什么情况下先看链路追踪，什么情况下先看智能诊断？

先看链路追踪：当你需要理解原始执行过程；先看智能诊断：当你已经确认样本有问题，想快速得到归因方向。最常见路径是先 Trace，后诊断。

### Q43. 多 Agent 场景下 Trace 看起来很乱怎么办？

先使用主 Agent / 子 Agent 范围筛选：先只看主 Agent 理解整体入口流程，再看子 Agent 定位派生任务细节。如果一上来就把所有层级混在一起看，很容易误判根因。

### Q44. 执行没报错但结果明显不对属于什么问题？应如何排查？

这通常属于**效果偏差类问题**，不一定会以异常状态直接暴露。建议：在链路追踪找到对应样本，看关键 Span 的输入输出，必要时进入智能诊断，将高频问题转成数据集做回归验证。

### Q45. Trace 和 Span 分别是什么？

Trace 是一次完整任务执行从开始到结束的全链路记录，是观察真实执行的最小完整单位；Span 是 Trace 里的单个执行片段，表示一次更细粒度的步骤，例如 LLM 请求、工具调用或子 Agent 执行。

### Q46. 运行观测和评测中心有什么区别？

运行观测看真实线上执行发生了什么；评测中心把问题转成可重复、可回归的离线验证。前者偏向发现与还原问题，后者偏向验证与回归问题。

## 架构与数据模型

### Q47. Agent Insight 的整体架构形态是什么？为什么这样选？

整体是一个**以领域引擎为核心的分层全栈单体**：轻量的 Next.js 路由处理器将工作委派给 `src/lib/engine/*` 子系统；持久化隐藏在 `DatabaseAdapter` 之后；框架特定的接入逻辑隔离在 parser/watcher 与 `FrameworkAdapter` 注册表；LLM 工作委派给内部 opencode agent 运行时（遗留/示例路径仍走 deepagents/LangGraph）。选模块化单体（单 Next.js 进程）是因为自托管要"一键安装、零运维"，单进程最简；代价是牺牲独立伸缩能力。

### Q48. DatabaseAdapter 双实现的 ADR 是什么？如何切换 SQLite 与 OpenGauss？

定义 `DatabaseAdapter` 接口，`PrismaAdapter`（SQLite）与 `OpenGaussAdapter`（pg）双实现；工厂 `getDatabaseAdapter()` 按 `process.env.DB_HOST` 是否存在切换——有则 OpenGauss，否则 Prisma/SQLite（`db-interface.ts` 行 1059–1079）。后果是单机开箱即用 + 企业可换信创库，代价是接口方法签名大量 `any`（弱类型），业务需绕开 Prisma 强类型走通用接口。

### Q49. Execution 多 Agent 拆分是怎么实现的？

一次主 agent trace 拆成 **1 条 root + N 条 sub-agent**，靠 `parentExecutionId` 串、`rootExecutionId` 共享根；列表默认按 `isSubagent=false` 过滤（schema 行 97–114）。

### Q50. 评测为什么采用 Evaluation + SkillIssue 两表设计？

`Evaluation` 按 `type` 区分 static/dynamic/trigger，`SkillIssue` 一行一个优化点，`source` 从 `Evaluation.type` denormalize 以避热路径 join；旧 `SkillOptimizationPoint` 单表已废弃（schema 行 556–559）。另外 dynamic 评测重跑不删旧记录，多评估器并存，prevalence 由读取时派生（重评懒删除模型）。

### Q51. 为什么 schema 中大量字段用 String 存 JSON？代价是什么？

这是 SQLite 无原生 JSON/array 类型下的折中，大量字段用 `String` 存 JSON（如 `tags`、`casesJson`、`configJson`、`itemsJson`）。代价是类型安全与查询能力——schema 演进靠注释约定，无法用 DB 查询/约束保证一致性。

### Q52. 架构文档推断出的核心架构目标有哪些？

1) **框架无关性是首要架构目标**（依据显式 `FrameworkAdapter` 注册表设计、按框架分流的 parser/watcher、基于 OpenTelemetry 标准协议的接入端点）；2) **数据主权/自托管是硬约束**（默认 SQLite 落本地、安装走 `npx` 单机脚本）；3) **可观测性是一等目标**（集成 OpenTelemetry SDK + Langfuse）；4) **Skills 全生命周期管理是核心目标**；5) **Agent 智能诊断是核心目标**（独立 fault/debug 能力域 + `engine/agent-debug` 子系统）。

### Q53. 核心流程"一次 Agent 运行数据的接入→落库"涉及哪些组件？设计铁律是什么？

Agent 宿主机 POST 运行 trace（OTel/上传/proxy）→ `/api/ingest/*`（otel|upload）→ `FrameworkAdapter`/parser 按 framework 解析+归一化 interactions（`extractSkills` / `normalizeForStorage` 纯函数）→ data-service 的 `saveExecutionRecord` → DatabaseAdapter `upsertExecution`（用 `parentExecutionId`/`rootExecutionId` 串树）。设计铁律：**适配器是纯函数，不碰 DB/网络，只做转换；入库唯一出口是 `saveExecutionRecord`**。

### Q54. Agent Insight 的部署形态有哪几种？

1) **单 Node 进程** `next start -p 3000`（`output: 'standalone'`）；2) **CLI 安装器** `bin/cli.js` → `scripts/{install,start,stop,status,restart}.js`，供 `npx agent-insight install` 一键装；3) **进程管理脚本** `scripts/restart.sh`（生产）/ `scripts/restart_dev.sh`（开发）；4) **容器部署** `docker build` 后运行，默认暴露 3000，`/data/agent-insight` 作为持久化根目录；5) **客户端接入**通过 `curl http://<host>:3000/api/ingest/setup | bash` 分发 watcher/插件到 Agent 宿主机。

## 开发约定

### Q55. 仓库协作依赖哪两个固定 remote？默认 PR 流程是什么？

`origin` 是分支推送仓 `gyctl/agent-insight`（日常 feature branch push 目标），`upstream` 是上游合并仓 `openeuler/agent-insight`（MR 默认目标分支 `master`）。默认流程：从 `upstream/master` 起新分支（或基于它 rebase）→ 推到 `origin` 的 feature 分支 → 提 PR（GitCode 称 MR），target 为 `upstream` 的 `master`。禁止直接推 `upstream/master`，禁止未经用户授权执行 `push --force`、`reset --hard`、删分支等破坏性操作。第一次操作前仍须 `git remote -v` 核对实际配置。

### Q56. Commit 规范要求使用什么前缀？对 `--amend`/`--no-verify` 有什么要求？

使用 **Conventional Commits** 前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:` / `perf:` / `style:`。subject 可中文，保持一行简述 + 可选 body，一次 commit 聚焦一件事，不要把无关改动捎带进同一个 commit。除非用户明确要求，不要用 `--amend` / `--no-verify`；pre-commit 失败就修问题、重新 stage、新建 commit。

### Q57. 仓库托管在哪个平台？为什么不能用 `gh`？

仓库托管在 **gitcode**（不是 GitHub），不要用 `gh`。push 前先 `git remote -v` 确认 `origin` 仍指向 `gyctl/agent-insight`，然后 `git push -u origin <branch>`，输出里会有 MR 创建链接，连同建议的 PR 标题/描述转发给用户。⚠️ GitCode MR 页面默认 target 可能仍是源仓的 `master`，创建时必须确认 base repository 为 `openeuler/agent-insight`、base branch 为 `master`。

### Q58. 哪些改动必须先写设计文档？写到哪里？

涉及数据模型变更（Prisma schema）或新增 API 路由的改动**必须写设计文档**，落到 `docs/design/<topic>/`（按 `phase1 需求分析 / phase2 需求设计 / phase3 开发计划` 组织），并在 `docs/design/README.md` 需求清单追加一行，对齐后再动手。实现路径有多种合理选择、跨多个模块、需要引入新抽象、或自己感到"这事不止改几行"的情况则需先讲思路对齐（不一定写文档）。小改动（bug fix、文案、单文件局部调整）直接动手，事后说明即可。

### Q59. Skill 为什么用 `name` 而非 `id` 做对外 key？有什么代价？

前端路由 `/skill-opt/[name]/[version]` 走 name；新 API 路径用 `:name`（如 `/api/skills/:name/...`），不要用 `:id`；DB 里仍有 `id` 字段只在内部使用。代价：**skill 重命名会断 URL**——接受这个代价，rename 本来就该是大动作。

### Q60. 设计系统约定要求开发者如何处理颜色令牌？哪些局部色板要避免？

写新样式一律引用共享令牌（`var(--foreground*)` / `--color-*` / `--radius-*` / `--primary` …），优先复用 `src/components/ui/*` 组件与 `src/app/globals.css` 里的 `.ai-*` 工具类。**唯一真源是 `src/app/globals.css` 的 `:root` / `[data-theme='dark']`**（中性灰阶 + 单一 indigo 主色 + 3 个语义状态色）。不要新建 `--<feature>-*` 局部色板（历史遗留的 `--sk-*` / `--ev-*` / `--sa-*` / `--gh-*` 是设计漂移正在收敛，别再加）；主色只用于交互态，不要拿来做装饰。改了令牌或视觉规范要同步 `08-design-system.md` 与 `design-tokens.json`。

### Q61. 完工前默认要先跑什么验证？是否默认启动 dev server 走 UI？

完工前默认先跑测试 `npm run test`（执行 `test/**/*.test.ts`）。**不要默认执行 `bash scripts/develop_start.sh`**，先询问用户是否需要启动 dev server 并走一遍 golden path + 至少一个边界 case，仅在用户确认后执行；未执行浏览器验证时，明确告诉用户"未在浏览器中验证"，不要默认声称成功。类型检查/lint 验证的是代码正确性，不是功能正确性。

### Q62. 未经用户授权，哪些操作是禁止的？

禁止：推送到任何远端、创建/合并 PR、关闭 issue；修改 CI、`package.json` 的 scripts、`.env*`；升级/降级依赖、删除依赖；删除文件、目录、分支；改 git config。读取、跑测试、本地 dev、改 src 下的代码可以自由进行。

## 运维与排障

### Q63. 已经完成接入但链路追踪里没数据，应按什么顺序排查？

1) 当前 Workspace 是否正确；2) Agent 使用的 API Key 是否来自当前账号/当前 Workspace；3) 安装指导里的命令是否真的在目标运行环境执行过；4) Agent 是否已经实际产生过一次执行；5) 服务端地址和网络连通性是否正常。如果最近切换过账号，尤其要注意是否复制了旧的 API Key。

### Q64. 数据跑到别的账号或别的 Workspace 了，最常见原因是什么？

最常见原因：客户端使用了旧的 API Key、复制安装命令前没有刷新当前登录状态、不同环境复用了错误配置。优先从安装指导和当前 API Key 归属检查起。

### Q65. 已经有 Trace 但 Agent 管理里看起来没有对应 Agent，是什么情况？

通常说明这个对象还是**未注册 Agent**：数据已经上报，但尚未在 Agent 管理中正式登记。这种情况不是不能用，但会影响资产治理和理解成本，建议尽快补登记。

### Q66. 5 分钟上手指南建议 30 秒后仍看不到数据时按什么顺序排查？

1) 先查看客户端日志文件 `~/.agent-insight/logs/opencode_uploader.log`；2) 确认客户端到服务端的网络是否通顺；3) 是否选中了正确的 Workspace；4) Agent 使用的 API Key/配置是否来自当前 Agent。仍无法解决时参考常见问题。

### Q67. 怎样用 `scripts/db_archive.sh` 归档指定时间之前的历史数据？预览和实际执行有什么区别？

脚本默认读取 `~/.agent-insight/data/witty_insight.db`，也可用 `--database` 指定数据库文件；脚本可单独复制到服务器运行，只依赖 `bash`、`sqlite3`、`gzip`、`sha256sum`/`shasum`。先加 `--dry-run` 预览将被选中的数据；归档文件完成校验后，脚本默认事务性删除源数据。**如果只想导出副本、不删除数据库数据，必须明确传入 `--keep-source`**。`traces` scope 提供 `--user` 时只从 `Execution.user` 与指定账号完全一致的根 Trace 开始筛选；不提供 `--user` 时归档时间窗口内所有账号数据，manifest 中记录为 `<all-users>`。

### Q68. 归档一个时间区间怎么写？时区如何解释？infra-metrics scope 接受 `--user` 吗？

时间区间使用 `[from, to)` 语义（包含起点、不包含终点）。可以只写 `YYYY-MM-DD`，此时按运行脚本机器的本地时区解释为当天 `00:00:00`；写到分秒时必须带 `Z` 或数字时区（如 `2025-01-01T00:00:00+08:00`）。基础设施采样使用 `infra-metrics` scope 按 `InfraMetricSample.tsMs` 筛选；`InfraMetricSample` 没有账号字段，因此 `infra-metrics` **不接受 `--user`**。

### Q69. 归档由哪些文件组成？怎样检查和恢复归档？导入冲突如何处理？

归档由 `.sqlite.gz`、`.sqlite.gz.sha256` 组成；成功清理源数据后还会生成 `.sqlite.gz.purged` 收据（存在 `.purged` 表示该归档对应的源数据已成功清理）。检查用 `bash scripts/db_archive.sh inspect --input <归档文件>`；恢复用 `import --input <归档文件>`（可先 `--dry-run`）。导入要求目标数据库 schema 与归档一致；相同主键且内容相同的数据会被幂等跳过，相同主键但内容不同会终止并回滚整个导入。该脚本目前**仅支持 SQLite**，归档只包含数据库行，不包含 `SkillVersion.assetPath` 等字段指向的外部文件。