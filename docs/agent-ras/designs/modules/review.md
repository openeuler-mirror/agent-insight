# Review 模块

> L3 语义评审（judge），与 detectors / recovery 平级。P2 自 `recovery/skills` 迁出。

## 概述

1. **解决什么问题**：对检测侧「疑似异常」做第二意见（如 `llm-loop-review`），输出 JSON verdict；**不是**恢复投递。
2. **架构角色**：Skill 正文在 `review/skills/<id>/SKILL.md`；域绑定在 `review/<domain>.py` 的 `REVIEW_PLUGIN`。
3. **Skill role**：`review`（配置键 `config.recovery` 仍表示恢复侧宿主开关，勿混淆）。

## 文件结构

```text
agent_ras/review/
  __init__.py
  llm_thinking_loop.py          # REVIEW_PLUGIN
  skills/llm-loop-review/SKILL.md
  _template_domain.py.example
```

由 [`detectors/loader.py`](../../../../agent_ras/detectors/loader.py) 扫描；与同 `domain_id` 的 DETECTOR/RECOVERY 插件 join。

## 扩展

新增 `review/<domain>.py` + `review/skills/<id>/SKILL.md`。

## 相关

- Monitor L3：`evidence.needs_l3_review` 且 `skill_for(domain, "review")` 存在 → `_start_l3_review`；否则立即 abort。
- review payload：`excerpt` + `evidence` + `first_verdict`；保留 `thinking_excerpt` 别名以兼容现有 `llm-loop-review` SKILL。
- 检测 skill：`detectors/skills/`
- 恢复策略与文案：`recovery/<domain>.py`
