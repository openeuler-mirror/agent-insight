# RAS 消息路径与模块化

> 真源补充：与 [`ras_architecture.md`](ras_architecture.md)、[`capability_matrix.md`](capability_matrix.md) 配套。  
> 记录环内消息 ↔ Insight 前端的边界、现行 ingest 契约（breaking），以及多平台观测出口目标。

## 1. 分层判定

OpenCode inproc 旁路路径分层**合格**（依赖单向 `L3 → L2 → L1 → L0`，Insight 只消费落库事件）：

| 层 | 职责 |
|----|------|
| L3 `platform_adapter/{platform}` | 宿主钩子、HostControl（abort / notice / steer）、产出 `trace_anchor` / `delivery_anchor` |
| L2 `platform_adapter/common` | `ras_client` + `applyActions`（wire → Host） |
| L1 `ras_embed` | SessionHub、检测调度、`insight_push` |
| L0 `core` | Detectors / Recovery（平台无关） |
| Insight | `POST/GET /api/ingest/ras-events` → markers → `AgentTraceView` |

**不引入** EventBus / Mediator / 新 DI 框架。已有 Adapter + Facade + Wire 足够。

模块化缺口是**双宿主栈**：OpenCode 经 `insight_push` 落库；openjiuwen 深挂载 Monitor 但历史上未统一旁路出口（见能力矩阵与 Phase B）。

## 2. 现行 ingest 契约（breaking）

唯一真源路径与载荷（与 `ras_embed/insight_push.py` 对齐）：

- **URL**：仅 `POST /api/ingest/ras-events`（已删除 `/api/ingest/ras/v1/events`、`/api/ras/v1/events` rewrite）
- **Body**：flat JSON，单条或 `{ "events": [ ... ] }`
- **必填**：`taskId`、`type`、`deliveryId`（UUID；缺则 400）
- **常用**：`framework` / `anomalyKind` / `severity` / `summary` / `actionTypes` / `payload`
- **幂等**：仅 `(taskId, deliveryId)` upsert
- **已移除**：`rasEventId`、`witty.*` 属性别名、无键 create、legacy fingerprint 去重、正文匹配投递兜底

投递关联：UI **只认** `payload.delivery_anchor.message_id`；无 anchor 时保持 USER，禁止文案启发式猜 RAS。

## 3. Host 交付契约（摘要）

完整字段表见 [`../contracts/host_delivery_anchors.md`](../contracts/host_delivery_anchors.md)。

- `trace_anchor`：检测点（`message_id` / `part_id` / `call_id` / `channel`）
- `delivery_anchor`：notice/steering 投递点（`message_id` 必填；`part_id` 可选；`channel` = `ras_notice` | `ras_steering`）

## 4. 多平台目标

```text
各平台 L3 Host →（wire）→ 同一 insight_push → ras-events → 平台无关 UI
```

能力深度仍以 [`capability_matrix.md`](capability_matrix.md) 为准；不得在 core 复制平台 SDK。
