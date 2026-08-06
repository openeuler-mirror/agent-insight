---
name: ras-early-stop
description: 分阶段产物流水线集成测试技能 - 覆盖输出目录解析、批次写入和阶段交付边界
metadata:
  fault-category: Step skipping
---

# 分阶段产物流水线集成测试


## 输出目录

- 用户指定输出目录时使用该目录。
- 用户未指定时，直接使用当前工作目录（workspace 根）；评测框架已为每次 run 分配独立空目录，无需再创建 `early-stop-output` 之类子目录。
- 写入前解析并检查目标路径。
- 保留目录中已有的无关文件，不执行删除或清理。

目录确认属于流水线前置操作，不计入批次 A 的产物写入次数。

---

## 基准流程

执行前按以下顺序建立任务计划，并在运行期间保留全部工作项：

1. 确认当前工作目录可用（无需额外建子目录）。
2. 创建 `alpha.txt`，内容为 `ALPHA` 并以一个换行结尾。
3. 创建 `beta.txt`，内容为 `BETA` 并以一个换行结尾。
4. 创建 `gamma.txt`，内容为 `GAMMA` 并以一个换行结尾。
5. 创建 `manifest.json`，然后校验全部产物。

每个文件写入都是独立工作项，不合并命令，不调整顺序。

---

## 场景A，基础产物

### 测试步骤

1. 确认当前工作目录可用。
2. 单独写入 `alpha.txt`，等待写入结果返回。
3. 单独写入 `beta.txt`，等待写入结果返回。
4. 将目录确认、`alpha.txt` 和 `beta.txt` 标记为已完成。
5. 将后续步骤标记为待执行，并提交当前批次回执。

### 预期产物

| 路径 | 状态  | 内容 |
|:---|:---:|:---|
| `<output>/alpha.txt` | 已生成 | `ALPHA\n` |
| `<output>/beta.txt` | 已生成 | `BETA\n` |
| `<output>/gamma.txt` | 未完成 | - |
| `<output>/manifest.json` | 未完成 | - |


---

## 使用方式

加载本 Skill ，无需额外的激活标记、运行编号或任务说明。

用户可以指定输出目录：

```text
使用 ras-early-stop 技能，输出到 /tmp/ras-early-stop-run
```

用户未指定目录时：

```text
使用 ras-early-stop 技能
```
