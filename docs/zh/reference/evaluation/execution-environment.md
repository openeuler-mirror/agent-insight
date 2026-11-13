---
title: "实验执行环境准备接口"
description: "准备任务、幂等上下文与执行环境就绪判定。"
keywords: ["Agent Insight", "执行环境", "环境准备", "幂等请求"]
changefreq: "monthly"
---

用户身份及调用范围见 [HTTP 接口与用户身份](../platform/http-api.md)。

`POST /api/experiments/environment-preparations` 返回 `202`；没有用户身份为 `401`，声明的请求长度超过 256 KiB 为 `413`。普通准备请求的 `requestId` 为 8～100 位字母、数字、下划线或短横线；`mode` 为 `generate/skill-ab/trigger`，`timeoutSeconds` 为 30～3600 整数，`concurrency` 为 1～1024 整数，`caseIds` 最多 500 项。`datasetId` 可为 null，但除 `skill-ab` 外必须选择数据集；其他字段由严格 Schema 校验，未知字段不自动忽略。


| 接口 / 合同 | 输入与输出 |
| --- | --- |
| `POST /api/experiments/environment-preparations` | 接收 `requestId/datasetId/clientId/platform/agent/model/caseIds/mode/timeoutSeconds/concurrency` 及可选 `agentOptions`；同配置入口改为仅传 `requestId/sourceExperimentId`，禁止混入执行目标覆盖；服务端解析数据集接入标识与版本，返回 `202` 和准备任务 |
| `GET /api/experiments/environment-preparations/:taskId` | 按当前用户与仍有效的客户端归属查询任务 |
| 准备任务 | `{ taskId, contextDigest, state, message, issues, durationHint? }`；状态为 `checking/preparing/needs_action/ready/failed` |
| `execution-environment/v1` | `packages/benchmark-protocol/environment.cjs` 及 `.d.cts`，严格校验上下文与摘要 |
| 执行端接入方法 | `checkEnvironment(context, services)` 返回 `{ issues, prepare }`；`prepareEnvironment(context, services, reportProgress)` 执行准备，调用方再次检查 |

实验列表与 Skill 工作台按实验 ID 独立保存忙状态，仅禁用当前行操作，某行完成或失败不解除其他仍在处理的行；两处共用 `SameConfigExperimentAction`，复用 `useExecutionEnvironment` 轮询及恢复逻辑，环境通过后才复制、启动并跳转。服务端 `resolveReuseEnvironment` 按归属读取原实验冻结配置：Benchmark 从绑定恢复运行参数与 Case 选择，普通/可靠性数据集从未删除 Case 的数据集绑定恢复范围，Skill 从快照和取消记录恢复范围。缺少可靠绑定的旧记录提示通过向导重新确认，不猜测主机或扫描全量能力。纯已有 Trace/LLM 对比返回 `{ state: 'skipped' }`，不创建执行端任务；需要客户端执行的 Skill A/B 不跳过。`skipped` 仅是同配置 POST 的无任务响应，不属于执行端状态协议。准备接口不创建实验；启动仍使用原有实验/Skill 任务 API 并保留其就绪校验。

向导环境检查成功后只执行步骤切换：先刷新执行目标并核对原主机/Agent，确认通过后进入第三步；失败留在第二步提示。整个过程不调用路由跳转或整页刷新。后台主机轮询与窗口聚焦刷新在准备期间暂停，进入门禁时使旧请求失效，刷新结果按请求序号防止乱序覆盖，页面卸载同样使未完成刷新失效。页头返回及步骤导航锁定到目标复核结束。向导步骤保存在组件内存，浏览器整页重载会从第一步开始，相同配置再次检查时恢复已有环境任务。

准备请求的 `requestId` 统一使用 `safeUUID()`，兼容通过局域网 HTTP 访问时浏览器未提供 `crypto.randomUUID()` 的情况；网络不确定时复用原请求 ID，明确结束后重试生成新 ID。

向导第 1 步和所有“生成 Trace”的第 2 步每 10 秒、以及窗口重新聚焦时刷新执行目标，包括普通和 Skill 实验。临时能力探测恢复后，页面可自动更新可用目标；环境检查及准备期间仍暂停刷新，继续保留原目标复核。

JiuwenSwarm 个人版的探测和执行兼容 Node.js 20，无需开启实验性 WebSocket 标志；缺少全局 WebSocket 时使用随客户端分发的连接实现。个人版客户端通过 Gateway WebSocket `/ws` 的 `models.list` 获取已配置模型名称；目录读取成功后报告 `jiuwenswarm/main_agent` 的普通 `RUN_EXPERIMENT_CASE` 能力及模型候选。地址默认 `ws://127.0.0.1:19000/ws`，可由客户端环境变量 `AGENT_INSIGHT_JIUWEN_WS_URL` 覆盖。每条 Case 创建独立会话并发送原始输入；选择具体模型时，执行前重新核对目录并通过 `chat.send.model_name` 下发。命令回执携带会话 ID；服务端从 Jiuwen OTLP spool 的会话索引解析唯一 Trace ID，等待对应 Execution 入库后绑定 Case。会话无唯一 Trace、采集器未上传或超时均不会按输入猜测绑定。此能力不包含 Skill 快照、Benchmark 或故障注入。

JiuwenSwarm 环境检查与能力上报共用 Gateway 模型目录探测结果。`agent-runtime/jiuwenswarm/v1` 在目录可读取时为就绪；个人版普通实验预检不查找同名主机 CLI，拒绝非 `main_agent` 或目录中不存在的模型。目录检查不验证模型凭据或推理服务。

模型候选发现按客户端 OpenCode 版本分流。1.x 合并 JSON 模型定义与 CLI 模型目录，认证文件随 `XDG_DATA_HOME` 解析。2.x 使用 `api --standalone model.list` 上报已启用的 `providerID/id`，并通过 `model.default` 标记默认项。原生 API 负责解析 JSON 配置和 `/connect` 凭据。

OpenCode 向导预检与执行前校验共用按运行时主版本分流的入口：v1 保留 `debug config`、认证来源和 `models` 目录检查；v2 调用 `api --standalone model.list`（未选模型时为 `model.default`），以原生目录中的 `providerID/id` 和 `enabled` 判断可用性，不解析 v2 `debug config` 的配置来源数组，也不套用 v1 认证文件格式。CLI 输出只进入权限为 `0600` 的临时文件并在检查后清理，不将配置或底层异常透传到页面。目录读取失败为 `MODEL_CONFIGURATION_UNREADABLE`，所选模型不可用为 `MODEL_UNAVAILABLE`，缺少可用默认模型为 `MODEL_CONFIGURATION_MISSING`；不发起模型推理请求。执行前通过可取消子进程检查，保留 v2 错误分类并返回解析后的模型标识；预检增量能力上报与常规探测一致，为已就绪的 v1/v2 声明 `skillSnapshotVersion: 4`。Skill 用例生成与 A/B 使用共享能力策略校验 `supportsSkillSnapshot`，触发分析额外校验 `supportsTriggerRouting`；前端筛选、提交和服务端校验保持一致。缺失能力返回对应错误并提示检查常驻客户端与能力探测结果，不依据缺失字段直接推断 OpenCode 版本过旧。

任务复用 `ReliabilityCommand`，白名单动作是 `PREPARE_EXECUTION_ENVIRONMENT`，不新增 Prisma 表。指令成功完成与环境就绪分开：`SUCCEEDED` 的结果可能为 `needs_action`；只有 `ready` 可以通过。准备动作期限为 45 分钟，ACK 仍遵循现有送达期限，其他动作默认期限不变。请求和回执不携带模型密钥、任意脚本路径或 Shell 命令；`agentOptions` 仅作为执行上下文，不用于环境安装命令。

检查和重启恢复不触发全量能力扫描。执行端复用本轮已验证事实，通过现有 `PUT /api/reliability/client/v1/capabilities` 的 `partial: true` 增量同步平台、组件和最终执行 Profile；服务端合并更新，保留其他 Agent、模型与组件。Profile 摘要改变时，未检查 Runtime 的旧就绪状态失效。可靠性数据集额外通过现有 Worker heartbeat 的 `partial: true` 合并所选平台 inventory，不枚举其他 Agent 或模型目录；普通全量上报语义不变。增量同步成功后才回报环境 `ready`，避免后续实验冻结安装前的身份。

环境终态通过 HTTP 确认，未确认结果由环境任务记录负责恢复，不能用通用回执队列直接回放过时的 `ready`。恢复前按原上下文只读复查，过期或缺少上下文则要求重新检查。指令回执通过带状态条件的原子更新防止晚到 ACK/进度覆盖已完成结果；查询就绪结果时再次核对数据集身份和主机健康。


实现依据：[当前实现](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/engine/experiment/environment-preparation.ts)。

[English](../../../en/reference/evaluation/execution-environment.md)

### OpenCode 生成与优化执行的终态

Skill 生成与优化由执行引擎统一确认完成。引擎将当前请求的 root user 消息固定为本轮锚点；相同消息 ID 的摘要、diff 等元数据更新不代表新一轮输入，即使晚于 idle 到达也保留完成状态；不同用户消息仍使原轮的完成候选失效。引擎随后读回同一会话中对应的最终 assistant 消息；确认完成时间、完整正文或明确 stop 的已完成工具结果，以及本轮全部工具终态后，才关闭事件流和提示词请求。同步 HTTP 的完成结果只用于触发快照核验，不会被晚到 busy 覆盖，也不能替代快照的终态校验。没有 finish 字段时，还必须有本轮 root idle 及可信完成快照，含工具的中间轮不适用此兜底。旧轮、单独心跳、部分文本或已有文件均不能作为完成证据。快照读取期间的新消息/工具进展会使本次验证失效，短暂未落盘按有限退避重查。事件流漏掉工具完成通知时，按同一消息与工具 ID 的持久化终态补齐结果；快照仍在运行或无法匹配的工具继续阻止完成。

普通响应的成功出口必须有权威终态确认。事件流 EOF 或仅剩心跳不能自行证明完成；EOF 会等待已有的受限快照核验，不提前取消查询。显式 noReply 仅免除助手回复要求，错误与取消仍优先。

关闭已完成请求的传输不会改变调用者的取消信号。用户取消、模型错误及 15 分钟整体执行截止仍会拒绝结果；length、content-filter 或工具中间轮的同步响应不记成功。生成与优化桥接层不再以完成后 200/500ms 或静默 30 秒自行取消执行；缓存会话失效的生成回退仍使用同一执行截止。

企业版 JiuwenSwarm 支持本地账号文件、授权 Agent 发现与选择，仍通过 WebSocket 下发。配置与完整流程见[企业版安装与实验](../../how-to/evaluation/experiments.md#jiuwenswarm-企业版本地凭据与-agent-选择)。
