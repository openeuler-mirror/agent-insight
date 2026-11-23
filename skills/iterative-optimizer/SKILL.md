---
name: iterative-optimizer
description: 自动化迭代优化 skill 的完整流程。当用户希望通过反复执行测试任务、收集结果、优化 skill 来持续提升 skill 质量时，使用此技能。触发场景包括：用户提到"迭代优化"、"自动优化 skill"、"批量测试并改进"、"循环优化"、"多轮优化"等。即使用户只是说"帮我优化这个 skill 的效果"，也应触发此技能。此技能编排了 skill-sync、skill-optimizer 以及测试框架（如 opencode）之间的完整自动化循环。
---

# Iterative Optimizer

你是迭代优化的编排者。你的职责是驱动 skill 的"执行 → 评估 → 优化 → 再执行"循环，直到达成优化目标或达到最大轮次。

以下脚本工具可以自动完成**不需要模型判断**的步骤，你负责**需要理解和判断**的部分。

## 工具清单

所有脚本位于本 skill 的 `scripts/` 目录下。

| 脚本 | 功能 | 需要模型？ |
|------|------|-----------|
| `oc_run.sh` | opencode run 封装，解析 JSON 流，返回纯文本结果 | 否（但返回内容需要你判断） |
| `init_workspace.sh` | 解析配置、创建日志目录、生成 `.iter-state.env` | 否 |
| `update_round.sh` | 递增轮次计数，创建本轮日志目录 | 否 |
| `snapshot_skill.sh` | 备份当前版本 skill 到本轮日志目录 | 否 |
| `fault_inject.sh` | 执行故障注入或故障清理命令 | 否 |
| `evaluate_result.sh` | 调用 Insight API 轮询获取 answer_score，与阈值对比 | 否 |
| `parse_config.py` | 解析 iter-config.yaml，输出摘要或提取单字段 | 否 |

### oc_run.sh 说明

所有 opencode run 调用都通过 `oc_run.sh` 执行，不要直接调用 `opencode run`。

该脚本会：
1. 使用 `opencode run --format json` 执行，获取流式 JSON 输出
2. 过滤出 `type=text` 的文字内容（agent 回复的正文）
3. 检测到 `type=step_finish` 且 `reason=stop` 时结束（表示执行完毕）
4. 忽略 thinking、tool_use 等中间信息
5. 将过滤后的纯文本返回给你阅读和判断
6. 自动在每个 query **前面**添加"不要调用 question 工具"的提示，不修改原始任务内容
7. 默认超时 15 分钟

**新会话执行：**
```bash
bash <skill_dir>/scripts/oc_run.sh \
    --query "<任务内容>" \
    --model "<MODEL>" \
    --log "<日志文件路径>"
```

**继续指定会话（通过 sessionID）：**
```bash
bash <skill_dir>/scripts/oc_run.sh \
    --session "<SESSION_ID>" \
    --query "<回答内容>" \
    --model "<MODEL>" \
    --log "<日志文件路径>"
```

**关于 sessionID：** oc_run.sh 每次执行后，输出的最后一行格式为 `[SESSION_ID] ses_xxxx`。你需要提取这个 sessionID，在后续需要继续同一会话时通过 `--session` 传入。这比 `-c` 模式更稳定，能精准定位到具体的会话。

需要你（模型）参与判断的环节：
- oc_run.sh 返回的文本是"最终回答"还是"在向用户提问"
- 如果是提问，根据交互预设选择回答，用 `--session` 携带 sessionID 继续对话
- 每轮结束后向用户报告进展

## 第一步：引导用户 & 初始化

### 1.1 检查是否已有配置文件

```bash
ls ./iter-config.yaml
```

**如果已存在**：直接跳到 1.5 选择模型。

**如果不存在**：进入 1.2 收集信息。

### 1.2 从用户输入中提取信息

用户的任务通常类似：
> 帮我迭代优化 /user/work/.opencode/skills/openeuler-docker-fault 这个 skill，目标是准确率达到 0.9 以上，最多跑 5 轮

从中提取：
- **skill 路径**：用户给出的完整路径
- **skill 名称**：从路径中取最后一级目录名
- **达标分数**：0~1 之间的小数（如 0.9 表示 90%），填入 `optimization.score_threshold`
- **最大轮次**：如 5

用户给出的路径统一存储为**目录路径**（如果给的是 SKILL.md 文件路径则取父目录）。

### 1.3 补充缺失信息

如果用户还没有提供以下信息，需要追问：

1. **测试框架**：当前仅支持 opencode
2. **测试任务 prompt**：每轮执行的具体任务
3. **达标分数阈值**（`optimization.score_threshold`）：0~1 之间的小数，如 0.9
4. **交互预设**（可选）：执行过程中可能需要的应答信息
5. **故障注入命令**（可选）：测试前注入和测试后清理的命令

不需要追问的（有默认值）：
- **优化任务 prompt**：默认 `请使用 skill-optimizer 技能基于 <SKILL_PATH> 这个 skill 的最近执行记录，动态优化这个 skill`
- **同步任务 prompt**：默认 `请使用 skill-sync 技能将 <SKILL_PATH> 上传到 insight 平台`
- **优化目标描述**（`optimization.goal`）：可选文字描述，不参与达标计算

### 1.4 生成配置文件

收集完后，在用户工作目录下生成 `iter-config.yaml`。

配置文件格式参考 `examples/iter-config-template.yaml` 或 `examples/docker-fault-iter-config.yaml`。

### 1.5 选择模型

先检查 `iter-config.yaml` 中是否已配置 `model` 字段：

```bash
python3 <skill_dir>/scripts/parse_config.py iter-config.yaml --get model
```

- **如果有值**（如 `deepseek/deepseek-chat`）：直接使用，跳过模型选择，进入 1.6。
- **如果为空或不存在**：执行 `opencode models` 获取可用模型列表，展示给用户选择。

记住最终确定的模型名（后续记为 `<MODEL>`）。

### 1.6 初始化工作空间

```bash
bash <skill_dir>/scripts/init_workspace.sh --model "<MODEL>"
```

该脚本会解析配置、创建日志目录、将模型名和所有配置写入 `.iter-state.env` 状态文件。

## 第二步：迭代循环

从 `.iter-state.env` 中读取配置。**你需要在内存中维护一份版本记录表，每轮更新**：

```
版本记录:
| 轮次 | Skill 版本路径                              | 得分 | 达标？ |
|------|---------------------------------------------|------|--------|
|  1   | iteration-logs/round-1/skill-snapshot/...   | 0.62 |  否    |
|  2   | iteration-logs/round-2/skill-snapshot/...   | 0.85 |  否    |
|  3   | <SKILL_PATH>（当前最新）                     | 0.93 |  是    |
```

每轮执行以下步骤：

### 2.0 递增轮次

```bash
ROUND=$(bash <skill_dir>/scripts/update_round.sh)
```

读取 MAX_ROUNDS，如果 ROUND 超出限制则终止循环。

### 2.1 备份当前 Skill

```bash
SNAPSHOT_PATH=$(bash <skill_dir>/scripts/snapshot_skill.sh \
    --skill-path "<SKILL_PATH>" \
    --round-dir "<WORK_DIR>/round-<ROUND>")
```

将 SNAPSHOT_PATH 记入版本记录表。

### 2.2 上传当前 Skill

```bash
bash <skill_dir>/scripts/oc_run.sh \
    --query "<TASK_SYNC>" \
    --model "<MODEL>" \
    --log "<WORK_DIR>/round-<ROUND>/sync-upload.log"
```

阅读返回的文本，如果在等待确认（如"是否上传？"），提取输出末尾的 `[SESSION_ID]`，用 `--session` 回复：

```bash
bash <skill_dir>/scripts/oc_run.sh \
    --session "<上一步返回的 SESSION_ID>" \
    --query "确认上传" \
    --model "<MODEL>" \
    --log "<WORK_DIR>/round-<ROUND>/sync-upload.log"
```

### 2.3 故障注入

```bash
bash <skill_dir>/scripts/fault_inject.sh --config iter-config.yaml --action inject \
    > <WORK_DIR>/round-<ROUND>/fault-inject.log 2>&1
```

未配置 `fault_injection` 时自动跳过。

### 2.4 执行测试任务（需要你判断）

这是你需要深度参与的步骤。

**第一次执行：**

测试任务的 query 必须**严格使用配置文件中 `tasks.query` 的原始内容**。oc_run.sh 会自动在 query 前面添加"不要调用 question 工具"的提示，不会修改你传入的任务内容本身：

```bash
bash <skill_dir>/scripts/oc_run.sh \
    --query "<TASK_EXECUTE>" \
    --model "<MODEL>" \
    --log "<WORK_DIR>/round-<ROUND>/execution.log"
```

**判断 oc_run.sh 返回的文本：**

1. **这是最终回答吗？** 如果内容是完整的分析报告、排查结果、解决方案，本步骤结束。

2. **这是在向用户提问吗？** 如果在询问信息，你需要：
   - 在交互预设中匹配对应条目（通过 trigger 关键词）
   - 用 `--session` 携带上一步返回的 sessionID，回复对应的 response（严格使用交互预设中的原始文字）：
   ```bash
   bash <skill_dir>/scripts/oc_run.sh \
       --session "<上一步返回的 SESSION_ID>" \
       --query "<匹配到的 response>" \
       --model "<MODEL>" \
       --log "<WORK_DIR>/round-<ROUND>/execution.log"
   ```

3. **重复判断**，直到获得最终回答或交互次数超过 10 次。

**判断技巧：**
- 包含明确问句（"请问...？"、"您的...是什么？"）→ 在等交互
- 输出是完整的分析报告或操作步骤列表 → 最终回答
- 拿不准 → 偏向最终回答（避免死循环）

### 2.5 故障清理

测试任务执行完毕后，**无论成功失败**，都必须执行：

```bash
bash <skill_dir>/scripts/fault_inject.sh --config iter-config.yaml --action cleanup \
    > <WORK_DIR>/round-<ROUND>/fault-cleanup.log 2>&1
```

### 2.6 评估结果

```bash
bash <skill_dir>/scripts/evaluate_result.sh \
    --round <ROUND> \
    --skill-name "<SKILL_NAME>" \
    --score-threshold "<SCORE_THRESHOLD>"
```

脚本会以 30 秒间隔轮询 Insight API，最多 20 次（10 分钟），等待评分生成。

**根据退出码判断：**
- 退出码 `0`：达标。记入版本记录表，结束循环。
- 退出码 `1`：未达标或超时无数据。记入版本记录表，继续优化。
- 退出码 `2`：错误。告知用户，由用户决定是否继续。

向用户报告：当前轮次、得分、达标阈值、评判理由。

### 2.7 优化 Skill

```bash
bash <skill_dir>/scripts/oc_run.sh \
    --query "<TASK_OPTIMIZE>" \
    --model "<MODEL>" \
    --log "<WORK_DIR>/round-<ROUND>/optimization.log"
```

阅读返回文本，如果有交互请求则提取 `[SESSION_ID]` 用 `--session` 回复。 执行后会直接修改原始 skill 文件。由于你在 2.1 已备份旧版本，不会丢失。

### 2.8 上传优化后的 Skill

```bash
bash <skill_dir>/scripts/oc_run.sh \
    --query "<TASK_SYNC>" \
    --model "<MODEL>" \
    --log "<WORK_DIR>/round-<ROUND>/sync-optimized.log"
```

阅读返回文本，如果有交互请求则提取 `[SESSION_ID]` 用 `--session` 回复。

### 2.9 回到 2.0

进入下一轮。`opencode run` 每次都是独立进程，自动加载最新 skill。

## 第三步：结束 & 汇报

循环结束后，向用户输出完整的**迭代优化报告**：

```
========================================
迭代优化报告
========================================
Skill 名称:     openeuler-docker-fault
Skill 原始路径:  /user/work/.opencode/skills/openeuler-docker-fault
优化目标:        准确率达到 0.9 以上
使用模型:        qwen-max-latest
终止原因:        达成优化目标 / 达到最大轮次

----------------------------------------
各轮次详情:
----------------------------------------
第 1 轮:
  使用 Skill 版本:  ./iteration-logs/round-1/skill-snapshot/
  执行得分:         0.62
  达标:             否
  评判摘要:         排查步骤缺少 cgroup 限制检查

第 2 轮:
  使用 Skill 版本:  ./iteration-logs/round-2/skill-snapshot/
  执行得分:         0.85
  达标:             否
  评判摘要:         缺少网络 namespace 排查

第 3 轮:
  使用 Skill 版本:  ./iteration-logs/round-3/skill-snapshot/
  执行得分:         0.93
  达标:             是
  评判摘要:         覆盖率达标，报告结构清晰

----------------------------------------
得分趋势:  0.62 → 0.85 → 0.93
----------------------------------------
最终生效 Skill:  /user/work/.opencode/skills/openeuler-docker-fault
历史版本保留在:  ./iteration-logs/round-N/skill-snapshot/ 目录下
完整日志:        ./iteration-logs/
========================================
```

## 注意事项

1. **[最重要] bash 工具超时设置**：你在调用 bash 工具执行 scripts 目录下的任何脚本时，**必须将 bash 工具的超时时间设置为足够长（至少 900 秒 / 15 分钟）**，不要使用默认的 2 分钟超时。这些脚本的执行时间远超 2 分钟：oc_run.sh 单次可能运行 10-15 分钟，evaluate_result.sh 轮询可能持续 10 分钟。如果你的 bash 工具有超时参数，请设为 900 或更大。如果 bash 工具不支持自定义超时，请确保不会在脚本运行过程中主动中断它。

2. **所有脚本一定会返回结果**。每个脚本在任何情况下（成功、失败、超时）都保证向 stdout 输出内容。你只需要等待命令执行完毕、读取返回的输出内容，然后根据内容决定下一步。**不要因为等待时间长就中断、跳过或重试。**

3. **不要直接调用 opencode run**。所有 opencode 调用统一通过 `oc_run.sh` 执行。

4. **测试任务的 query 必须严格保持原样**。`oc_run.sh` 会自动在所有 query 前面（而非后面）添加"不要调用 question 工具"的提示，不会修改你传入的任务内容。你只需确保传给 `--query` 的内容与配置文件一致即可。

5. **所有 oc_run.sh 返回后都必须检查文本内容**。不仅是测试任务，上传、优化等步骤也可能产生交互。交互预设中的条目适用于所有步骤。

6. **超时设置**：oc_run.sh 内部默认 15 分钟超时，如需调整可用 `--timeout` 参数。

7. **版本备份在优化之前**。Step 2.1 必须在 Step 2.7 之前执行。

8. **优化 prompt 要带完整路径**。skill-optimizer 需要知道要操作哪个目录。

9. **评估轮询**：evaluate_result.sh 以 30 秒间隔轮询，最多 20 次（10 分钟）。

10. **容错**：oc_run.sh 或其他脚本失败时不要直接终止，记录错误并告知用户。

11. **透明沟通**：每轮的开始和结束都向用户简要汇报进展。

12. **日志完整性**：oc_run.sh 通过 `--log` 参数自动将原始 JSON 流写入日志文件。
