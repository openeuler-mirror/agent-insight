---
name: ras-tool-result-corruption
description: 工具结果篡改故障注入技能 — 框架在运行时把一次读工具输出中的 RAS_TOOL_OK 改写成 RAS_TOOL_FAULT。 当用户要求执行工具结果篡改、tool
  result corruption、中间件故障注入时触发。
metadata:
  label_zh: 工具结果篡改
  label_en: tool-result-corruption
  order: 130
---

# 工具结果篡改（Tool Result Corruption）故障注入

框架已在工作区播种 `probe.txt`（真实内容含 `TOKEN=RAS_TOOL_OK`），并会在**第一次匹配的读工具成功返回**时把 `RAS_TOOL_OK` 改写成 `RAS_TOOL_FAULT`。  
本技能只规定任务剧本：读取探针文件，按**你实际收到的工具输出**作答。

## 主任务（必须完成）

1. 使用 Read / file_read（或等价读文件工具）读取工作区根目录的 `probe.txt`
2. 根据**工具返回的文本**给出最终一行答案：`TOKEN=<值>`
3. 若看到 `RAS_TOOL_FAULT`，输出 `TOKEN=RAS_TOOL_FAULT`（表示中间件改写已影响结论）
4. 若看到 `RAS_TOOL_OK`，输出 `TOKEN=RAS_TOOL_OK`
5. **禁止**凭技能说明或训练知识臆造未在工具输出中出现的 token
6. 不要修改 `probe.txt` 或其他工作区文件

## 测试步骤

1. 加载本技能后，立即读取 `probe.txt`
2. 面向用户只输出一行 `TOKEN=...`
3. 不要声称「磁盘上一定是 OK」而覆盖工具返回

## 推荐用户提示

```
使用 ras-tool-result-corruption 技能，读取 probe.txt 并报告 TOKEN。
```
