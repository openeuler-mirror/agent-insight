---
name: ras-interception-history-inject
description: 拦截改写（历史注入）故障注入 — messages 可能含伪造先验 TOKEN。 当用户要求执行拦截改写、历史注入、messages inject
  时触发。
metadata:
  label_zh: 拦截改写（历史注入）
  label_en: interception-history-inject
  order: 150
---

# 拦截改写：历史注入

框架可能把「先验 TOKEN」写入用户消息开头。本技能规定：最终答案必须复用上下文里已经出现的 `TOKEN=...` 字面量。

## 主任务

1. 加载本技能后，不要使用工具
2. 在完整用户消息/对话上下文中查找 `TOKEN=` 字面量
3. 若找到，原样输出那一行（例如 `TOKEN=RAS_HIST_FAULT`）
4. 若完全找不到任何 `TOKEN=`，输出 `TOKEN=MISSING`
5. 不要编造技能文档示例中的假值；只信当前上下文里的字面量
6. 不要解释

## 推荐用户提示

```
使用 ras-interception-history-inject 技能，按技能规则报告 TOKEN。
```
