# RAS ingest 契约收紧（兼容层破除）

## 背景

历史 ingest 同时支持深路径 URL、`witty.*` 属性、`rasEventId` 幂等、无 `deliveryId` 写入、以及投递正文匹配兜底。现行推送方仅为 `insight_push`（flat + `deliveryId` → `/api/ingest/ras-events`）。

## 决策

Breaking：只保留现行契约；旧 `RasAnomalyEvent` 数据可清空，不保证历史可靠性时间线回放。

## 变更要点

1. Prisma：`deliveryId` 非空；移除 `rasEventId` 与旧 unique
2. normalize/store：缺 `deliveryId` → 400；仅 `(taskId, deliveryId)` upsert
3. 删除 next.config RAS 深路径 rewrite
4. delivery-link 仅 `delivery_anchor.message_id`
5. 文档与测试同步

详见 [`../../architecture/message_path_modularity.md`](../../architecture/message_path_modularity.md)。
