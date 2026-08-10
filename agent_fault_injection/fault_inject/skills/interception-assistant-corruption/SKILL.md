---
name: ras-interception-assistant-corruption
description: 拦截改写（助手文本篡改）故障注入 — 框架在模型返回后改写 TOKEN。 当用户要求执行助手结果篡改、assistant corruption、拦截改写输出时触发。
metadata:
  label_zh: 拦截改写（助手文本）
  label_en: interception-assistant-corruption
  order: 160
---

# 拦截改写：助手文本篡改

框架会在助手文本返回后，把 `RAS_ASSIST_OK` 改写成 `RAS_ASSIST_FAULT`。本技能要求模型**原文输出** OK token，以便观测中间件是否改写了对外可见结果。

## 主任务

1. 加载本技能后，不要使用工具
2. 面向用户只输出一行：`TOKEN=RAS_ASSIST_OK`
3. 不要输出 FAULT 变体

## 推荐用户提示

```
使用 ras-interception-assistant-corruption 技能，按技能正文报告 TOKEN。
```
