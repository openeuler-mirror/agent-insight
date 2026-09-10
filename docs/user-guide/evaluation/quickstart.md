---
title: "跑通第一次评测"
description: "数据集 → 评估器 → 评测的最短闭环"
---

# 跑通第一次评测

本指南用于以最短路径完成一次完整评测闭环：准备样本、配置评估器、发起任务并完成首轮结果判读。

> **Note**
> 首次评测的重点是建立可运行、可解释、可复用的最小闭环，而不是一次性追求大规模覆盖。

## 目标产出

- 一个可执行的小型评测数据集
- 一组基础评估器配置
- 一次完整的评测批次
- 一份可用于后续优化的初步结果

## 前置条件

- 已具备可运行的 Agent 或其他可评测对象
- Workspace 已配置必要模型
- 已整理出若干真实问题样本，或已具备待补充的业务案例

### SWE-bench 等容器 Benchmark 的评测服务

需要官方 Harness 的 Benchmark 还要求独立 Evaluator Controller。评测机只需安装 Git、Docker 和 Bash，支持 Linux 与 macOS；macOS 需先启动 Docker Desktop。部署者 checkout 平台指定的固定 release 后，在仓库中运行：

```bash
bash scripts/start-evaluator.sh \
  --token '<与 Agent Insight 一致的共享密钥>' \
  --bind-address 0.0.0.0 \
  --port 8080
```

Linux 账号无 Docker daemon 权限时可显式使用 `sudo bash`；macOS 不使用 `sudo`。脚本构建并常驻运行 Controller、保留 `/data` journal、等待健康检查并执行 Doctor。每次部署会在新镜像就绪后重建 Controller 容器；Doctor 通过后只清理旧的 `agent-insight-benchmark-evaluator` 镜像，持久化数据卷和 Case 镜像都不受影响。Controller 构建默认使用华为云 Debian 与 PyPI 镜像，任一快源失败时自动回退官方源；SWE-bench Harness 从官方 GitHub codeload 下载固定 commit 压缩包并校验固定 SHA-256。Node 基础镜像保留官方名称并复用宿主 Docker daemon 的 registry mirror。SWE-bench Case 镜像默认也直接使用官方名称，由宿主 Docker daemon 根据自身的 registry mirror 配置拉取；如需指定代理仓库，可在启动命令前显式设置 `SWE_BENCH_IMAGE_PROXY_PREFIX=<registry-prefix>`，脚本会先通过该代理拉取并恢复官方 tag，失败后回退官方地址。在线拉取的 Case 镜像按 registry digest 冻结；通过 `docker save/load` 离线导入、没有 `RepoDigests` 的镜像按不可变 Image ID 冻结。脚本不会修改宿主全局 Docker 配置。工作树有未提交内容时允许启动，但镜像会标记为 `dirty` 且不能视为可复现的正式发布构建。默认启动不会拉取 SWE-bench Case 镜像；收到真实任务或显式执行 Smoke 后先复用本地目标镜像，只有本地不存在时才按需拉取：

```bash
bash scripts/evaluator-doctor.sh
bash scripts/evaluator-doctor.sh --smoke swe-bench
```

正式成绩要求评测机为 Linux x86_64、使用官方 Case 镜像，并且 `/health` 中目标 Evaluator 同时显示 `ready=true` 和 `formalEligible=true`。`ready=true` 只说明服务可运行，不代表当前环境可产出正式分数；ARM64 或非官方镜像仅用于链路 Smoke。

在 Agent Insight 主服务所在机器上，用权限为 `0600` 的 Token 文件更新通信目标：

```bash
node scripts/configure-evaluator-target.js \
  --public-base-url https://agent-insight.example.com \
  --evaluator-base-url https://evaluator-01.example.com \
  --token-file /secure/evaluator-token
```

配置写入 `~/.agent-insight/data/config/benchmark-evaluator.env`，下一次 Benchmark 操作自动热加载，不需要重启 `scripts/start.sh` 启动的 Agent Insight。评测服务通过 REST 回传结果，由 Agent Insight API 写入平台数据库和 Artifact Store；评测机不需要平台数据库凭证或独立业务数据库。

默认 `token` 模式适合生产环境。若评测服务端口和 Agent Insight 回调入口已经由安全组或防火墙严格限制为两台机器互访，可显式关闭双向 Bearer 鉴权，双方必须同时使用 `none`：

```bash
# 评测机
bash scripts/start-evaluator.sh \
  --auth-mode none \
  --bind-address 0.0.0.0 \
  --port 3001

# Agent Insight 主服务机器
node scripts/configure-evaluator-target.js \
  --auth-mode none \
  --public-base-url https://agent-insight.example.com \
  --evaluator-base-url http://evaluator-01.example.com:3001 \
  --allow-insecure-http true
```

`none` 不再要求 Token 文件，也不会在任务下发、Artifact 下载、进度、证据或完成回调中发送或校验 Authorization。它不会自动配置网络边界；若 3001 或回调入口能被非目标机器访问，不应使用该模式。Doctor 的 `runtime.authMode` 会显示实际生效模式。

开发阶段如果 Agent Insight 和执行器在同一台机器、Evaluator 在远端，并且远端只能通过隧道或公开地址回调，可使用：

```bash
node scripts/configure-evaluator-target.js \
  --public-base-url http://host.docker.internal:39001 \
  --executor-callback-base-url http://127.0.0.1:3000 \
  --evaluator-base-url http://evaluator-dev.example.test:3001 \
  --allow-insecure-http true \
  --token-file /secure/evaluator-token
```

此可选项只覆盖下发给执行器的回调地址；Evaluator 仍使用 `--public-base-url` 回调。未提供时两者统一使用公开地址，适合正式部署。执行器仍会校验回调 URL 的 origin 和路径，该选项不会放宽安全检查。前端发起的 Benchmark 与真实 Smoke 共用这套平台配置。

Agent Insight、执行客户端和 Evaluator 都部署在同一台机器时，`--executor-callback-base-url` 应设置为 `http://127.0.0.1:3000`，不要填写该机器的公网 IP。部分云主机无法通过公网 IP 回环访问自身端口；配置更新只影响尚未冻结执行 Outbox 的新任务，已经开始的旧任务仍保留原回调地址，应结束后重新发起。

执行客户端会把 Artifact 上传和完成回调作为独立的持久化投递队列处理：网络失败时按指数退避重试，单次回调最多等待 30 秒，并且重试期间不占用 Agent 执行槽，后续 Case 仍可执行。Git 工作区的 shallow fetch 单次最多等待 120 秒，只对白名单内的 DNS、连接中断、超时、curl 传输和部分 5xx 等瞬时网络错误进行最多 3 次尝试；每次重试都重建临时仓库，第三次仅对该命令使用 HTTP/1.1，不修改宿主 Git 配置。仓库不存在、revision 不存在、鉴权、证书或磁盘错误不会重试。

平台每 30 秒检查一次运行中的 Benchmark。Agent 执行侧：Git 工作区准备阶段最多允许连续 7 分钟无进度；Agent 阶段超过任务上限再加 90 秒宽限期；收集、上传、清理阶段连续 5 分钟没有新进度时回收。评测侧：等待下发、下发结果不确定、证据收集/上传/清理和结果归一化连续 5 分钟无进度时回收；官方 Harness 超过评测任务上限再加 90 秒时回收。回收会把 Case 明确置为失败并通过持久化续跑继续结算实验，服务重启后也会恢复，不会让页面永久停在“正在生成 Trace”或“运行中”。

评测服务只有收到结构完整、字段匹配的终态 ACK 才清除本地待回调任务；空响应、非 JSON 或字段不一致的 HTTP 2xx 仍会保留并重试。SWE-bench 正式结果还会对照冻结的实例、测试名单和 `report.json` 内容复核；常见明确错误码包括 `EVALUATION_TIMEOUT`、`SWE_HARNESS_RESULT_INVALID`、`RAW_RESULT_SCHEMA_INVALID`、`SWE_FORMAL_RESULT_INELIGIBLE`、`SWE_EVIDENCE_CONTRACT_INVALID` 和 `RESULT_MAPPING_FAILED`。

## 推荐流程

首次建立评测闭环时，建议按以下顺序推进：

1. 准备一组小规模、高代表性的样本
2. 选择核心评估器
3. 发起一次评测任务
4. 核对执行状态与异常样本
5. 阅读结果并决定下一步动作

## 步骤一：准备小型数据集

首次运行建议控制在 5 到 20 条样本，以便快速建立闭环并降低分析成本。

样本应优先覆盖以下场景：

- 典型正常场景
- 高频失败场景
- 易错边界场景

样本来源通常包括以下两类：

- 人工整理的业务样本
- 从真实 Trace 中提炼的高价值案例

如尚未准备数据集，可先阅读 [评测数据集](./datasets) 与 [从 Trace 构建数据集](./dataset-from-trace)。

## 步骤二：选择评估器

评估器决定本次评测的判定口径。首次运行建议优先选择最关键的结果评估器，再根据需要补充过程评估器。

推荐配置原则如下：

- 优先选择 1 个核心结果评估器
- 必要时补充 1 个过程类评估器
- 避免首轮配置过多评估器，以免结果解释失焦

## 步骤三：发起评测任务

完成数据集与评估器准备后，进入 [评测执行](./run-evaluation) 组合以下要素：

- 本次使用的数据集
- 被评测的 Agent 或目标对象
- 本次采用的评估器集合

任务启动后，系统会生成一个评测批次，并按样本逐条执行。

## 步骤四：确认运行状态

首次运行时，应优先确认评测流程是否稳定进入执行阶段，重点关注以下信号：

- 批次是否创建成功
- 样本是否开始进入 `running`
- 是否出现明显的 `failed`
- 已完成数量是否持续增加

若失败发生在 Benchmark 官方评测阶段，应优先展开 Case 详情查看错误码：`SWE_FORMAL_RESULT_INELIGIBLE` 表示环境仅适合 Smoke；`SWE_EVIDENCE_CONTRACT_INVALID` 表示报告/证据与冻结任务不一致；`EVALUATION_TIMEOUT` 表示 Harness 已超时并被终止。这些错误不会被误计为业务不通过或 0 分。

这一阶段的核心目标是确认流程已正常运行，而非立即得出深度结论。

## 步骤五：阅读首轮结果

首轮结果产出后，建议先建立整体判断，再进入样本级分析。优先回答以下问题：

- 平均分处于什么区间
- 哪些样本最容易失败
- 失败是否集中在同一类问题
- 问题更可能来自评测对象、评估器还是数据集设计

## 首轮运行后的常见处理

### 情况一：样本过少，结论不稳定

继续补充数据集，优先增加代表性场景、失败场景与边界场景。

### 情况二：分数较低，但失败模式清晰

可直接将问题模式整理为优化需求，并进入对应的修复或优化流程：

- [Skills 优化](../skills/optimize)
- 目标 Agent 的相关修复流程

### 情况三：结果缺乏可解释性

通常需要优先回查以下三项：

- 评估器数量是否过多
- 数据集样本是否混入多个评测目标
- 预期输出是否足够清晰稳定

## 实践建议

- 首轮评测优先追求闭环可运行，而非覆盖面最大化
- 优先将最具业务价值的问题样本纳入数据集
- 保持核心样本稳定，用于版本迭代后的重复回归
- 在样本、评估器与评测对象之间维持清晰的对应关系

## 下一步

- 系统整理样本： [评测数据集](./datasets)
- 从运行样本沉淀数据： [从 Trace 构建数据集](./dataset-from-trace)
- 理解评分逻辑： [评估器](./evaluators)
- 继续查看执行与结果： [评测执行](./run-evaluation) / [结果分析](./analyze-results)
