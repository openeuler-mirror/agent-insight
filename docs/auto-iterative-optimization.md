# 自动多轮 Skill 自优化指南

本文档介绍 Agent-insight 平台的 Skill 自动多轮自优化能力，该能力由 iterative-optimizer skill 驱动，可实现全流程的自动化 Skill 迭代优化。

## 功能概述

自动多轮 Skill 自优化是 Agent-insight 平台的核心功能之一。当前的 Skill 优化需要用户手动执行和评估，然后根据评估结果进行优化，这个过程需要反复进行，操作繁琐且效率较低。支持自动多轮 Skill 自优化后，用户只需设定优化目标，系统会自动执行「执行任务 → 收集结果 → 优化 Skill → 再执行」的迭代循环，直到达成目标或达到最大轮数。这一功能大幅提升了优化效率，降低了用户操作成本。

### 适用场景

当您需要优化现有 Skill 的效果时，可以使用此功能：

- 优化 Skill 的准确率表现
- 批量测试并持续改进 Skill 质量
- 自动化循环优化多个版本的 Skill
- 减少手动反复执行和评估的工作量

### 实现说明

| 文件                                                              | 说明                       |
| --------------------------------------------------------------- | ------------------------ |
| `skills/iterative-optimizer/SKILL.md`                           | 核心迭代优化 skill，负责编排整个自动化流程 |
| `skills/iterative-optimizer/examples/iter-config-template.yaml` | 配置文件模板                   |
| `skills/iterative-optimizer/scripts/oc_run.sh`                  | opencode run 封装脚本        |
| `skills/iterative-optimizer/scripts/init_workspace.sh`          | 工作空间初始化脚本                |
| `skills/iterative-optimizer/scripts/update_round.sh`            | 轮次计数更新脚本                 |
| `skills/iterative-optimizer/scripts/snapshot_skill.sh`          | Skill 版本备份脚本             |
| `skills/iterative-optimizer/scripts/fault_inject.sh`            | 故障注入脚本                   |
| `skills/iterative-optimizer/scripts/evaluate_result.sh`         | 评估结果轮询脚本                 |
| `skills/iterative-optimizer/scripts/parse_config.py`            | 配置文件解析脚本                 |
| `scripts/si-optimizer.md`                                       | si-optimizer 命令文档        |
| `src/app/api/setup/opencode-commands/si-optimizer/route.ts`     | opencode 命令 API          |

### 前置条件

在使用自动多轮优化功能前，请确保满足以下条件：

1. **Agent-insight 平台部署完成**：需要先部署 Agent-insight 平台并正常运行
2. **待优化的 Skill**：已有一个可执行的 Skill 存在于本地 `.opencode/skills/` 目录下
3. **测试任务**：准备好用于测试 Skill 效果的任务描述
4. **评测模型配置**：平台已配置评测模型（用于评估优化效果）
5. **opencode 环境**：已安装并配置好 opencode 工具
6. **基础模型调用权限**：配置好用于执行优化任务的模型（如 deepseek/deepseek-chat）

## 快速开始

### 方式一：通过 opencode 直接触发

最简单的方式是直接告诉 opencode 您的优化需求。iterative-optimizer skill 会自动识别「迭代优化」、「自动优化 skill」、「循环优化」、「多轮优化」等关键词，引导您完成后续流程：

```
帮我迭代优化 /user/work/.opencode/skills/openeuler-docker-fault 这个 skill，目标是准确率达到 0.9 以上，最多跑 5 轮
```

系统会自动：

1. 解析您的需求，提取 Skill 路径、优化目标、最大轮数等信息
2. 引导您补充缺失的配置信息（如测试任务描述）
3. 自动执行迭代优化循环
4. 输出优化报告

### 方式二：手动配置后触发

如果您需要更精细的控制，可以先创建配置文件，然后触发优化流程：

1. 复制配置模板到工作目录，命名为 `iter-config.yaml`
2. 填写配置文件
3. 告诉 opencode 开始优化：`帮我迭代优化 <skill 路径>`

## 配置文件详解

### 配置文件模板

以下是完整的配置文件结构（`iter-config.yaml`）：

```yaml
# ============================================================================
# 迭代优化任务配置
# ============================================================================

# 测试框架（当前仅支持 opencode）
framework: opencode

# 待优化的 skill 信息
skill:
  name: <你的 skill 名称>
  path: <你的 skill 目录路径，如 /path/to/skills/my-skill>

# 迭代参数
optimization:
  score_threshold: 0.9
  goal: <可选，优化目标的文字描述>
  max_rounds: 5

# 默认模型（可选）
# model: deepseek/deepseek-chat

# 故障注入（可选）
# fault_injection:
#   inject: <故障注入命令>
#   cleanup: <故障停止命令>

# 任务定义
tasks:
  query: |
    <你的测试任务描述>

# 交互预设（可选）
# interactions:
#   - scenario: <场景描述>
#     trigger: <关键词|用竖线分隔多个>
#     response: <预设回答>
```

### 配置项说明

| 配置项                            | 必填 | 说明                    | 示例值                                                  |
| ------------------------------ | -- | --------------------- | ---------------------------------------------------- |
| `framework`                    | 是  | 测试框架，当前仅支持 `opencode` | `opencode`                                           |
| `skill.name`                   | 是  | 待优化的 Skill 名称         | `openeuler-docker-fault`                             |
| `skill.path`                   | 是  | Skill 的完整目录路径         | `/user/work/.opencode/skills/openeuler-docker-fault` |
| `optimization.score_threshold` | 是  | 达标分数阈值，0\~1 之间的小数     | `0.9`                                                |
| `optimization.goal`            | 否  | 优化目标的文字描述，仅供参考        | `提升故障排查准确率`                                          |
| `optimization.max_rounds`      | 是  | 最大优化轮数                | `5`                                                  |
| `model`                        | 否  | 使用的模型名称，配置后跳过模型选择     | `deepseek/deepseek-chat`                             |
| `fault_injection.inject`       | 否  | 每轮测试前注入故障的命令          | `docker stop container`                              |
| `fault_injection.cleanup`      | 否  | 每轮测试后清理恢复的命令          | `docker start container`                             |
| `tasks.query`                  | 是  | 测试任务的详细描述             | `请排查容器无法启动的问题`                                       |
| `interactions`                 | 否  | 预设交互场景列表              | 见下文                                                  |

### 交互预设配置

如果测试任务涉及多轮交互，可以配置交互预设。系统会在执行过程中自动匹配关键词并回复预设内容，减少人工干预。

```yaml
interactions:
  - scenario: 用户确认继续
    trigger: 是否继续|是否确认
    response: 确认继续
  - scenario: 提供错误日志路径
    trigger: 日志路径|错误日志
    response: /var/log/error.log
```

- `scenario`：场景描述，便于理解
- `trigger`：触发关键词，多个用竖线分隔
- `response`：预设的回答内容

### 配置示例

#### 示例一：基础故障排查优化

此示例展示如何配置一个基础的故障排查 Skill 优化任务。

```yaml
framework: opencode

skill:
  name: openeuler-docker-fault
  path: /user/work/.opencode/skills/openeuler-docker-fault

optimization:
  score_threshold: 0.9
  goal: 提升 Docker 故障排查 Skill 的准确率
  max_rounds: 5

tasks:
  query: |
    排查并解决容器无法启动的问题，容器名称为 test-container
```

#### 示例二：带故障注入的优化

此示例展示如何在测试过程中注入故障，用于测试 Skill 在特定故障场景下的表现。

```yaml
framework: opencode

skill:
  name: openeuler-network-fault
  path: /user/work/.opencode/skills/openeuler-network-fault

optimization:
  score_threshold: 0.85
  goal: 提升网络故障排查能力
  max_rounds: 3

fault_injection:
  inject: docker stop web-service
  cleanup: docker start web-service

tasks:
  query: |
    排查 Web 服务无法访问的问题
```

#### 示例三：带交互预设的优化

此示例展示如何配置交互预设，使自动化流程能够处理常见的交互场景。

```yaml
framework: opencode

skill:
  name: my-custom-skill
  path: /user/work/.opencode/skills/my-custom-skill

optimization:
  score_threshold: 0.9
  max_rounds: 5

tasks:
  query: |
    执行数据备份任务到指定路径

interactions:
  - scenario: 确认备份路径
    trigger: 备份路径|目标路径
    response: /backup/data
  - scenario: 确认覆盖
    trigger: 是否覆盖|确认覆盖
    response: 确认覆盖
```

## 使用流程

### 完整优化流程

iterative-optimizer 会自动执行以下步骤的循环。整个流程由 skill 编排执行，用户只需提供初始配置和任务描述。

![alt text](<images/interative-optimizer workflow.png>)

### 各步骤详解

#### 步骤 1：初始化工作空间

当您触发优化任务后，系统会执行以下初始化操作。首先解析配置文件（如存在），然后创建日志目录结构，最后收集缺失的配置信息。

如果未提供配置文件，iterative-optimizer 会引导您逐步提供以下信息：

- Skill 路径（待优化的 Skill 所在目录）
- 测试任务描述（用于评估 Skill 效果的任务）
- 达标分数阈值（0\~1 之间，如 0.9 表示 90%）
- 最大优化轮数（如 5 轮）
- 使用的模型（如 deepseek/deepseek-chat）

#### 步骤 2：执行测试任务

系统会自动完成以下操作。首先备份当前版本的 Skill 到日志目录，然后将 Skill 上传到 Agent-insight 平台，接着使用配置的模型执行测试任务，最后收集执行结果用于评估。

这个过程通过 `oc_run.sh` 脚本执行，它会封装 opencode run 的流式 JSON 输出，过滤出关键内容供 skill 判断。

> **注意**：测试任务的 query 必须严格使用配置文件中定义的内容，不要修改。系统会自动在 query 前面添加提示，确保执行过程不调用 question 工具。

#### 步骤 3：评估结果

执行完成后，系统会通过 `evaluate_result.sh` 脚本轮询 Agent-insight API 获取评分。该脚本每 30 秒轮询一次，最多轮询 20 次（10 分钟），等待评测结果生成。

评估结果分为三种情况：

| 状态  | 退出码 | 条件                     | 后续操作   |
| --- | --- | ---------------------- | ------ |
| 达标  | 0   | 得分 >= score\_threshold | 结束优化循环 |
| 未达标 | 1   | 得分 < score\_threshold  | 继续优化   |
| 错误  | 2   | 评估过程出错                 | 需用户介入  |

#### 步骤 4：优化 Skill

如果评估结果为未达标，系统会使用 skill-optimizer 技能基于执行结果生成优化建议，然后自动应用这些建议更新 Skill 文件。由于在步骤 2 中已备份了当前版本，优化效果不佳时可以回滚。

#### 步骤 5：循环或结束

系统会根据以下条件决定是否继续循环。当达成任一条件时，优化流程结束。

| 终止条件   | 说明           |
| ------ | ------------ |
| 达成目标   | 准确率达到设定的阈值   |
| 达到最大轮数 | 已完成设定的最大优化轮数 |
| 用户手动终止 | 用户主动停止优化过程   |

优化完成后，系统会输出完整的迭代优化报告。

## 优化报告解读

优化完成后，您将收到一份详细的优化报告，包含每轮执行的详细信息和最终结果。

```
========================================
迭代优化报告
========================================
Skill 名称:     openeuler-docker-fault
Skill 原始路径: /user/work/.opencode/skills/openeuler-docker-fault
优化目标:       准确率达到 0.9 以上
使用模型:       deepseek/deepseek-chat
终止原因:       达成优化目标

----------------------------------------
各轮次详情:
----------------------------------------
第 1 轮:
  使用 Skill 版本:  ./iteration-logs/round-1/skill-snapshot/
  执行得分:        0.62
  达标:            否
  评判摘要:        排查步骤缺少 cgroup 限制检查

第 2 轮:
  使用 Skill 版本:  ./iteration-logs/round-2/skill-snapshot/
  执行得分:        0.85
  达标:            否
  评判摘要:        缺少网络 namespace 排查

第 3 轮:
  使用 Skill 版本:  ./iteration-logs/round-3/skill-snapshot/
  执行得分:        0.93
  达标:            是
  评判摘要:        覆盖率达标，报告结构清晰

----------------------------------------
得分趋势:  0.62 → 0.85 → 0.93
----------------------------------------
最终生效 Skill:  /user/work/.opencode/skills/openeuler-docker-fault
历史版本保留在:  ./iteration-logs/round-N/skill-snapshot/ 目录下
完整日志:        ./iteration-logs/
========================================
```

### 报告字段说明

| 字段         | 说明                   |
| ---------- | -------------------- |
| Skill 名称   | 待优化的 Skill 名称        |
| Skill 原始路径 | 原始 Skill 的目录路径       |
| 优化目标       | 设定的优化目标描述            |
| 使用模型       | 执行优化任务使用的模型          |
| 终止原因       | 优化结束的原因（达成目标/达到最大轮数） |
| 各轮次详情      | 每轮执行的详细信息            |
| 执行得分       | 该轮执行后的评测得分           |
| 评判摘要       | 评测模型的评判理由            |
| 得分趋势       | 得分变化趋势，展示优化效果        |
| 历史版本       | 各轮次 Skill 备份的存储位置    |
| 完整日志       | 所有执行日志的存储位置          |

## 版本管理与回滚

### 版本备份机制

每一轮优化前，系统会自动备份当前版本的 Skill。这一机制确保在优化效果不佳时能够回滚到之前的状态。

- **备份位置**：`iteration-logs/round-N/skill-snapshot/`
- **备份内容**：完整的 Skill 目录（包括 SKILL.md、scripts、references 等所有文件）

### 回滚操作

如果某个优化轮次的效果不佳，可以回滚到指定版本。回滚操作需要手动执行以下步骤：

1. 找到目标轮次的备份目录（如 `round-2/skill-snapshot/`）
2. 将备份内容复制回原始 Skill 目录
3. 如需上传到平台，使用 skill-sync 同步

```bash
# 示例：回滚到第 2 轮版本
cp -r ./iteration-logs/round-2/skill-snapshot/* /user/work/.opencode/skills/openeuler-docker-fault/
```

回滚后，该版本会成为新的基准版本，后续优化将在此基础上继续进行。

## opencode 命令行使用

除了通过自然语言触发，用户也可以直接使用 opencode 命令来执行迭代优化。

### 单轮优化

对单个 Skill 执行一次优化：

```bash
/si-optimizer <skill-path>
```

例如：

```bash
/si-optimizer /user/work/.opencode/skills/openeuler-docker-fault
```

### 自动多轮优化

使用 iterative-optimizer skill 进行多轮迭代优化，需要先配置 `iter-config.yaml` 文件，配置完成后：

```bash
/si-optimizer
```

## 脚本工具说明

iterative-optimizer skill 提供了以下脚本工具：

| 脚本                   | 功能                           | 需要模型？          |
| -------------------- | ---------------------------- | -------------- |
| `oc_run.sh`          | opencode run 封装，处理流式 JSON 输出 | 否（但返回内容需要模型判断） |
| `init_workspace.sh`  | 解析配置、创建日志目录                  | 否              |
| `update_round.sh`    | 递增轮次计数                       | 否              |
| `snapshot_skill.sh`  | 备份当前版本 Skill                 | 否              |
| `fault_inject.sh`    | 故障注入/清理                      | 否              |
| `evaluate_result.sh` | 轮询 API 获取评分                  | 否              |
| `parse_config.py`    | 解析配置文件                       | 否              |

所有脚本位于本 skill 的 `scripts/` 目录下。

## 常见问题

### Q1：优化过程中可以中断吗？

可以。您可以随时手动终止优化过程。已完成的轮次结果会被保留，您可以在中断点继续或回滚。

### Q2：优化效果不佳怎么办？

如果优化效果未达到预期，可以尝试以下方法。首先检查测试任务，确保测试任务能够充分验证 Skill 能力。其次调整阈值，适当降低达标分数阈值。再次增加轮数，增加最大优化轮数。最后手动干预，在优化过程中介入，调整优化策略。

### Q3：评估结果显示超时怎么办？

评估过程默认轮询 10 分钟（30 秒间隔，最多 20 次）。如果超时，请检查 Agent-insight 平台是否正常运行，网络连接是否正常。您也可以手动查看平台上的评测结果。

### Q4：如何查看详细的执行日志？

每轮执行的所有日志都保存在 `iteration-logs/` 目录下：

- `round-N/execution.log` - 测试任务执行日志
- `round-N/optimization.log` - Skill 优化日志
- `round-N/sync-upload.log` - Skill 上传日志
- `round-N/fault-inject.log` - 故障注入日志（如果配置了故障注入）
- `round-N/fault-cleanup.log` - 故障清理日志

### Q5：不同轮次的得分可以对比吗？

可以。优化报告中的「得分趋势」展示了各轮次的得分变化，您可以据此分析优化效果。此外，您也可以比较不同轮次的 Skill 版本，分析具体变更内容。

### Q6：优化过程中需要人工介入吗？

默认情况下不需要。系统会自动执行完整的迭代优化流程。但如果您配置了交互预设，系统会根据预设自动处理交互。如遇到预设未覆盖的情况，系统会暂停并等待您的回复。

### Q7：当前支持哪些测试框架？

当前仅支持 opencode 框架。将来可能会扩展支持其他框架。
