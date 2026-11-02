---
title: "实验执行环境准备接口"
description: "准备任务、幂等上下文与执行环境就绪判定。"
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

OpenCode 向导预检与执行前校验共用按运行时主版本分流的入口：v1 保留 `debug config`、认证来源和 `models` 目录检查；v2 调用 `api --standalone model.list`（未选模型时为 `model.default`），以原生目录中的 `providerID/id` 和 `enabled` 判断可用性，不解析 v2 `debug config` 的配置来源数组，也不套用 v1 认证文件格式。CLI 输出只进入权限为 `0600` 的临时文件并在检查后清理，不将配置或底层异常透传到页面。目录读取失败为 `MODEL_CONFIGURATION_UNREADABLE`，所选模型不可用为 `MODEL_UNAVAILABLE`，缺少可用默认模型为 `MODEL_CONFIGURATION_MISSING`；不发起模型推理请求。执行前通过可取消子进程检查，保留 v2 错误分类并返回解析后的模型标识；预检增量能力上报与常规探测一致，为已就绪的 v1/v2 声明 `skillSnapshotVersion: 4`。Skill 用例生成与 A/B 使用共享能力策略校验 `supportsSkillSnapshot`，触发分析额外校验 `supportsTriggerRouting`；前端筛选、提交和服务端校验保持一致。缺失能力返回对应错误并提示检查常驻客户端与能力探测结果，不依据缺失字段直接推断 OpenCode 版本过旧。

任务复用 `ReliabilityCommand`，白名单动作是 `PREPARE_EXECUTION_ENVIRONMENT`，不新增 Prisma 表。指令成功完成与环境就绪分开：`SUCCEEDED` 的结果可能为 `needs_action`；只有 `ready` 可以通过。准备动作期限为 45 分钟，ACK 仍遵循现有送达期限，其他动作默认期限不变。请求和回执不携带模型密钥、任意脚本路径或 Shell 命令；`agentOptions` 仅作为执行上下文，不用于环境安装命令。

检查和重启恢复不触发全量能力扫描。执行端复用本轮已验证事实，通过现有 `PUT /api/reliability/client/v1/capabilities` 的 `partial: true` 增量同步平台、组件和最终执行 Profile；服务端合并更新，保留其他 Agent、模型与组件。Profile 摘要改变时，未检查 Runtime 的旧就绪状态失效。可靠性数据集额外通过现有 Worker heartbeat 的 `partial: true` 合并所选平台 inventory，不枚举其他 Agent 或模型目录；普通全量上报语义不变。增量同步成功后才回报环境 `ready`，避免后续实验冻结安装前的身份。

环境终态通过 HTTP 确认，未确认结果由环境任务记录负责恢复，不能用通用回执队列直接回放过时的 `ready`。恢复前按原上下文只读复查，过期或缺少上下文则要求重新检查。指令回执通过带状态条件的原子更新防止晚到 ACK/进度覆盖已完成结果；查询就绪结果时再次核对数据集身份和主机健康。


实现依据：[当前实现](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/engine/experiment/environment-preparation.ts)。

[English](../../../en/reference/evaluation/execution-environment.md)
