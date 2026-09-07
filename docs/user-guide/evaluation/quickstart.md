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

Linux 账号无 Docker daemon 权限时可显式使用 `sudo bash`；macOS 不使用 `sudo`。脚本构建并常驻运行 Controller、保留 `/data` journal、等待健康检查并执行 Doctor。工作树有未提交内容时允许启动，但镜像会标记为 `dirty` 且不能视为可复现的正式发布构建。默认启动不会拉取 SWE-bench Case 镜像，只有收到真实任务或显式执行 Smoke 时才按需拉取一个目标镜像：

```bash
bash scripts/evaluator-doctor.sh
bash scripts/evaluator-doctor.sh --smoke swe-bench
```

在 Agent Insight 主服务所在机器上，用权限为 `0600` 的 Token 文件更新通信目标：

```bash
node scripts/configure-evaluator-target.js \
  --public-base-url https://agent-insight.example.com \
  --evaluator-base-url https://evaluator-01.example.com \
  --token-file /secure/evaluator-token
```

配置写入 `~/.agent-insight/data/config/benchmark-evaluator.env`，下一次 Benchmark 操作自动热加载，不需要重启 `scripts/start.sh` 启动的 Agent Insight。评测服务通过 REST 回传结果，由 Agent Insight API 写入平台数据库和 Artifact Store；评测机不需要平台数据库凭证或独立业务数据库。

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
