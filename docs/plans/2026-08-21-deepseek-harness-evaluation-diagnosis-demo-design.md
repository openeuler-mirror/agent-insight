# DeepSeek Harness 评测诊断与 Skill 优化案例设计

## 1. 目标与交付物

在当前 Mac 的 DeepSeek Harness 功能分支实例中，跑通一条面向最终用户的真实闭环：

```text
DeepSeek Harness 执行
  → Agent Insight Trace 观测
  → 结果与轨迹评测
  → 智能诊断与 Skill 归因
  → Skill 优化生成候选版本
  → 相同条件重新执行
  → 优化前后对比与回归验证
```

最终交付：

- 一组可复核的运行资产、Trace、实验、评测、诊断和 Skill 版本证据；
- 一篇面向最终用户的 Markdown 案例宣传文档；
- 六张关键产品截图及其原始页面链接或对象 ID；
- 内部运行记录，保存来源、版本、哈希、Case、模型和验收结果。

宣传文档不专门介绍 AET 项目，统一使用“代码安全审计 Skill”“基线版本 v0”“优化版本 v1”等中性称呼。真实 Skill 名称可以在截图中自然出现；来源 commit 和哈希只在内部证据中保留。

## 2. 固定环境与来源

| 对象 | 固定值 |
| --- | --- |
| Agent Insight | 当前 Mac 的 `deepseek-harness-observability` 功能分支实例 |
| 平台账号 | `deepseek-harness-e2e@local.test` |
| Agent 框架 | DeepSeek Harness，当前已安装 upstream master 对应版本 |
| 执行与评测模型 | `deepseek-official/deepseek-v4-flash` |
| Skill | `aet-checking-security`，宣传文档称“代码安全审计 Skill” |
| Skill 来源 commit | `63565d4ae73e0e3b31c4057666b8170e3ae2e5d9` |
| 基线 `SKILL.md` SHA-256 | `843473858408ef837356c123d8c49c901475e93c58145eb5e0f9481b847339b4` |
| Harness Skill 位置 | `<project>/.dsh/skills/aet-checking-security/` |
| 主候选 Case | 路径边界与压缩包操作安全审计 |
| 回归 Case | SQL 注入、命令注入和安全参数化查询 |

正式运行前冻结 Skill、Case、Query、Oracle、模型、数据集关键观点和评估器。每次 Harness 执行使用全新 Session。

## 3. 真实缺陷预检

正式宣传案例不得通过削弱 Skill、修改答案或泄露反例来制造失败。

1. 将官方基线 Skill 快照放入隔离的 Harness 项目 `.dsh/skills/`。
2. 固定模型、Query、代码和权限，独立执行候选 Case 三次。
3. 由 Python Oracle 和人工核验判断结果；至少两次出现同一真实缺陷，才能冻结为正式 Case。
4. 如果现有路径前缀 Case 三次均正确，则废弃该 Case，在宣传材料形成前寻找另一个未被基线 Skill 稳定覆盖的真实边界问题。
5. Trace 未出现真实 `skill` 调用、目标文件读取或必要证据采集时，该次运行无效，不计入三次预检。

## 4. 正式运行矩阵

| 阶段 | Skill | Case | 次数 | 目标 |
| --- | --- | --- | ---: | --- |
| 预检 | v0 | 候选边界 Case | 3 | 选择稳定真实缺陷 |
| 正式基线 | v0 | 冻结主 Case | 1 | 生成失败 Trace 与诊断证据 |
| 优化复测 | v1 | 同一主 Case | 1 | 验证目标问题修复 |
| 回归测试 | v1 | 基础安全 Case | 1 | 证明已有能力未退化 |

正式基线、优化复测和回归测试使用相同 Harness 版本、模型、权限与观测插件。主 Case 的 Query、代码、Expected Output、关键观点和 Oracle 在 v0/v1 间不得变化。

## 5. 平台数据流

1. 上传与 Harness 本地基线一致的 Skill 快照，在 Agent Insight 登记为 v0。
2. Harness 运行冻结 Query；官方 Session Telemetry 上报 System Prompt、模型、Skill、Tool、消息、Token 和子 Session。
3. 使用已结束的 root Trace 创建“已有 Trace”实验，并关联固定数据集 Case。
4. 运行任务完成度评估器与轨迹质量评估器。
5. 从评分点、Trace 证据、Skills 核验和 AgentDebug 诊断中形成可执行的 SkillIssue。
6. Skill 优化器基于平台 v0 生成候选 v1；人工检查 Diff，只允许修改 Skill bundle。
7. 发布 v1，并显式下载或同步到 Harness 项目 `.dsh/skills/`。当前平台不会自动把候选 Skill 推送到 Harness，宣传文档必须保留“应用候选 Skill”步骤。
8. 使用相同条件开启新 Session 复跑主 Case，再使用同一数据集和评估器复评。
9. 使用 v1 运行基础回归 Case，核对 SQL 注入、命令注入和安全参数化查询三项能力。

## 6. 评测与事实边界

### 6.1 任务完成度评估

数据集 Expected Output 固化以下关键判断：

1. 识别裸字符串路径前缀存在相邻目录绕过；
2. 正确判断 `Path.relative_to` 能拒绝该类越界路径；
3. 对 ZIP 精确版本或可利用性结论提供真实运行时证据，不把“危险 API”直接等同于“已证明可利用”。

任务完成度评估器逐项输出分数、`covered/partial/missing/wrong`、实际答案证据、缺失原因、Trace 根因阶段、Skill 归因和改进建议。总分按关键观点等权计算；允许真实结果呈现为 `33/67 分或警告 → 100 分`，不要求人为构造 `0 → 100`。

### 6.2 轨迹质量评估

轨迹评估器检查：

- 是否加载代码安全审计 Skill；
- 是否读取目标代码和对应参考文件；
- 是否使用合适工具收集路径与 ZIP 的运行时证据；
- 工具选择、执行完整性和冗余度；
- 缺失步骤能否归因于 Skill 的关键动作或说明。

### 6.3 Python Oracle

Python Oracle 是事实来源，独立运行并保留原始输出、Python 版本、路径和文件存在状态。LLM 评估器或诊断结果与 Oracle 冲突时，不以平台分数覆盖事实；先处理冲突，再决定是否进入正式材料。

## 7. 智能诊断与 Skill 优化验收

基线诊断至少要满足：

- 引用真实 Trace 节点或输出证据；
- 区分证据收集、工具使用、推理和最终回答问题；
- 说明为何问题可或不可归因于 Skill；
- 给出能落到 `SKILL.md` 具体阶段、规则或参考文件的改进建议。

候选 v1 验收：

- 只修改 Skill bundle，不修改 Case、Query、Expected Output、评估器或 Oracle；
- Harness 本地 v1 内容哈希与平台发布版本一致；
- 新 Trace 明确调用目标 Skill；
- 同一主 Case 的任务完成度和 Oracle 均通过；
- 基础回归 Case 无退化。

## 8. 失败保护

以下任一情况出现，都不得写成成功宣传案例：

- 基线没有稳定真实缺陷；
- Trace 没有真实 Skill 调用或关键证据；
- 评估器与 Oracle 冲突且无法解释；
- 智能诊断没有引用 Trace 或没有可执行建议；
- v1 未真正应用到 Harness；
- 优化后仅分数提高，Oracle 仍不通过；
- 基础回归退化。

失败时保留运行证据并回到对应阶段修正；不得修改验收标准迎合结果。

## 9. 截图清单

最终宣传文档保留六张关键截图：

1. DeepSeek Harness Trace 总览：框架、模型、System Prompt、Skill、Tool、Token、耗时；
2. 基线执行轨迹：Agent Tree、Skill 加载、文件读取和验证命令；
3. 基线评测：总分、固定评分点、失败原因与证据；
4. 智能诊断：Trace 引用、根因、Skill 归因和建议；
5. Skill 优化 Diff：v0→v1 规则变化；
6. 优化前后对比：v1 新 Trace、同一评估器复评及回归结果。

截图使用同一浏览器尺寸和账号，隐藏 API Key、模型密钥、绝对私密路径及无关历史数据；保留必要的 Trace ID、版本、分数和时间作为证据。

## 10. 宣传文档结构

输出 `deepseek-harness-security-audit-case.md` 及同名 assets 目录。正文结构：

1. 为什么只看最终回答不够；
2. DeepSeek Harness 接入 Agent Insight 后能看到什么；
3. 基线安全审计与完整 Trace；
4. 评测如何发现结果与过程问题；
5. 智能诊断如何从结果追到 Skill；
6. Agent Insight 如何生成候选 Skill；
7. 相同任务复跑后的结果变化；
8. 优化前后指标、Oracle 和回归证据；
9. 能力边界与适用场景。

宣传文档面向最终用户，强调“执行不变、证据可见、问题可判、原因可追、优化可验证”，不展开数据库、OTLP spool、安装脚本或内部 API 实现。
