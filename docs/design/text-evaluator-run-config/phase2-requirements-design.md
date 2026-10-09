# 文本评估器运行配置：需求设计

## 1. 交互设计

在“新建实验 → 选择评估器”步骤中：

- 可配置的评估器卡片显示“配置”按钮和当前配置摘要；
- 点击未选中的卡片配置按钮时，同时选中该评估器；
- 弹窗使用分组开关和匹配模式选择器，底部提供“恢复默认”“取消”“保存配置”；
- 弹窗明确提示配置应用于该实验的全部 Case；
- 切换到“仅监测”模式时不提交评估器配置。

实验总览的评估器分解区和 Case 详情卡片显示简短配置摘要，便于验收时确认实际执行条件。

## 2. 数据契约

`Experiment` 新增：

```prisma
evaluatorConfigsJson String @default("{}")
```

数据库中采用带版本的 JSON：

```json
{
  "schemaVersion": 1,
  "configs": {
    "preset-text-exact-match": {
      "caseSensitive": false,
      "punctuationInsensitive": true,
      "whitespaceNormalization": true,
      "widthNormalization": true,
      "multiCandidateScoring": "any"
    },
    "preset-text-entity-f1": {
      "matchMode": "fuzzy",
      "fuzzyThreshold": 1,
      "caseSensitive": true,
      "whitespaceNormalization": false,
      "widthNormalization": false
    }
  }
}
```

创建实验接口新增可选请求字段 `evaluatorConfigs`，使用不带版本包装的配置映射。服务端负责白名单校验、填充默认值和序列化。详情接口返回规范化后的 `evaluatorConfigs`。

## 3. 默认值与兼容性

完全精确匹配默认值：区分大小写、不忽略标点、不归一化空白、不归一化全半角、多候选任一命中即满分。

实体 F1 默认值：精确匹配、模糊阈值 `1`、区分大小写、不归一化空白、不归一化全半角。

ROUGE 没有页面配置：纯英文使用词级 token；任一侧含汉字时，两边在 NFKC、小写化并去除空白/标点后统一按 Unicode 字符计算，evidence 标记 `tokenizer: unicode-char(cjk)`。

- `evaluatorConfigsJson` 为空对象时按上述默认值解释。
- 只为实验已选中的、支持配置的评估器保存配置。
- 未知评估器 ID、未知字段、错误枚举值或越界阈值返回 `400`，避免配置被静默忽略。
- Skill 评估复用现有建实验流程，未指定配置时自动得到默认值。

## 4. 执行链路

```text
新建实验页面
  → POST /api/experiments
  → 校验并写入 Experiment.evaluatorConfigsJson
  → ExperimentResult 执行
  → 读取所属 Experiment 配置
  → runTextPreset(id, ctx, config)
  → ExactMatchGrader / F1MatchGrader
  → evidence.reason.config + 百分制结果
```

配置在每个结果行执行时从其所属实验读取，保证重试和异步 worker 使用持久化快照，而不是页面内存状态。

## 5. 安全与性能

- 配置对象只允许布尔值、受限枚举和有界整数，不接受可执行表达式。
- 单个实验配置体积固定且很小，不增加额外网络调用。
- 评估运行通过现有 Case → Experiment 关系一次性读取配置。
